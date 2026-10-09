import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { collectFiles, encrypt } from './state.js';

// Run once inside the private source repository's workflow, never in public Actions.
const SECRET_NAMES = [
  'MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_STORE_APP_ID',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NOTION_TOKEN',
  'AGENDA_RUNTIME_INCIDENTS_DATA_SOURCE_ID', 'AGENDA_GITHUB_READ_TOKEN', 'REVIEW_FEED_DEPLOY_KEY',
];

async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'afaustov/app-ms-store-reports') throw new Error('Bootstrap must run privately.');
  const repository = 'afaustov/app-ms-store-reports-runner';
  const files = await collectFiles(process.cwd());
  const deliveryFiles = Object.keys(files).filter((name) => name.endsWith('/delivery-state.json'));
  if (deliveryFiles.length !== 4 || !files['.review-feed-state/pending.json']) throw new Error('Migration checkpoints are missing.');
  for (const name of SECRET_NAMES) if (!process.env[name]) throw new Error('Migration credential is missing.');
  if (!process.env.MIGRATION_STATE_KEY) throw new Error('Migration key is missing.');
  const ciphertext = encrypt({ version: 1, files, migratedAt: new Date().toISOString(), diagnostics: [] }, process.env.MIGRATION_STATE_KEY);
  const env = { ...process.env, GH_TOKEN: process.env.MIGRATION_GH_TOKEN };
  const run = (args, input) => execFileSync('gh', args, { env, input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Copy through stdin so credentials never appear as command arguments or output.
  for (const name of SECRET_NAMES) run(['secret', 'set', name, '--repo', repository], process.env[name]);
  run(['secret', 'set', 'STATE_ENCRYPTION_KEY', '--repo', repository], process.env.MIGRATION_STATE_KEY);
  run(['api', `repos/${repository}/contents/state.enc`, '--method', 'PUT', '--input', '-'], JSON.stringify({ message: 'Initialize encrypted execution state', branch: 'state', content: ciphertext.toString('base64') }));
  await fs.writeFile('.migration-complete', 'done\n');
  console.log('Credentials and encrypted checkpoints migrated. No report sent.');
}

main().catch(() => { console.error('Migration failed; details withheld.'); process.exitCode = 1; });
