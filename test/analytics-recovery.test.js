import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyticsDecision, finalAnalyticsCheck, localDate, main, verifyAnalyticsSource } from '../scripts/run.js';

test('same-day retries resume their request; old, missing, and corrupt checkpoints are handled safely', () => {
  const created = analyticsDecision(null, '2026-10-14', '', '123456789-1', 'daily');
  assert.equal(created.allowCreate, true);
  assert.deepEqual(analyticsDecision(created, '2026-10-14', '', '123456790-1', 'retry'), created);
  assert.equal(analyticsDecision(created, '2026-10-15', '', '123456790-1', 'retry'), null);
  assert.equal(analyticsDecision(null, '2026-10-14', '', '123456789-1', 'retry'), null);
  assert.equal(analyticsDecision(created, '2026-10-15', '', '123456790-1', 'daily').sourceRunId, '123456790-1');
  assert.equal(analyticsDecision(created, '2026-10-14', '123456791-1', '', 'daily').allowCreate, false);
  assert.throws(() => analyticsDecision({ ...created, date: '2026-10-15' }, '2026-10-14', '', '', 'retry'));
  assert.throws(() => analyticsDecision({ ...created, status: 'invalid' }, '2026-10-14', '', '', 'retry'));
  assert.equal(finalAnalyticsCheck('retry', new Date('2026-10-14T04:15:00Z')), true);
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
      await fs.writeFile(options.env.GITHUB_OUTPUT, `ready=${ready}\n`);
    }
    if (args.includes('--phase')) {
      const phase = args[args.indexOf('--phase') + 1];
      const relative = `.report-state/${options.env.REPORT_STATE_KEY}/delivery-state.json`;
      if (phase === 'send') { assert.equal(JSON.parse(saved.files[relative]).status, 'in_flight'); sends += 1; }
      const target = path.join(options.cwd, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify({ version: 1, status: phase === 'prepare' ? 'prepared' : phase === 'send' ? 'sent' : 'in_flight', deliveryDate: localDate() }));
    }
    return { ok: true, output: '' };
  };
  await main({ store, execute });
  assert.equal(sends, 0);
  assert.equal(state.analytics.status, 'pending');
  process.env.RUN_MODE = 'retry';
  const noon = new Date(`${localDate()}T12:15:00+08:00`);
  await assert.rejects(main({ store, execute, now: () => noon }), /still pending/);
  assert.equal(sends, 0);
  assert.equal(state.analytics.status, 'pending');
  process.env.RUN_MODE = 'daily';
  ready = true;
  // Manual daily recovery and scheduled retry share the same saved request.
  process.env.GITHUB_RUN_ID = '123456790';
  await main({ store, execute });
  assert.equal(sends, 4);
  assert.deepEqual(sources, ['123456789-1', '123456789-1', '123456789-1']);
  assert.equal(state.analytics.status, 'ready');
  await main({ store, execute });
  assert.equal(sends, 4);
});
