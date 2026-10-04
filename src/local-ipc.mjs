import net from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const LIMIT = 32_768;
const allowed = {
  wait: ['command', 'timeoutMs', 'leaseMs', 'matchText', 'workerId', 'excludeRequestIds'],
  activate: ['command', 'activationAt'],
  'request-status': ['command', 'requestId', 'claimId', 'text'],
  reclaim: ['command', 'requestId', 'claimId', 'leaseMs'],
  'release-worker': ['command', 'workerId'],
  ack: ['command', 'requestId', 'claimId'],
  renew: ['command', 'requestId', 'claimId'],
  release: ['command', 'requestId', 'claimId'],
  reply: ['command', 'requestId', 'claimId', 'text'],
  status: ['command'], stop: ['command'],
};

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(allowed, value.command) ||
      Object.keys(value).some((key) => !allowed[value.command].includes(key))) throw new Error('invalid local command');
  return value;
}

export function localCall(socketPath, command, { signal } = {}) {
  validate(command);
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('local call cancelled'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const clean = () => signal?.removeEventListener('abort', aborted);
    const fail = (error) => { if (!settled) { settled = true; clean(); reject(error); } socket.destroy(); };
    const aborted = () => fail(signal.reason || new Error('local call cancelled'));
    signal?.addEventListener('abort', aborted, { once: true });
    socket.on('error', (error) => fail(error));
    socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMIT) return fail(new Error('local response too large'));
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        settled = true;
        clean();
        socket.end();
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error || 'local command failed'));
      } catch (error) { fail(error); }
    });
    socket.on('close', () => { if (!settled) fail(new Error('local bridge disconnected')); });
    if (signal?.aborted) aborted();
  });
}

export async function startLocalServer(queue, { socketPath, onStop = () => {} }) {
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Unix socket requires a short absolute path');
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const directory = await lstat(dir);
  if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error('local socket directory must be private (0700)');
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw new Error('local socket path occupied');
    try { await localCall(socketPath, { command: 'status' }); throw new Error('local bridge already running'); }
    catch (error) { if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error; }
    await unlink(socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sockets = new Set();
  const operations = new Set();
  let closing = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let buffer = '';
    let handled = false;
    const reject = (error) => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); controller.abort(new Error('wait cancelled')); });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMIT) { handled = true; reject(new Error('local command too large')); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      const operation = (async () => {
        const args = validate(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
        let result;
        if (closing) throw new Error('local bridge stopping');
        switch (args.command) {
          case 'wait': result = await queue.wait(args, controller.signal); break;
          case 'activate': result = await queue.activate(args); break;
          case 'request-status': result = queue.requestStatus(args); break;
          case 'reclaim': result = await queue.reclaim(args); break;
          case 'release-worker': result = await queue.releaseWorker(args); break;
          case 'ack': result = await queue.ack(args); break;
          case 'renew': result = await queue.renew(args); break;
          case 'release': result = await queue.release(args); break;
          case 'reply': result = await queue.reply(args); break;
          case 'status': result = queue.status(); break;
          case 'stop': result = { status: 'stopping' }; break;
        }
        socket.end(`${JSON.stringify({ ok: true, result })}\n`, args.command === 'stop' ? onStop : undefined);
      })();
      operations.add(operation);
      operation.catch((error) => { if (!socket.destroyed) reject(error); }).finally(() => operations.delete(operation));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const identity = await lstat(socketPath);
  return {
    async close() {
      closing = true;
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...operations]);
      await closed;
      try {
        const info = await lstat(socketPath);
        if (info.ino === identity.ino && info.dev === identity.dev) await unlink(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
