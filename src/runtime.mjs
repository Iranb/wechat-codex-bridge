import { open, unlink, mkdir, lstat, readFile, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const statePath = () => process.env.WECHAT_CODEX_STATE || join(homedir(), '.local', 'share', 'wechat-codex-bridge', 'state.json');
export const localSocketPath = () => process.env.WECHAT_CODEX_SOCKET || join(dirname(statePath()), 'local-queue.sock');

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let file;
  try { file = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const guard = `${lockPath}.recovery`;
    try { await mkdir(guard, { mode: 0o700 }); }
    catch (guardError) {
      if (guardError.code === 'EEXIST') throw new Error('another lock recovery is in progress; inspect a stale recovery guard manually');
      throw guardError;
    }
    try {
      const before = await lstat(lockPath);
      if (!before.isFile() || (before.mode & 0o077)) throw new Error('unsafe state lock');
      const raw = (await readFile(lockPath, 'utf8')).trim();
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('invalid state lock; inspect manually');
      let dead = false;
      try { process.kill(Number(raw), 0); }
      catch (probe) { if (probe.code === 'ESRCH') dead = true; else throw new Error('state lock owner cannot be checked'); }
      if (!dead) throw new Error('another bridge or setup process holds the state lock');
      const after = await lstat(lockPath);
      if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) throw new Error('state lock changed; retry');
      await unlink(lockPath);
      file = await open(lockPath, 'wx', 0o600);
    } finally { await rmdir(guard); }
  }
  await file.writeFile(String(process.pid));
  return async () => { await file.close(); await unlink(lockPath); };
}
