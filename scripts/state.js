import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const AAD = Buffer.from('private-report-runner-state-v1');
export const STATE_PATH = 'state.enc';
export const STATE_BRANCH = 'state';

function keyBytes(key) {
  if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('Invalid encryption key.');
  return Buffer.from(key, 'hex');
}

export function encrypt(value, key) {
  const nonce = randomBytes(12);
  const data = Buffer.from(JSON.stringify(value));
  // Pad to fixed blocks so ciphertext length does not reveal individual state values.
  const padded = randomBytes(Math.ceil((data.length + 4) / 65536) * 65536);
  padded.writeUInt32BE(data.length);
  data.copy(padded, 4);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), nonce);
  cipher.setAAD(AAD);
  return Buffer.concat([Buffer.from('PRS1'), nonce, cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
}

export function decrypt(blob, key) {
  if (blob.length < 32 || blob.subarray(0, 4).toString() !== 'PRS1') throw new Error('Invalid encrypted state.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), blob.subarray(4, 16));
  decipher.setAAD(AAD);
  decipher.setAuthTag(blob.subarray(-16));
  const data = Buffer.concat([decipher.update(blob.subarray(16, -16)), decipher.final()]);
  const length = data.readUInt32BE();
  if (length > data.length - 4) throw new Error('Invalid state length.');
  const value = JSON.parse(data.subarray(4, length + 4).toString());
  if (value.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('Invalid state schema.');
  return value;
}

export function safeStatePath(relative) {
  return /^\.report-state\/[a-z0-9_-]+\/(delivery-state\.json|last-delivery-date\.txt|last-rating-date\.txt)$/.test(relative)
    || relative === '.review-feed-state/pending.json';
}

export async function restoreFiles(root, files) {
  // Validate the entire map before writing anything.
  for (const [relative, value] of Object.entries(files)) {
    if (!safeStatePath(relative) || typeof value !== 'string') throw new Error('Unsafe state entry.');
  }
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value, { mode: 0o600 });
  }
}

export async function collectFiles(root) {
  const files = {};
  async function visit(relative) {
    let entries;
    try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && safeStatePath(child)) files[child] = await fs.readFile(path.join(root, child), 'utf8');
      else throw new Error('Unexpected state file.');
    }
  }
  await visit('.report-state');
  await visit('.review-feed-state');
  return files;
}

export class StateStore {
  constructor({ repository, token, key, fetchImpl = fetch }) {
    if (!/^[\w-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid repository.');
    keyBytes(key);
    this.url = `https://api.github.com/repos/${repository}/contents/${STATE_PATH}`;
    this.headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    this.key = key;
    this.fetch = fetchImpl;
  }

  async readRemote() {
    const response = await this.fetch(`${this.url}?ref=${STATE_BRANCH}`, { headers: this.headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('State retrieval failed.');
    const remote = await response.json();
    if (!remote.sha || remote.encoding !== 'base64') throw new Error('Invalid remote state.');
    return remote;
  }

  async load() {
    const remote = await this.readRemote();
    this.sha = remote.sha;
    return decrypt(Buffer.from(remote.content, 'base64'), this.key);
  }

  async save(value) {
    if (!this.sha) throw new Error('State must be loaded before saving.');
    const content = encrypt(value, this.key).toString('base64');
    try {
      const response = await this.fetch(this.url, {
        method: 'PUT', headers: this.headers, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ message: 'Update encrypted execution state', branch: STATE_BRANCH, sha: this.sha, content }),
      });
      if (!response.ok) throw new Error('State checkpoint failed.');
      const result = await response.json();
      if (!result.content?.sha) throw new Error('State checkpoint unconfirmed.');
      this.sha = result.content.sha;
    } catch {
      // Reconcile a lost PUT response without overwriting another writer's state.
      const remote = await this.readRemote();
      if (Buffer.from(remote.content, 'base64').toString('base64') !== content) throw new Error('State checkpoint unconfirmed.');
      this.sha = remote.sha;
    }
  }
}
