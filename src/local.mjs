import { JsonStore } from './store.mjs';
import { localCall } from './local-ipc.mjs';
import { receiveOnce, cancelReceive, respondFromClaim } from './receive-client.mjs';
import { attachmentFromClaim } from './attachment-client.mjs';
import { statePath, localSocketPath } from './runtime.mjs';

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function inputJson() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 32_768) throw new Error('stdin JSON too large');
  }
  let record;
  try { record = JSON.parse(input); }
  catch { throw new Error('stdin must contain valid JSON'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('stdin JSON object required');
  return record;
}

try {
  const args = process.argv.slice(2);
  const command = args.shift();
  const options = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--live') { options.live = true; continue; }
    if (['wait', 'receive'].includes(command) && ['--timeout-ms', '--lease-ms', '--reconnect-ms'].includes(flag) && /^\d+$/.test(args[index + 1] || '')) {
      if (command === 'wait' && flag === '--reconnect-ms') throw new Error('invalid wait flag');
      options[flag] = Number(args[++index]);
      continue;
    }
    if (((command === 'wait' && flag === '--match-text') || (command === 'receive' && flag === '--resume-control')) && args[index + 1]?.length) {
      options[flag] = args[++index];
      continue;
    }
    throw new Error('unknown or invalid local command flag');
  }
  if (!options.live) throw new Error('Explicit --live flag required for the real local queue');
  const socket = localSocketPath();
  if (command === 'binding-check') {
    const store = await new JsonStore(statePath()).load();
    emit({ ownerBound: Boolean(store.data.account?.boundUserId), accountConfigured: Boolean(store.data.account?.token) });
  } else if (command === 'receive') {
    emit(await receiveOnce(socket, {
      timeoutMs: options['--timeout-ms'] ?? 0,
      leaseMs: options['--lease-ms'] ?? 3_600_000,
      reconnectMs: options['--reconnect-ms'] ?? 60_000,
      controlDir: options['--resume-control'], emit,
    }));
  } else if (command === 'cancel-wait') {
    emit(await cancelReceive(socket, await inputJson()));
  } else if (command === 'respond') {
    emit(await respondFromClaim(socket, await inputJson()));
  } else if (command === 'attachment') {
    emit(await attachmentFromClaim(await inputJson()));
  } else {
    let request = { command };
    if (command === 'wait') {
      request.timeoutMs = options['--timeout-ms'] ?? 60_000;
      request.leaseMs = options['--lease-ms'] ?? 600_000;
      if (options['--match-text'] !== undefined) request.matchText = options['--match-text'];
    } else if (command === 'activate') {
      const record = await inputJson();
      request.activationAt = record.activationAt;
    } else if (['ack', 'renew', 'release', 'reply', 'reclaim', 'request-status'].includes(command)) {
      const record = await inputJson();
      const claim = record.request || record;
      request = { command, requestId: claim.requestId, claimId: claim.claimId };
      if (command === 'reply') request.text = record.text;
      if (command === 'request-status' && record.text !== undefined) request.text = record.text;
      if (command === 'reclaim' && record.leaseMs !== undefined) request.leaseMs = record.leaseMs;
    } else if (!['status', 'stop'].includes(command)) throw new Error('unknown local command');
    emit(await localCall(socket, request));
  }
} catch (error) {
  const disconnected = ['ENOENT', 'ECONNREFUSED'].includes(error.code);
  emit({ status: 'error', error: disconnected ? 'local bridge is not running' : error.message });
  process.exitCode = 1;
}
