import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODEL } from './native-client.mjs';

export async function readPrivateJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('private journal file required');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writePrivateJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('private journal directory required');
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify(data));
    await file.sync();
    await file.close();
    file = null;
    await rename(temp, path);
  } finally { await file?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}

export class NativeJournal {
  constructor(path) {
    this.path = path;
    this.data = { kind: 'wechat-codex-bridge-v1', model: MODEL, threadId: null, phase: 'unprepared', active: null, receiveDir: null, completed: 0 };
    this.chain = Promise.resolve();
  }
  async load() {
    try {
      this.data = await readPrivateJson(this.path);
      if (this.data.kind !== 'wechat-codex-bridge-v1' || this.data.model !== MODEL) throw new Error('invalid native journal');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  update(fn) {
    const operation = this.chain.then(async () => {
      const data = structuredClone(this.data);
      fn(data);
      await writePrivateJson(this.path, data);
      this.data = data;
    });
    this.chain = operation.catch(() => {});
    return operation;
  }
  status() {
    const { threadId, model, phase, completed, pauseReason, active, transport, cliProbe } = this.data;
    return { threadId, model, phase, completed, ...(pauseReason ? { pauseReason } : {}),
      ...(transport ? { transport } : {}), ...(cliProbe ? { cliProbeStage: cliProbe.stage } : {}),
      quarantinedCount: (this.data.quarantined || []).length,
      ...(active ? { requestId: active.requestId, turnId: active.turnId || null, stage: active.stage } : {}) };
  }
}
