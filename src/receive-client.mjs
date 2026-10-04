import { watch } from 'node:fs';
import { readFile, mkdtemp, lstat, writeFile, rename, unlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { localCall } from './local-ipc.mjs';

const KIND = 'wechat-codex-receive-v1';
const emitDefault = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const exists = async (path) => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const privateJson = async (path) => {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('private regular file required');
  return JSON.parse(await readFile(path, 'utf8'));
};
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
async function control(dir) {
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid() || !basename(dir).startsWith('wechat-codex-receive-')) throw new Error('private receive directory required');
  const worker = await privateJson(join(dir, 'worker.json'));
  if (worker.kind !== KIND || !/^[0-9a-f-]{36}$/.test(worker.workerId || '')) throw new Error('invalid receive control record');
  return worker;
}
const disconnected = (error) => ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code) || error.message === 'local bridge disconnected';
const publicResult = (request, claimFile) => ({ status: 'claimed', requestId: request.requestId, text: request.text,
  ownerMatched: request.ownerMatched, claimFile,
  ...(request.attachments?.length ? { attachments: request.attachments.map(({ path: _path, ...item }) => item) } : {}) });

// One process returns one message. Empty timeout responses and reconnects stay
// inside ordinary Node code; they do not complete the parent task.
export async function createReceiveControl(directory = tmpdir()) {
  const dir = await mkdtemp(join(directory, 'wechat-codex-receive-'));
  await save(join(dir, 'worker.json'), { kind: KIND, workerId: randomUUID(), phase: 'waiting' });
  return dir;
}

export async function receiveOnce(socketPath, { leaseMs = 3_600_000, timeoutMs = 0, reconnectMs = 60_000, controlDir, emit = emitDefault, signal, excludeRequestIds = [] } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86_400_000) throw new Error('invalid receive duration');
  if (!Number.isInteger(reconnectMs) || reconnectMs < 0 || reconnectMs > 300_000) throw new Error('invalid reconnect timeout');
  if (!Array.isArray(excludeRequestIds) || excludeRequestIds.length > 100 || !excludeRequestIds.every(id => /^wx_[a-f0-9]{32}$/.test(id))) throw new Error('invalid request exclusions');
  const dir = controlDir || await createReceiveControl();
  const worker = await control(dir);
  if (worker.phase !== 'cancelled' && await exists(join(dir, 'claim.json'))) {
    let result = await privateJson(join(dir, 'claim.json'));
    if (excludeRequestIds.includes(result.request.requestId)) throw new Error('receive_control_contains_quarantined_request');
    const status = await localCall(socketPath, { command: 'request-status', requestId: result.request.requestId, claimId: result.request.claimId });
    if (status.status !== 'pending') return { status: 'already_finished', requestId: status.requestId, outcome: status.status };
    if (!status.leaseActive) {
      result = await localCall(socketPath, { command: 'reclaim', requestId: result.request.requestId, claimId: result.request.claimId, leaseMs });
      await save(join(dir, 'claim.json'), result);
    }
    await localCall(socketPath, { command: 'ack', requestId: result.request.requestId, claimId: result.request.claimId });
    await save(join(dir, 'worker.json'), { ...worker, phase: 'claimed' });
    return publicResult(result.request, join(dir, 'claim.json'));
  }
  const abort = new AbortController();
  const cancelPath = join(dir, 'cancel');
  const cancel = () => abort.abort(new Error('receive cancelled'));
  const watcher = watch(dir, () => { void exists(cancelPath).then((present) => { if (present) cancel(); }).catch(cancel); });
  watcher.on('error', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  const interrupt = () => cancel();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  if (signal?.aborted || await exists(cancelPath)) cancel();
  emit({ event: 'receive_wait_started', controlDir: dir });
  let outageAt = null;
  try {
    for (;;) {
      abort.signal.throwIfAborted();
      let result;
      try {
        result = await localCall(socketPath, { command: 'wait', timeoutMs, leaseMs, workerId: worker.workerId,
          ...(excludeRequestIds.length ? { excludeRequestIds } : {}) }, { signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted) throw error;
        if (!disconnected(error)) throw error;
        outageAt ??= Date.now();
        if (Date.now() - outageAt >= reconnectMs) throw new Error('receiver disconnected; bridge recovery required');
        await pause(Math.min(1000, Math.max(1, reconnectMs - (Date.now() - outageAt))), undefined, { signal: abort.signal });
        continue;
      }
      if (result.status === 'timeout') { outageAt = null; continue; }
      if (result.status !== 'claimed' || result.request?.ownerMatched !== true) throw new Error('owner claim not verified');
      await save(join(dir, 'claim.json'), result);
      // Save the claim before ack. If this connection drops, the stable worker
      // resumes the same request; it never selects the next one as a substitute.
      abort.signal.throwIfAborted();
      try { await localCall(socketPath, { command: 'ack', requestId: result.request.requestId, claimId: result.request.claimId }, { signal: abort.signal }); }
      catch (error) {
        if (!disconnected(error)) throw error;
        outageAt ??= Date.now();
        if (Date.now() - outageAt >= reconnectMs) throw new Error('receiver disconnected; bridge recovery required');
        await pause(100, undefined, { signal: abort.signal });
        continue;
      }
      abort.signal.throwIfAborted();
      if (await exists(cancelPath)) { cancel(); abort.signal.throwIfAborted(); }
      await save(join(dir, 'worker.json'), { ...worker, phase: 'claimed' });
      return publicResult(result.request, join(dir, 'claim.json'));
    }
  } catch (error) {
    if (abort.signal.aborted) {
      await localCall(socketPath, { command: 'release-worker', workerId: worker.workerId }).catch(() => {});
      await save(join(dir, 'worker.json'), { ...worker, phase: 'cancelled' });
      return { status: 'cancelled', controlDir: dir };
    }
    await save(join(dir, 'worker.json'), { ...worker, phase: 'needs_recovery' });
    throw error;
  } finally {
    watcher.close();
    signal?.removeEventListener('abort', cancel);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

export async function cancelReceive(socketPath, { controlDir }) {
  const worker = await control(controlDir);
  if (worker.phase === 'claimed') return { status: 'already_returned_to_parent' };
  await writeFile(join(controlDir, 'cancel'), '', { flag: 'w', mode: 0o600 });
  await localCall(socketPath, { command: 'release-worker', workerId: worker.workerId }).catch(() => {});
  return { status: 'cancellation_requested' };
}

export async function respondFromClaim(socketPath, { requestId, claimFile, text }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 800 || basename(claimFile || '') !== 'claim.json') throw new Error('exact parent reply and private claim file required');
  const dir = dirname(claimFile);
  await control(dir);
  let claim = await privateJson(claimFile);
  if (claim.request?.requestId !== requestId || claim.request.ownerMatched !== true) throw new Error('reply must match original owner request');
  const path = join(dir, 'outbox.json');
  if (await exists(path)) {
    const old = await privateJson(path);
    if (old.requestId !== requestId || old.text !== text) throw new Error('different parent reply already recorded');
  }
  let status = await localCall(socketPath, { command: 'request-status', requestId, claimId: claim.request.claimId, text });
  if (!['pending', 'accepted'].includes(status.status)) return { requestId, status: status.status, manualReconciliationRequired: true };
  if (status.status === 'accepted' && !status.replyMatches) throw new Error('a different reply was already accepted');
  if (status.status === 'pending') {
    if (!status.leaseActive) {
      claim = await localCall(socketPath, { command: 'reclaim', requestId, claimId: claim.request.claimId, leaseMs: 3_600_000 });
    } else {
      const renewed = await localCall(socketPath, { command: 'renew', requestId, claimId: claim.request.claimId });
      claim.request.leaseExpiresAt = renewed.leaseExpiresAt;
    }
    await save(claimFile, claim);
    await localCall(socketPath, { command: 'ack', requestId, claimId: claim.request.claimId });
  }
  const intent = { requestId, text, outcome: 'prepared' };
  await save(path, intent);
  try {
    const result = await localCall(socketPath, { command: 'reply', requestId, claimId: claim.request.claimId, text });
    await save(path, { ...intent, outcome: result.status, duplicate: result.duplicate });
    return { requestId, ...result };
  } catch (error) {
    // A lost response is reconciled against daemon metadata, never blindly sent.
    try {
      status = await localCall(socketPath, { command: 'request-status', requestId, claimId: claim.request.claimId, text });
      if (status.status === 'accepted' && status.replyMatches) {
        await save(path, { ...intent, outcome: 'accepted', responseLost: true });
        return { requestId, status: 'accepted', responseLost: true };
      }
    } catch { status = null; }
    await save(path, { ...intent, outcome: status?.status || 'unconfirmed' });
    return { requestId, status: status?.status || 'unconfirmed', manualReconciliationRequired: true };
  }
}
