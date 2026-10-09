import { encrypt, decrypt } from './state.js';
import { createHash } from 'node:crypto';

const BASE = 'https://manage.devcenter.microsoft.com/consumer/insights/v1.1';
const APP = '9NLQRWK76W61';
const REPO = 'afaustov/app-ms-store-reports-runner';
const PATH = process.argv.includes('--status-only') ? 'traffic-status-2026-10-09.enc' : 'traffic-spike-2026-10-09.enc';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let report = { version: 1, files: {}, trafficProbe: { app: APP, startDate: '2026-10-01', endDate: '2026-10-08' } };
let sha;

async function github(method, body, file = PATH) {
  const result = await fetch(`https://api.github.com/repos/${REPO}/contents/${file}${method === 'GET' ? '?ref=state' : ''}`, {
    method, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  if (method === 'GET' && result.status === 404) return null;
  if (!result.ok) throw new Error(`Encrypted checkpoint failed (${result.status}).`);
  return result.json();
}

async function checkpoint() {
  const result = await github('PUT', { message: 'Update encrypted traffic diagnostic', branch: 'state', ...(sha ? { sha } : {}), content: encrypt(report, process.env.STATE_ENCRYPTION_KEY).toString('base64') });
  sha = result.content.sha;
}

async function api(token, route, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${BASE}${route}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45_000) });
    if (!body && response.status === 404 && (route.includes('/execution/') || route.startsWith('/ScheduledQueries?') || route.startsWith('/ScheduledReport?'))) return { value: [] };
    if (!body && [429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await sleep(Math.max(3000, Number(response.headers.get('retry-after') || 3) * 1000)); continue;
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(`Microsoft API HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 4000)}`);
    return payload;
  }
}
const values = (payload) => payload.value || payload.Value || [];

export function csvRows(csv) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && csv[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.replace(/^\uFEFF/, ''));
  return rows.map((fields) => Object.fromEntries(headers.map((h, i) => [h, fields[i] || ''])));
}

async function main() {
  const previous = await github('GET');
  if (previous) { sha = previous.sha; report = decrypt(Buffer.from(previous.content, 'base64'), process.env.STATE_ENCRYPTION_KEY); }
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, resource: 'https://manage.devcenter.microsoft.com' });
  const response = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/token`, { method: 'POST', body, signal: AbortSignal.timeout(30_000) });
  const auth = await response.json();
  if (!response.ok || !auth.access_token) throw new Error('Authentication failed.');
  const token = auth.access_token;
  delete report.trafficProbe.error;
  if (process.argv.includes('--status-only')) {
    const parent = await github('GET', undefined, 'traffic-spike-2026-10-09.enc');
    const primary = decrypt(Buffer.from(parent.content, 'base64'), process.env.STATE_ENCRYPTION_KEY);
    const id = primary.trafficProbe.reportId;
    if (!id) throw new Error('No saved traffic report ID.');
    report.trafficProbe.executionStates = [];
    for (const status of ['Completed', 'Failed', 'Pending']) {
      report.trafficProbe.executionStates.push(...values(await api(token, `/ScheduledReport/execution/${id}?${new URLSearchParams({ executionStatus: status, getLatestExecution: 'true' })}`)));
    }
    // Cross-check the documented synchronous channel endpoint without ordering another report.
    const directParams = new URLSearchParams({ applicationId: APP, startDate: '2026-10-06', endDate: '2026-10-06', aggregationLevel: 'day', groupby: 'channelType,customCampaignId,referrerUriDomain,market,storeClient,deviceType', top: '10000', skip: '0' });
    const directResponse = await fetch(`https://manage.devcenter.microsoft.com/v1.0/my/analytics/appchannelconversions?${directParams}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    report.trafficProbe.directChannels = { status: directResponse.status, data: await directResponse.json() };
    report.trafficProbe.previousDays = [];
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) {
      const params = new URLSearchParams({ applicationId: APP, startDate: date, endDate: date, aggregationLevel: 'day', groupby: 'channelType,customCampaignId,referrerUriDomain,market,storeClient,deviceType', top: '10000', skip: '0' });
      const response = await fetch(`https://manage.devcenter.microsoft.com/v1.0/my/analytics/appchannelconversions?${params}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
      report.trafficProbe.previousDays.push({ date, status: response.status, data: await response.json() });
    }
    report.trafficProbe.status = 'inspected';
    await checkpoint();
    console.log('Existing Microsoft report status inspected; private results encrypted.');
    return;
  }
  const schema = values(await api(token, '/ScheduledDataset')).find((item) => item.datasetName === 'ChannelsAndConversions');
  if (!schema) throw new Error('Traffic dataset absent.');
  report.trafficProbe.schema = schema;
  await checkpoint();
  const columns = [...new Set([...(schema.selectableColumns || []), ...(schema.availableMetrics || [])])];
  const wanted = ['Date', 'ProductId', 'ApplicationId', 'ApplicationName', 'ChannelType', 'CustomCampaignId', 'ReferrerUriDomain', 'StoreClient', 'DeviceType', 'Market', 'ClickCount', 'ConversionCount'];
  const selected = wanted.map((name) => columns.find((column) => column.toLowerCase() === name.toLowerCase())).filter(Boolean);
  report.trafficProbe.selected = selected;
  const query = `SELECT ${selected.join(', ')} FROM ChannelsAndConversions WHERE ProductId IN ('${APP}') TIMESPAN LAST_30_DAYS AGGREGATED Daily`;
  report.trafficProbe.query = query;
  const queryName = `Traffic diagnostic ${createHash('sha256').update(query).digest('hex').slice(0, 12)}`;
  const existing = values(await api(token, `/ScheduledQueries?${new URLSearchParams({ queryName, includeSystemQueries: 'false' })}`)).filter((item) => item.name === queryName);
  if (existing.length > 1) throw new Error('Ambiguous query template.');
  const queryId = existing[0]?.queryId || values(await api(token, '/ScheduledQueries', { name: queryName, description: 'Single-product traffic source diagnostic.', query }))[0]?.queryId;
  if (!queryId) throw new Error('Missing query ID.');
  const reportName = 'Traffic diagnostic 2026-10-09 AI Usage Limits';
  if (!report.trafficProbe.reportId) {
    const saved = values(await api(token, `/ScheduledReport?${new URLSearchParams({ reportName })}`)).filter((item) => (item.reportName || item.ReportName) === reportName);
    if (saved.length > 1) throw new Error('Ambiguous existing report.');
    report.trafficProbe.reportId = saved[0]?.reportId || values(await api(token, '/ScheduledReport', { reportName, description: 'Read-only analytics for October traffic spike.', queryId, executeNow: true, queryStartTime: report.trafficProbe.startDate, queryEndTime: report.trafficProbe.endDate, format: 'csv' }))[0]?.reportId;
    if (!report.trafficProbe.reportId) throw new Error('Missing report ID.');
    await checkpoint();
  }
  console.log('Traffic report checkpointed; private source breakdown requested.');
  const started = Date.now();
  while (Date.now() - started < 28 * 60_000) {
    const executions = values(await api(token, `/ScheduledReport/execution/${report.trafficProbe.reportId}?${new URLSearchParams({ executionStatus: 'Completed', getLatestExecution: 'true' })}`));
    report.trafficProbe.execution = executions;
    const done = executions.find((item) => String(item.executionStatus || item.status).toLowerCase() === 'completed' && item.reportAccessSecureLink);
    if (done) {
      const download = await fetch(done.reportAccessSecureLink, { signal: AbortSignal.timeout(120_000) });
      if (!download.ok) throw new Error('CSV download failed.');
      report.trafficProbe.rows = csvRows(await download.text());
      report.trafficProbe.status = 'complete';
      await checkpoint();
      console.log('Traffic source diagnostic complete. Results stored encrypted; no Telegram delivery.');
      return;
    }
    if (executions.some((item) => /fail/i.test(item.executionStatus || item.status || ''))) throw new Error('Microsoft report execution failed.');
    await sleep(15_000);
  }
  report.trafficProbe.status = 'pending';
  await checkpoint();
  throw new Error('Report remains pending; its ID has been retained.');
}

if (!process.argv.includes('--parse-test')) {
  main().catch(async (error) => {
    report.trafficProbe.error = String(error.message);
    try { await checkpoint(); } catch {}
    console.error('Traffic diagnostic incomplete; details are encrypted.'); process.exitCode = 1;
  });
}
