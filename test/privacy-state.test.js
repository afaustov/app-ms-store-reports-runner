import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encrypt, decrypt, restoreFiles, collectFiles, StateStore } from '../scripts/state.js';
import { deliveryDecision, deliverReport, execute, localDate, stageEnvironment } from '../scripts/run.js';

const key = '12'.repeat(32);
const state = { version: 1, files: { '.review-feed-state/pending.json': '{"reportId":"private-sensitive-id"}' } };

test('installation, clone, and tests receive no provider or orchestration credentials', () => {
  const parent = { PATH: 'path', MS_CLIENT_SECRET: 'microsoft', TELEGRAM_BOT_TOKEN: 'telegram', NOTION_TOKEN: 'notion', REVIEW_FEED_DEPLOY_KEY: 'publication', STATE_ENCRYPTION_KEY: 'encryption', SOURCE_DEPLOY_KEY: 'ssh', GITHUB_TOKEN: 'state-access', ACTIONS_RUNTIME_TOKEN: 'cache-access', NODE_AUTH_TOKEN: 'registry' };
  assert.deepEqual(stageEnvironment('none', parent), { PATH: 'path' });
  assert.deepEqual(stageEnvironment('analytics', parent), { PATH: 'path', MS_CLIENT_SECRET: 'microsoft' });
  assert.deepEqual(stageEnvironment('publication', parent), { PATH: 'path', REVIEW_FEED_DEPLOY_KEY: 'publication' });
  const delivery = stageEnvironment('delivery', parent);
  assert.equal(delivery.TELEGRAM_BOT_TOKEN, 'telegram');
  assert.equal(delivery.NOTION_TOKEN, undefined);
  assert.equal(delivery.REVIEW_FEED_DEPLOY_KEY, undefined);
  assert.throws(() => stageEnvironment('unknown', parent));
});

test('authenticated padded encryption hides plaintext and changes nonce', () => {
  const first = encrypt(state, key);
  assert.deepEqual(decrypt(first, key), state);
  assert.equal(first.includes(Buffer.from('private-sensitive-id')), false);
  assert.equal(first.length, 4096 + 32);
  assert.notDeepEqual(first, encrypt(state, key));
  assert.throws(() => decrypt(first, '34'.repeat(32)));
  first[100] ^= 1;
  assert.throws(() => decrypt(first, key));
});

test('unsupported state cannot be decrypted as valid runtime state', () => {
  assert.throws(() => decrypt(encrypt({ version: 2, files: {} }, key), key));
  assert.throws(() => decrypt(encrypt({ version: 1, files: [] }, key), key));
  assert.throws(() => decrypt(encrypt({ version: 1, files: 'invalid' }, key), key));
  assert.throws(() => encrypt(state, 'weak-key'));
});

test('restore validates every path before writing; only checkpoint files are collected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-state-test-'));
  try {
    await assert.rejects(restoreFiles(root, { ...state.files, '../private.txt': 'secret' }));
    await assert.rejects(fs.stat(path.join(root, '.review-feed-state')));
    await restoreFiles(root, state.files);
    assert.deepEqual(await collectFiles(root), state.files);
    await fs.writeFile(path.join(root, '.review-feed-state', 'unexpected.txt'), 'not-a-checkpoint');
    await assert.rejects(collectFiles(root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('sent and uncertain deliveries are skipped; corrupt or future state stops execution', () => {
  const raw = (status, date = '2026-10-09') => JSON.stringify({ version: 1, status, deliveryDate: date });
  assert.equal(deliveryDecision(raw('sent'), '2026-10-09'), 'skip');
  assert.equal(deliveryDecision(raw('in_flight'), '2026-10-09'), 'skip');
  assert.equal(deliveryDecision(raw('prepared'), '2026-10-09'), 'run');
  assert.equal(deliveryDecision(raw('sent', '2026-10-08'), '2026-10-09'), 'run');
  assert.throws(() => deliveryDecision(raw('sent', '2026-10-10'), '2026-10-09'));
  assert.throws(() => deliveryDecision('{bad}', '2026-10-09'));
  assert.throws(() => deliveryDecision(raw('unknown'), '2026-10-09'));
  assert.equal(localDate(new Date('2026-10-08T17:00:00Z')), '2026-10-09');
});

test('delivery requires a confirmed durable in-flight checkpoint', async () => {
  const events = [];
  await deliverReport(async (phase) => events.push(phase), async () => events.push('checkpoint'));
  assert.deepEqual(events, ['prepare', 'checkpoint', 'mark-in-flight', 'checkpoint', 'send', 'checkpoint']);
  for (const failAt of [1, 2]) {
    const phases = [];
    let count = 0;
    await assert.rejects(deliverReport(async (phase) => phases.push(phase), async () => { if (++count === failAt) throw new Error('disk unavailable'); }));
    assert.equal(phases.includes('send'), false);
  }
});

test('ambiguous send does not attempt delivery a second time', async () => {
  const phases = [];
  await assert.rejects(deliverReport(async (phase) => {
    phases.push(phase);
    if (phase === 'send') throw new Error('ambiguous provider response');
  }, async () => {}));
  assert.equal(phases.filter((phase) => phase === 'send').length, 1);
});

test('private subprocess stdout, stderr, and workflow commands are captured, not emitted', async () => {
  const result = await execute(process.execPath, ['-e', 'console.log("::warning::private-financial-data"); console.error("secret-stderr"); process.exitCode=1'], { env: process.env, timeout: 10_000 });
  assert.equal(result.ok, false);
  assert.match(result.output, /private-financial-data/);
  assert.match(result.output, /secret-stderr/);
});

test('state store fails closed when checkpoint is missing', async () => {
  const store = new StateStore({ repository: 'owner/runner', token: 'token', key, fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(store.load());
  await assert.rejects(store.save(state));
});

test('state writes encrypted data with optimistic concurrency', async () => {
  const requests = [];
  const store = new StateStore({ repository: 'owner/runner', token: 'token', key, fetchImpl: async (url, options) => {
    requests.push(options);
    if (!options.method) return { ok: true, json: async () => ({ sha: 'old', encoding: 'base64', content: encrypt(state, key).toString('base64') }) };
    return { ok: true, json: async () => ({ content: { sha: 'new' } }) };
  } });
  await store.load();
  await store.save(state);
  const body = JSON.parse(requests[1].body);
  assert.equal(body.sha, 'old');
  assert.equal(body.branch, 'state');
  assert.deepEqual(decrypt(Buffer.from(body.content, 'base64'), key), state);
  assert.equal(requests[1].body.includes('private-sensitive-id'), false);
  assert.equal(store.sha, 'new');
});

test('lost checkpoint response is reconciled; conflicting state is never overwritten', async () => {
  for (const committed of [true, false]) {
    let remote = { sha: 'old', encoding: 'base64', content: encrypt(state, key).toString('base64') };
    let puts = 0;
    const store = new StateStore({ repository: 'owner/runner', token: 'token', key, fetchImpl: async (url, options) => {
      if (!options.method) return { ok: true, json: async () => remote };
      puts += 1;
      if (committed) remote = { ...remote, sha: 'new', content: JSON.parse(options.body).content };
      throw new Error('response lost');
    } });
    await store.load();
    if (committed) { await store.save(state); assert.equal(store.sha, 'new'); }
    else await assert.rejects(store.save(state));
    assert.equal(puts, 1);
  }
});
