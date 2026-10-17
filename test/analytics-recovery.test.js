import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyticsDecision, finalAnalyticsCheck, localDate, main, verifyAnalyticsSource, replaceUnstartedAnalytics } from '../scripts/run.js';

test('request replacement needs explicit proof and retains the previous request and every delivery checkpoint', () => {
  const previous = analyticsDecision(null, '2026-10-14', '', '123456789-1', 'daily');
  const state = { files: { '.report-state/app/delivery-state.json': 'do-not-change' } };
  assert.throws(() => replaceUnstartedAnalytics(state, previous, '2026-10-14', '123456790-1', 'ready=false\n'));
  assert.equal(state.analyticsHistory, undefined);
  const next = replaceUnstartedAnalytics(state, previous, '2026-10-14', '123456790-1', 'verified_missing=true\n');
  assert.equal(next.sourceRunId, '123456790-1');
  assert.equal(next.allowCreate, true);
  assert.equal(next.method, 'async');
  assert.equal(state.analyticsHistory[0].sourceRunId, previous.sourceRunId);
  assert.equal(state.files['.report-state/app/delivery-state.json'], 'do-not-change');
});

test('same-day retries resume their request; old, missing, and corrupt checkpoints are handled safely', () => {
  const created = analyticsDecision(null, '2026-10-14', '', '123456789-1', 'daily');
  assert.equal(created.allowCreate, true);
  assert.equal(created.method, 'query');
  assert.deepEqual(analyticsDecision(created, '2026-10-14', '', '123456790-1', 'retry'), created);
  assert.equal(analyticsDecision(created, '2026-10-15', '', '123456790-1', 'retry'), null);
  assert.equal(analyticsDecision(null, '2026-10-14', '', '123456789-1', 'retry'), null);
  assert.equal(analyticsDecision(created, '2026-10-15', '', '123456790-1', 'daily').sourceRunId, '123456790-1');
  assert.equal(analyticsDecision({ ...created, method: 'async' }, '2026-10-15', '', '123456790-1', 'daily').method, 'query');
  assert.equal(analyticsDecision({ ...created, method: 'async' }, '2026-10-14', '', '123456790-1', 'retry').method, 'query');
  assert.equal(analyticsDecision(created, '2026-10-14', '123456791-1', '', 'daily').allowCreate, false);
  assert.equal(analyticsDecision(created, '2026-10-14', '123456791-1', '', 'daily').method, 'async');
  assert.equal(analyticsDecision({ ...created, method: 'query' }, '2026-10-14', '', '123456790-1', 'retry').method, 'query');
  assert.throws(() => analyticsDecision({ ...created, date: '2026-10-15' }, '2026-10-14', '', '', 'retry'));
  assert.throws(() => analyticsDecision({ ...created, status: 'invalid' }, '2026-10-14', '', '', 'retry'));
  assert.equal(finalAnalyticsCheck('retry', new Date('2026-10-14T04:15:00Z')), false);
  assert.equal(finalAnalyticsCheck('retry', new Date('2026-10-14T15:15:00Z')), true);
  assert.equal(finalAnalyticsCheck('retry', new Date('2026-10-14T03:15:00Z')), false);
});

test('explicit recovery rejects stale dates and nonexistent run attempts', async () => {
  const request = (created_at, run_attempt = 1) => async () => ({ ok: true, json: async () => ({ created_at, run_attempt }) });
  await verifyAnalyticsSource('owner/repo', 'token', '123456789-1', '2026-10-14', request('2026-10-13T17:00:00Z'));
  await assert.rejects(verifyAnalyticsSource('owner/repo', 'token', '123456789-1', '2026-10-14', request('2026-10-12T17:00:00Z')));
  await assert.rejects(verifyAnalyticsSource('owner/repo', 'token', '123456789-2', '2026-10-14', request('2026-10-13T17:00:00Z')));
});

test('pending daily run checkpoints once, retry sends only after readiness and durable in-flight state', async (t) => {
  const values = { RUN_MODE: 'daily', PRIVATE_SOURCE_REPOSITORY: 'owner/private', GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1',
    MS_STORE_SOURCE_RUN_ID: '', SOURCE_DEPLOY_KEY: 'test-only', SOURCE_KNOWN_HOSTS: 'test-only', MS_STORE_APP_ID: '9NAGENDA0001' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const state = { version: 1, files: {} };
  let saved;
  let ready = false;
  let sends = 0;
  const sources = [];
  const store = { load: async () => state, save: async value => { saved = structuredClone(value); } };
  const execute = async (command, args, options) => {
    if (command === 'git') await fs.mkdir(args.at(-1), { recursive: true });
    if (args[0] === 'scripts/check-store-dashboard-analytics.js') {
      sources.push(options.env.MS_STORE_SOURCE_RUN_ID);
      assert.equal(saved.analytics.sourceRunId, '123456789-1');
      assert.equal(options.env.DASHBOARD_FETCH_METHOD, 'query');
      await fs.writeFile(options.env.GITHUB_OUTPUT, `ready=${ready}\n`);
    }
    if (args.includes('--phase')) {
      const phase = args[args.indexOf('--phase') + 1];
      assert.equal(args[0], 'scripts/ms-store-dashboard-album.js');
      const keys = ['agenda-widget', 'process-monitor-widget', 'file-dock-widget', 'ai-usage-limits-codex'];
      if (phase === 'send') {
        assert.ok(keys.every(key => JSON.parse(saved.files[`.report-state/${key}/delivery-state.json`]).status === 'in_flight'));
        sends += 1;
      }
      for (const key of keys) {
        const target = path.join(options.cwd, `.report-state/${key}/delivery-state.json`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify({ version: 1, status: phase === 'prepare' ? 'prepared' : phase === 'send' ? 'sent' : 'in_flight', deliveryDate: localDate() }));
      }
    }
    return { ok: true, output: '' };
  };
  await main({ store, execute });
  assert.equal(sends, 0);
  assert.equal(state.analytics.status, 'pending');
  process.env.RUN_MODE = 'retry';
  const lastCheck = new Date(`${localDate()}T23:15:00+08:00`);
  await assert.rejects(main({ store, execute, now: () => lastCheck }), /still pending/);
  assert.equal(sends, 0);
  assert.equal(state.analytics.status, 'pending');
  process.env.RUN_MODE = 'daily';
  ready = true;
  process.env.RUN_MODE = 'retry';
  // An ordinary scheduled retry completes delivery without requiring manual direct mode.
  process.env.GITHUB_RUN_ID = '123456790';
  await main({ store, execute });
  assert.equal(sends, 1);
  assert.deepEqual(sources, ['123456789-1', '123456789-1', '123456789-1']);
  assert.equal(state.analytics.status, 'ready');
  await main({ store, execute });
  assert.equal(sends, 1);
  // A partially delivered legacy day must not resend its successful reports in an album.
  delete state.files['.report-state/ai-usage-limits-codex/delivery-state.json'];
  await main({ store, execute });
  assert.equal(sends, 1);
});
