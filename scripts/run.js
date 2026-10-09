import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collectFiles, restoreFiles, StateStore } from './state.js';

export function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function deliveryDecision(raw, date) {
  if (!raw) return 'run';
  const state = JSON.parse(raw);
  if (state.version !== 1 || !['prepared', 'in_flight', 'sent'].includes(state.status) || !/^\d{4}-\d{2}-\d{2}$/.test(state.deliveryDate)) throw new Error('Invalid delivery state.');
  if (state.deliveryDate > date) throw new Error('Future delivery state.');
  if (state.deliveryDate !== date) return 'run';
  return state.status === 'sent' || state.status === 'in_flight' ? 'skip' : 'run';
}

export async function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-65536); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout || 40 * 60_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Private subprocess could not start.')); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output }); });
  });
}

export async function deliverReport(phase, checkpoint) {
  await phase('prepare');
  await checkpoint();
  await phase('mark-in-flight');
  await checkpoint();
  await phase('send');
  await checkpoint();
}

function privateEnvironment() {
  const env = { ...process.env };
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'STATE_ENCRYPTION_KEY', 'SOURCE_DEPLOY_KEY', 'NODE_OPTIONS', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY', 'GITHUB_PATH']) delete env[name];
  return env;
}

const MS_CREDENTIALS = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_STORE_APP_ID'];
const PROFILES = {
  none: [],
  app: ['MS_STORE_APP_ID'],
  analytics: MS_CREDENTIALS,
  prepare: [...MS_CREDENTIALS, 'NOTION_TOKEN', 'AGENDA_RUNTIME_INCIDENTS_DATA_SOURCE_ID', 'AGENDA_GITHUB_READ_TOKEN'],
  delivery: [...MS_CREDENTIALS, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  publication: ['REVIEW_FEED_DEPLOY_KEY'],
};
const SECRET_VARIABLES = [...new Set(Object.values(PROFILES).flat()), 'GITHUB_TOKEN', 'GH_TOKEN', 'STATE_ENCRYPTION_KEY', 'SOURCE_DEPLOY_KEY', 'NODE_AUTH_TOKEN', 'NPM_TOKEN'];

export function stageEnvironment(profile, parent) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error('Invalid credential profile.');
  const env = { ...parent };
  for (const name of Object.keys(env)) {
    if (SECRET_VARIABLES.includes(name) || name.startsWith('ACTIONS_')) delete env[name];
  }
  for (const name of PROFILES[profile]) if (parent[name] !== undefined) env[name] = parent[name];
  return env;
}

export async function main() {
  const mode = process.env.RUN_MODE;
  if (!['validate', 'validate-reviews', 'daily', 'reviews', 'collect'].includes(mode)) throw new Error('Invalid execution mode.');
  const source = process.env.PRIVATE_SOURCE_REPOSITORY;
  if (!/^[\w-]+\/[\w.-]+$/.test(source || '')) throw new Error('Invalid source repository.');
  const sourceRunId = process.env.MS_STORE_SOURCE_RUN_ID || '';
  if (sourceRunId && !/^\d+-\d+$/.test(sourceRunId)) throw new Error('Invalid source run ID.');
  if (mode === 'validate' && !sourceRunId) throw new Error('Validation requires existing analytics.');
  const store = new StateStore({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, key: process.env.STATE_ENCRYPTION_KEY });
  const state = await store.load();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'private-cloud-job-'));
  const checkout = path.join(temporary, 'source');
  const env = privateEnvironment();
  env.REPORT_TIMEZONE = 'Asia/Singapore';
  env.REPORT_DELIVERY_RUN_ID = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  env.REVIEW_FEED_STATE_PATH = '.review-feed-state/pending.json';
  env.REVIEW_FEED_REPOSITORY = process.env.REVIEW_FEED_REPOSITORY;
  const diagnostics = [];
  let checkoutReady = false;

  async function checkpoint() {
    if (checkoutReady) state.files = await collectFiles(checkout);
    state.diagnostics = diagnostics.slice(-8);
    state.updatedAt = new Date().toISOString();
    try { await store.save(state); }
    catch {
      const error = new Error('State checkpoint failed.');
      error.checkpoint = true;
      throw error;
    }
  }

  async function run(label, command, args, overrides = {}, cwd = checkout, profile = 'none') {
    const result = await execute(command, args, { cwd, env: stageEnvironment(profile, { ...env, ...overrides }) });
    diagnostics.push({ stage: label, ok: result.ok, output: result.output });
    console.log(`${label}: ${result.ok ? 'complete' : 'failed'}.`);
    if (!result.ok) {
      // Persist diagnostics encrypted; never emit private stderr or stack traces.
      await checkpoint();
      throw new Error('Private stage failed.');
    }
    return result;
  }

  try {
    const keyPath = path.join(temporary, 'source-key');
    const hostsPath = path.join(temporary, 'known-hosts');
    if (!process.env.SOURCE_DEPLOY_KEY || !process.env.SOURCE_KNOWN_HOSTS) throw new Error('Source credentials unavailable.');
    await fs.writeFile(keyPath, `${process.env.SOURCE_DEPLOY_KEY.trim()}\n`, { mode: 0o600 });
    await fs.writeFile(hostsPath, `${process.env.SOURCE_KNOWN_HOSTS.trim()}\n`, { mode: 0o600 });
    const ssh = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${hostsPath}"`;
    await run('Load private source', 'git', ['clone', '--depth', '1', '--branch', 'main', `git@github.com:${source}.git`, checkout], { GIT_SSH_COMMAND: ssh }, temporary);
    await restoreFiles(checkout, state.files);
    checkoutReady = true;
    await fs.rm(keyPath, { force: true });

    if (mode === 'daily' || mode === 'validate') {
      await run('Install runtime', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      const report = ['scripts/ms-store-daily-report.js'];
      const apps = [
        ['agenda-widget', process.env.MS_STORE_APP_ID],
        ['process-monitor-widget', '9N7G2CL3HS4F'],
        ['file-dock-widget', '9NQJ0XTPV4RP'],
        ['ai-usage-limits-codex', '9NLQRWK76W61'],
      ];
      const date = localDate();
      const pending = apps.filter(([key]) => {
        const raw = state.files[`.report-state/${key}/delivery-state.json`];
        const legacy = state.files[`.report-state/${key}/last-delivery-date.txt`]?.trim();
        return raw ? deliveryDecision(raw, date) === 'run' : legacy !== date;
      });
      if (mode === 'daily' && pending.length === 0) {
        console.log('All deliveries are already sent or protected; nothing resent.');
        return;
      }
      if (mode === 'validate') await run('Validate private source', 'npm', ['test']);
      if (sourceRunId) await run('Load completed analytics', 'node', [...report, '--phase', 'fetch-existing-analytics'], {}, checkout, 'analytics');
      else {
        const result = await execute('node', [...report, '--phase', 'fetch-current-analytics'], { cwd: checkout, env: stageEnvironment('analytics', env) });
        diagnostics.push({ stage: 'Fetch analytics', ok: result.ok, output: result.output });
        if (!result.ok) await run('Resume analytics', 'node', [...report, '--phase', 'fetch-existing-analytics'], { MS_STORE_SOURCE_RUN_ID: env.REPORT_DELIVERY_RUN_ID }, checkout, 'analytics');
        else console.log('Fetch analytics: complete.');
      }
      let failures = 0;
      for (const [index, [key, appId]] of (mode === 'validate' ? apps : pending).entries()) {
        const overrides = { REPORT_STATE_KEY: key, MS_STORE_APP_ID: appId };
        const label = `Report ${index + 1}`;
        try {
          if (mode === 'validate') {
            await run(`${label} prepare`, 'node', [...report, '--phase', 'prepare', '--output-dir', 'artifacts/report-output', '--dry-run'], overrides, checkout, 'prepare');
            const png = await fs.readFile(path.join(checkout, 'artifacts/report-output', key, 'ms-store-dashboard.png'));
            if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid image.');
            continue;
          }
          await deliverReport(
            (phase) => run(`${label} ${phase}`, 'node', [...report, '--phase', phase, '--output-dir', 'artifacts/report-output'], overrides, checkout, phase === 'prepare' ? 'prepare' : phase === 'send' ? 'delivery' : 'analytics'),
            checkpoint,
          );
        } catch (error) {
          // A checkpoint failure must stop the run; it cannot be bypassed for another app.
          if (error.checkpoint) throw error;
          await checkpoint();
          failures += 1;
        }
      }
      if (failures) throw new Error('Some reports failed.');
      console.log(mode === 'validate' ? 'Validated four dashboard images; no Telegram delivery attempted.' : 'Dashboard processing completed.');
    } else {
      const outputPath = path.join(temporary, 'review-result');
      await run('Check reviews', 'node', ['scripts/check-store-review-feed.js'], { GITHUB_OUTPUT: outputPath, REVIEW_FEED_COLLECT_ONLY: mode === 'reviews' ? 'false' : 'true' }, checkout, 'analytics');
      const result = await fs.readFile(outputPath, 'utf8');
      await checkpoint();
      if (result.split('\n').includes('ready=true')) {
        await run('Build review feed', 'node', ['scripts/export-store-review-feed.js', '--output', 'artifacts/review-feed.json'], {}, checkout, 'app');
        if (mode === 'validate-reviews') {
          const feed = JSON.parse(await fs.readFile(path.join(checkout, 'artifacts/review-feed.json'), 'utf8'));
          if (!feed || typeof feed !== 'object') throw new Error('Invalid feed.');
          console.log('Review export validated; no publication attempted.');
        } else {
          await run('Publish review feed', 'node', ['scripts/publish-store-review-feed.js', 'artifacts/review-feed.json'], {}, checkout, 'publication');
          if (!sourceRunId) await fs.writeFile(path.join(checkout, env.REVIEW_FEED_STATE_PATH), JSON.stringify({ version: 1, status: 'idle' }));
          await checkpoint();
          console.log('Review feed processing completed.');
        }
      } else console.log('Saved review report is pending or absent; existing publication retained.');
    }
  } finally {
    try { await checkpoint(); }
    finally {
      // All paths are beneath a newly allocated task-owned temporary directory.
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Execution failed. Details are available only in encrypted state.');
    process.exitCode = 1;
  });
}
