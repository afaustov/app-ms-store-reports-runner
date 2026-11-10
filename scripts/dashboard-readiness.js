import { setTimeout } from 'node:timers/promises';

// Poll the saved export, without repeating synchronous queries or creating a new request identity.
export async function waitForDashboard(check, checkpoint, options = {}) {
  const sleep = options.sleep || setTimeout;
  const now = options.now || (() => performance.now());
  const deadline = now() + 15 * 60_000;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(90_000, remaining));
    if (now() > deadline) return false;
    const ready = await check();
    await checkpoint();
    if (ready) return true;
  }
}
