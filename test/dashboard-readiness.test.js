import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDashboard } from '../scripts/dashboard-readiness.js';

function clock() {
  let elapsed = 0;
  const waits = [];
  return { waits, now: () => elapsed, sleep: async ms => { waits.push(ms); elapsed += ms; }, advance: ms => { elapsed += ms; } };
}

test('ready exports return immediately after the next 90-second check and checkpoint', async () => {
  const timing = clock();
  const events = [];
  assert.equal(await waitForDashboard(async () => { events.push('ready'); return true; }, async () => { events.push('saved'); }, timing), true);
  assert.deepEqual(timing.waits, [90_000]);
  assert.deepEqual(events, ['ready', 'saved']);
});

test('pending exports are checked ten times over fifteen minutes and retained', async () => {
  const timing = clock();
  let checks = 0;
  let checkpoints = 0;
  assert.equal(await waitForDashboard(async () => { checks++; return false; }, async () => { checkpoints++; }, timing), false);
  assert.equal(checks, 10);
  assert.equal(checkpoints, 10);
  assert.equal(timing.now(), 900_000);
});

test('time spent checking counts against the window, and errors are not treated as pending', async () => {
  const timing = clock();
  let checks = 0;
  assert.equal(await waitForDashboard(async () => { checks++; timing.advance(120_000); return false; }, async () => {}, timing), false);
  assert.equal(checks, 5);
  const failing = clock();
  await assert.rejects(waitForDashboard(async () => { throw new Error('Microsoft failure'); }, async () => {}, failing), /Microsoft failure/);
  assert.equal(failing.waits.length, 1);
});

test('a failed durable checkpoint stops collection before delivery can proceed', async () => {
  await assert.rejects(waitForDashboard(async () => true, async () => { throw new Error('checkpoint failed'); }, clock()), /checkpoint failed/);
});
