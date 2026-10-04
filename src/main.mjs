import { setTimeout as pause } from 'node:timers/promises';
import { JsonStore } from './store.mjs';
import { Bridge } from './bridge.mjs';
import { WechatClient, pollOnce } from './wechat.mjs';
import { createMcpHandler, startStdioMcp } from './mcp.mjs';
import { acquireLock, statePath, localSocketPath } from './runtime.mjs';
import { LocalQueue } from './local-queue.mjs';
import { startLocalServer } from './local-ipc.mjs';

const args = process.argv.slice(2);
if (!args.includes('--live')) throw new Error('Explicit --live flag required');
const at = args.indexOf('--mode');
const mode = at < 0 ? 'local-queue' : args[at + 1];
if (!['webhook', 'local-queue'].includes(mode)) throw new Error('Mode must be webhook or local-queue');
const release = await acquireLock(statePath());
const controller = new AbortController();
let server;
let queue;
let retry;
let stopped = false;
const stop = () => { stopped = true; controller.abort(); clearInterval(retry); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  const store = await new JsonStore(statePath()).load();
  if (!store.data.account?.token || !store.data.account?.boundUserId) throw new Error('Run login and bind before starting');
  const client = new WechatClient();
  const bridge = new Bridge({ store, client, mode });
  await bridge.recover();
  if (mode === 'local-queue') {
    queue = new LocalQueue(bridge);
    queue.receiveStatus = { state: 'starting', successfulPolls: 0, lastSuccessAt: null, lastAcceptedCount: null, lastFailure: null };
    server = await startLocalServer(queue, { socketPath: localSocketPath(), onStop: stop });
    process.stdout.write(`${JSON.stringify({ status: 'ready', mode, ownerBound: true, socketPath: localSocketPath() })}\n`);
  } else {
    retry = setInterval(() => { void bridge.deliverPending().catch(() => {}); }, 30_000);
    retry.unref();
    startStdioMcp(createMcpHandler(bridge));
    process.stdin.on('end', stop);
  }
  let failures = 0;
  while (!stopped) {
    try {
      if (queue) queue.receiveStatus.state = 'polling';
      const accepted = await pollOnce(client, store, bridge, controller.signal);
      failures = 0;
      if (queue) {
        queue.receiveStatus.successfulPolls++;
        queue.receiveStatus.lastSuccessAt = new Date().toISOString();
        queue.receiveStatus.lastAcceptedCount = accepted;
        queue.receiveStatus.lastFailure = null;
      }
    }
    catch (error) {
      if (stopped) break;
      if (queue) {
        queue.receiveStatus.state = error.code === -14 ? 'session_expired' : 'retrying';
        queue.receiveStatus.lastFailure = { at: new Date().toISOString(),
          kind: typeof error.code === 'number' ? 'api_rejected' : ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'transport_or_http',
          apiCode: typeof error.code === 'number' ? error.code : null };
      }
      if (error.code === -14) throw new Error('WeChat session expired; login again after reviewing the account state');
      failures++;
      process.stderr.write('WeChat poll failed; retrying\n');
      try { await pause(Math.min(1000 * 2 ** Math.min(failures, 6), 60_000), undefined, { signal: controller.signal }); }
      catch (delayError) { if (!stopped) throw delayError; }
    }
  }
} finally {
  stop();
  await server?.close();
  await release();
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}
