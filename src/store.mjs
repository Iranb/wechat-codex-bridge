import { readFile, rename, mkdir, lstat, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const initial = () => ({ version: 2, account: null, requests: {}, subscriptions: {}, localIngressSequence: 0, localQueueActivation: null });

export class JsonStore {
  constructor(path) { this.path = path; this.data = initial(); this.writeChain = Promise.resolve(); }

  async load() {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || (info.mode & 0o077)) throw new Error('state file must be a private regular file (chmod 600)');
      let parsed;
      try { parsed = JSON.parse(await readFile(this.path, 'utf8')); }
      catch { throw new Error('invalid private state JSON'); }
      if (parsed.version !== 2 || !('account' in parsed) || !parsed.requests || !parsed.subscriptions) throw new Error('invalid state format');
      this.data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async update(fn) {
    const operation = this.writeChain.then(async () => {
      const next = structuredClone(this.data);
      const result = fn(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(temp, 'wx', 0o600);
        await file.chmod(0o600);
        await file.writeFile(JSON.stringify(next));
        await file.sync();
        await file.close();
        file = null;
        await rename(temp, this.path);
      } finally {
        await file?.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
      this.data = next;
      return result;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }
}
