import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execute } from '../scripts/run.js';

test('missing credentials fail with a generic message and no sensitive output', async () => {
  const result = await execute(process.execPath, ['scripts/run.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      RUN_MODE: 'validate',
      PRIVATE_SOURCE_REPOSITORY: 'owner/private-sensitive-project',
      MS_STORE_SOURCE_RUN_ID: '1-1',
      GITHUB_REPOSITORY: 'owner/public-runner',
      GITHUB_TOKEN: 'private-sensitive-token',
      STATE_ENCRYPTION_KEY: 'bad-key',
    },
    timeout: 10_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /Details are available only in encrypted state/);
  assert.doesNotMatch(result.output, /private-sensitive|bad-key|Error:|at /);
});

test('bootstrap refuses execution from a public repository', async () => {
  const result = await execute(process.execPath, ['scripts/bootstrap.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/public-runner', MIGRATION_GH_TOKEN: 'private-sensitive-token' },
    timeout: 10_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.output.trim(), 'Migration failed; details withheld.');
});

test('public execution has no cache or artifact upload, push, or PR triggers', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/cloud-reports.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /actions\/(cache|upload-artifact)|^\s+(push|pull_request|pull_request_target):/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /group: cloud-reports/);
  assert.match(workflow, /vars.REPORTS_ENABLED == 'true'/);
});
