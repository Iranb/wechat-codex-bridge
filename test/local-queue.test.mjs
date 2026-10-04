import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JsonStore } from '../src/store.mjs';
import { Bridge, MAX_AGE } from '../src/bridge.mjs';
import { LocalQueue } from '../src/local-queue.mjs';
import { normalizeText, pollOnce } from '../src/wechat.mjs';
import { localCall, startLocalServer } from '../src/local-ipc.mjs';
import { acquireLock } from '../src/runtime.mjs';
import { receiveOnce, cancelReceive, respondFromClaim } from '../src/receive-client.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const message = (id = 'm1', userId = 'owner') => ({ userId, messageId: id, contextToken: `fake-context-${id}`, text: `text ${id}`, timestamp: new Date().toISOString() });
const raw = (id, userId = 'owner') => ({ message_type: 1, from_user_id: userId, message_id: id, context_token: `fake-context-${id}`,
  item_list: [{ type: 1, text_item: { text: `text ${id}` } }] });

async function fixture(t, { activate = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-local-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = await new JsonStore(path).load();
  const account = { token: 'fake-only-token', baseUrl: 'https://ilinkai.weixin.qq.com', accountId: 'fake-bot', boundUserId: 'owner', cursor: '' };
  await store.update((state) => { state.account = account; });
  const sent = [];
  const client = { getUpdates: async () => ({ msgs: [], get_updates_buf: '' }),
    sendText: async (_account, request, text) => { sent.push({ userId: request.userId, contextToken: request.contextToken, text }); } };
  let now = Date.now();
  const options = { client, mode: 'local-queue', clock: () => now };
  const bridge = new Bridge({ store, ...options });
  const queue = new LocalQueue(bridge);
  if (activate) await queue.activate({ activationAt: 'now' });
  return { dir, path, store, account, client, sent, options, bridge, queue, advance: (ms) => { now += ms; } };
}

test('owner-only text is durable without subscriptions; batch cursor and message IDs deduplicate', async (t) => {
  const f = await fixture(t);
  f.client.getUpdates = async () => ({ get_updates_buf: 'fake-cursor', msgs: [raw('m1'), raw('m1'), raw('m2', 'other'),
    { ...raw('m3'), item_list: [{ type: 2, image_item: {} }] }] });
  assert.equal(await pollOnce(f.client, f.store, f.bridge), 1);
  assert.equal(await pollOnce(f.client, f.store, f.bridge), 0);
  const restarted = await new JsonStore(f.path).load();
  assert.equal(Object.keys(restarted.data.requests).length, 1);
  const request = Object.values(restarted.data.requests)[0];
  assert.equal(request.messageId, 'm1');
  assert.equal(request.localQueue.status, 'pending');
  assert.equal(request.text, 'text m1');
  assert.deepEqual(restarted.data.account, { ...f.account, cursor: 'fake-cursor' });
  assert.equal((await readFile(f.path, 'utf8')).includes('fake-context-m2'), false);
  assert.equal((await stat(f.path)).mode & 0o077, 0);
});

test('wait wakes on a new persisted request; concurrent claims select it once', async (t) => {
  const f = await fixture(t);
  const waiting = f.queue.wait({ timeoutMs: 2000 });
  const produce = new Promise((resolve, reject) => setTimeout(() => f.bridge.incoming(message()).then(resolve, reject), 25));
  const [result] = await Promise.all([waiting, produce]);
  assert.equal(result.status, 'claimed');
  assert.equal(result.request.text, 'text m1');
  assert.equal(f.queue.events.listenerCount('changed'), 0);
  await f.queue.release(result.request);
  const claims = await Promise.all([f.queue.claim(), f.queue.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const publicText = JSON.stringify(claims.find(Boolean));
  for (const privateValue of ['fake-only-token', 'fake-context-m1', 'fake-bot', 'userId', 'messageId', 'contextToken']) assert.equal(publicText.includes(privateValue), false);
  assert.equal((await f.queue.wait({ timeoutMs: 15 })).status, 'timeout');
});

test('claim/ack survive restart and reply uses only the original request mapping', async (t) => {
  const f = await fixture(t);
  await f.bridge.incoming(message());
  const claim = await f.queue.claim();
  assert.equal((await f.queue.ack(claim)).duplicate, false);
  assert.equal((await f.queue.ack(claim)).duplicate, true);
  const store = await new JsonStore(f.path).load();
  const bridge = new Bridge({ store, ...f.options });
  await bridge.recover();
  const queue = new LocalQueue(bridge);
  assert.equal(await queue.claim(), null);
  await assert.rejects(queue.reply({ ...claim, requestId: 'wx_unknown', text: 'reply' }), /unknown local/);
  await assert.rejects(queue.reply({ ...claim, claimId: 'wrong', text: 'reply' }), /claim does not match/);
  assert.deepEqual(await queue.reply({ ...claim, text: ' parent answer\n' }), { status: 'accepted', duplicate: false });
  assert.deepEqual(f.sent, [{ userId: 'owner', contextToken: 'fake-context-m1', text: ' parent answer\n' }]);
  assert.deepEqual(store.data.account, f.account);
  assert.equal(store.data.requests[claim.requestId].localQueue.status, 'done');
  assert.equal(store.data.requests[claim.requestId].contextToken, undefined);
});

test('exact marker filter claims only bound-owner match and leaves older ordinary messages pending', async (t) => {
  const f = await fixture(t);
  const marker = 'DOT-WX-20261002-0810';
  const old = await f.bridge.incoming(message('ordinary'));
  const near = await f.bridge.incoming({ ...message('near-match'), text: marker + ' extra' });
  const foreign = await f.bridge.incoming({ ...message('foreign', 'other'), text: marker });
  assert.equal(foreign.requestId, null);
  const matching = await f.bridge.incoming({ ...message('test-marker'), text: marker });
  const received = await f.queue.wait({ timeoutMs: 100, matchText: marker });
  assert.equal(received.request.requestId, matching.requestId);
  assert.equal(received.request.ownerMatched, true);
  assert.equal(f.store.data.requests[old.requestId].localQueue.status, 'pending');
  assert.equal(f.store.data.requests[near.requestId].localQueue.status, 'pending');
  await assert.rejects(f.queue.claim({ matchText: { text: marker } }), /invalid exact text filter/);
});

test('filtered wait ignores nonmatching arrivals and wakes on delayed exact match', async (t) => {
  const f = await fixture(t);
  const marker = 'DOT-WX-20261002-0810';
  const first = await f.bridge.incoming(message('older'));
  const waiting = f.queue.wait({ timeoutMs: 2000, matchText: marker });
  const ordinary = await f.bridge.incoming(message('nonmatching-arrival'));
  const produced = new Promise((resolve, reject) => setTimeout(() => f.bridge.incoming({ ...message('late-test'), text: marker }).then(resolve, reject), 25));
  const [received, result] = await Promise.all([waiting, produced]);
  assert.equal(received.request.requestId, result.requestId);
  assert.equal(f.store.data.requests[first.requestId].localQueue.status, 'pending');
  assert.equal(f.store.data.requests[ordinary.requestId].localQueue.status, 'pending');
});

test('expired claims can be recovered, renewed and released; old claims cannot send', async (t) => {
  const f = await fixture(t);
  await f.bridge.incoming(message());
  const first = await f.queue.claim({ leaseMs: 1000 });
  await f.queue.ack(first);
  f.advance(1001);
  const store = await new JsonStore(f.path).load();
  const bridge = new Bridge({ store, ...f.options });
  await bridge.recover();
  const queue = new LocalQueue(bridge);
  const next = await queue.claim({ leaseMs: 1000 });
  assert.equal(next.requestId, first.requestId);
  assert.notEqual(next.claimId, first.claimId);
  await assert.rejects(queue.reply({ ...first, text: 'stale' }), /claim does not match/);
  f.advance(100);
  assert.equal((await queue.renew(next)).status, 'renewed');
  await queue.release(next);
  assert.notEqual((await queue.claim()).claimId, next.claimId);
  assert.equal(f.sent.length, 0);
});

test('concurrent replies send once; matching accepted reply is idempotent and changed text fails', async (t) => {
  const f = await fixture(t);
  await f.bridge.incoming(message());
  const claim = await f.queue.claim();
  let releaseSend;
  let started;
  const sending = new Promise((resolve) => { started = resolve; });
  const completed = new Promise((resolve) => { releaseSend = resolve; });
  f.client.sendText = async () => { f.sent.push('send'); started(); await completed; };
  const first = f.queue.reply({ ...claim, text: 'answer' });
  await sending;
  await assert.rejects(f.queue.reply({ ...claim, text: 'answer' }), /sending.*manual reconciliation/);
  releaseSend();
  assert.equal((await first).duplicate, false);
  assert.equal((await f.queue.reply({ ...claim, text: 'answer' })).duplicate, true);
  await assert.rejects(f.queue.reply({ ...claim, text: 'changed' }), /different reply/);
  assert.equal(f.sent.length, 1);
});

test('uncertain transport and interrupted sending are blocked after restart without retry', async (t) => {
  const f = await fixture(t);
  await f.bridge.incoming(message());
  const claim = await f.queue.claim();
  f.client.sendText = async () => { f.sent.push('attempt'); throw new Error('fake timeout'); };
  await assert.rejects(f.queue.reply({ ...claim, text: 'answer' }), /unconfirmed/);
  await f.bridge.incoming(message('m2'));
  const second = await f.queue.claim();
  await f.store.update((state) => { state.requests[second.requestId].status = 'sending'; });
  const store = await new JsonStore(f.path).load();
  const bridge = new Bridge({ store, ...f.options });
  await bridge.recover();
  const queue = new LocalQueue(bridge);
  assert.equal(await queue.claim(), null);
  for (const item of [claim, second]) {
    assert.equal(store.data.requests[item.requestId].status, 'unconfirmed');
    await assert.rejects(queue.reply({ ...item, text: 'answer' }), /unconfirmed.*manual reconciliation/);
  }
  assert.equal(f.sent.length, 1);
});

test('expired request content is removed and cannot send; tombstone deduplicates until retention ends', async (t) => {
  const f = await fixture(t);
  const item = message();
  await f.bridge.incoming(item);
  const claim = await f.queue.claim();
  f.advance(MAX_AGE);
  await f.bridge.recover();
  assert.equal(f.store.data.requests[claim.requestId].status, 'expired');
  assert.equal(f.store.data.requests[claim.requestId].text, undefined);
  assert.equal(f.store.data.requests[claim.requestId].contextToken, undefined);
  assert.equal((await f.bridge.incoming(item)).duplicate, true);
  await assert.rejects(f.queue.reply({ ...claim, text: 'late' }), /expired/);
  f.advance(30 * MAX_AGE);
  await f.bridge.recover();
  assert.equal(f.store.data.requests[claim.requestId], undefined);
});

test('wait cancellation removes listeners and local IPC forbids overriding private mappings', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const waiting = f.queue.wait({ timeoutMs: 0 }, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(f.queue.events.listenerCount('changed'), 0);
  const socketPath = join(f.dir, 'queue.sock');
  const server = await startLocalServer(f.queue, { socketPath });
  t.after(() => server.close());
  assert.equal((await stat(socketPath)).mode & 0o077, 0);
  const result = await localCall(socketPath, { command: 'status' });
  assert.deepEqual(result, { running: true, mode: 'local-queue', ownerBound: true, accountConfigured: true, counts: {}, normalReceptionActivated: true, activationAt: new Date(f.store.data.localQueueActivation.at).toISOString() });
  await assert.rejects(async () => localCall(socketPath, { command: 'reply', requestId: 'wx_any', claimId: 'any', text: 'reply', userId: 'other' }), /invalid local command/);
});

function childResult(child, stdin) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  if (stdin !== undefined) child.stdin.end(stdin);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('offline daemon/CLI integration: status, wait, stdin reply, dedup, stop and restart', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const socketPath = join(f.dir, 'queue.sock');
  const sendPath = join(f.dir, 'fake-sends.json');
  const preload = join(f.dir, 'fake-fetch.mjs');
  await writeFile(preload, `import { writeFile } from 'node:fs/promises';
let first = true, sends = 0;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  if (path === '/ilink/bot/sendmessage') {
    await writeFile(${JSON.stringify(sendPath)}, JSON.stringify({ sends: ++sends, body: JSON.parse(options.body) }));
    return { ok: true, json: async () => ({ ret: 0 }) };
  }
  if (path !== '/ilink/bot/getupdates') throw new Error('all other network requests forbidden');
  if (first) { first = false; return { ok: true, json: async () => ({ msgs: [${JSON.stringify(raw('integration'))}], get_updates_buf: 'fake-cursor' }) }; }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ msgs: [] }) }), 100);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled fake poll')); }, { once: true });
    if (options.signal.aborted) { clearTimeout(timer); reject(new Error('cancelled fake poll')); }
  });
};
`, { mode: 0o600 });
  const env = { ...process.env, WECHAT_CODEX_STATE: f.path, WECHAT_CODEX_SOCKET: socketPath };
  let daemon;
  let daemonResult;
  const start = async () => {
    daemon = spawn(process.execPath, ['--import', preload, 'src/main.mjs', '--live', '--mode', 'local-queue'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    daemonResult = childResult(daemon);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { return await localCall(socketPath, { command: 'status' }); }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        if (daemon.exitCode !== null) throw new Error('offline daemon failed before ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error('offline daemon did not start');
  };
  t.after(async () => { if (daemon?.exitCode === null) daemon.kill('SIGTERM'); await daemonResult; });
  const cli = async (args, input) => {
    const result = await childResult(spawn(process.execPath, ['src/local.mjs', ...args, '--live'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] }), input);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  assert.equal((await start()).ownerBound, true);
  assert.deepEqual(await cli(['binding-check']), { ownerBound: true, accountConfigured: true });
  const unmatched = await cli(['wait', '--timeout-ms', '20', '--match-text', 'different literal']);
  assert.equal(unmatched.status, 'timeout');
  const received = await cli(['wait', '--timeout-ms', '2000', '--match-text', 'text integration']);
  assert.equal(received.status, 'claimed');
  assert.equal(received.request.text, 'text integration');
  assert.equal(received.request.ownerMatched, true);
  const pollStatus = await cli(['status']);
  assert.ok(pollStatus.receive.successfulPolls >= 1);
  assert.equal(pollStatus.receive.lastFailure, null);
  const input = JSON.stringify({ requestId: received.request.requestId, claimId: received.request.claimId, text: 'exact parent reply' });
  await cli(['ack'], JSON.stringify(received));
  assert.equal((await cli(['reply'], input)).duplicate, false);
  assert.equal((await cli(['reply'], input)).duplicate, true);
  const sent = JSON.parse(await readFile(sendPath, 'utf8'));
  assert.equal(sent.sends, 1);
  assert.equal(sent.body.msg.to_user_id, 'owner');
  assert.equal(sent.body.msg.context_token, 'fake-context-integration');
  assert.equal(sent.body.msg.item_list[0].text_item.text, 'exact parent reply');
  assert.equal((await cli(['stop'])).status, 'stopping');
  const stopped = await daemonResult;
  assert.equal(stopped.code, 0, stopped.stderr);
  for (const value of ['fake-only-token', 'fake-context-integration', 'text integration']) assert.equal(stopped.stdout.includes(value), false);
  const status = await start();
  assert.equal(status.ownerBound, true);
  assert.equal((await cli(['wait', '--timeout-ms', '20'])).status, 'timeout');
  assert.equal((await cli(['status'])).counts.accepted, 1);
  await cli(['stop']);
  assert.equal((await daemonResult).code, 0);
});

test('state lock excludes concurrent pollers and recovers only a dead process lock', async (t) => {
  const f = await fixture(t);
  const release = await acquireLock(f.path);
  await assert.rejects(acquireLock(f.path), /another bridge/);
  await release();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const deadPid = child.pid;
  await childResult(child);
  await writeFile(`${f.path}.lock`, String(deadPid), { mode: 0o600 });
  const recovery = await Promise.allSettled([acquireLock(f.path), acquireLock(f.path)]);
  const winners = recovery.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(recovery.filter((result) => result.status === 'rejected').length, 1);
  await winners[0].value();
});

test('activation is persistent and excludes all old pending, including same-millisecond arrival', async (t) => {
  const f = await fixture(t, { activate: false });
  const old = await f.bridge.incoming(message('old'));
  await assert.rejects(f.queue.claim(), /not activated/);
  const enabled = await f.queue.activate({ activationAt: 'now' });
  const fresh = await f.bridge.incoming(message('new'));
  assert.equal(f.store.data.requests[old.requestId].createdAt, f.store.data.requests[fresh.requestId].createdAt);
  assert.equal((await f.queue.activate({ activationAt: 'now' })).duplicate, true);
  assert.equal((await f.queue.claim()).requestId, fresh.requestId);
  assert.equal(f.store.data.requests[old.requestId].localQueue.status, 'pending');
  const store = await new JsonStore(f.path).load();
  assert.equal(new LocalQueue(new Bridge({ store, ...f.options })).status().activationAt, enabled.activationAt);
});

test('stable worker resumes only its request and exact expired handle recovers after restart', async (t) => {
  const f = await fixture(t);
  const other = await f.bridge.incoming(message('older-other'));
  const original = await f.bridge.incoming(message('original'));
  const workerId = randomUUID();
  const first = await f.queue.claim({ matchText: 'text original', workerId, leaseMs: 1000 });
  const concurrent = await Promise.all([f.queue.claim({ workerId }), f.queue.claim({ workerId })]);
  assert.ok(concurrent.every((value) => value.claimId === first.claimId));
  await f.queue.ack(first);
  f.advance(1001);
  const store = await new JsonStore(f.path).load();
  const bridge = new Bridge({ store, ...f.options });
  await bridge.recover();
  const queue = new LocalQueue(bridge);
  const resumed = await queue.reclaim(first);
  assert.equal(resumed.request.requestId, original.requestId);
  assert.notEqual(resumed.request.claimId, first.claimId);
  assert.equal(store.data.requests[other.requestId].localQueue.status, 'pending');
  await assert.rejects(queue.reply({ ...first, text: 'stale' }), /claim does not match/);
  await queue.reply({ ...resumed.request, text: ' recovered parent reply\n' });
  assert.equal(f.sent[0].contextToken, 'fake-context-original');
  assert.equal(f.sent[0].text, ' recovered parent reply\n');
});

async function ipcFixture(t) {
  const f = await fixture(t);
  const socket = join(f.dir, 'queue.sock');
  let server = await startLocalServer(f.queue, { socketPath: socket });
  t.after(() => server?.close());
  const controls = [];
  t.after(async () => { for (const dir of controls) await rm(dir, { recursive: true, force: true }); });
  let started;
  const startReceive = (options = {}) => {
    const ready = new Promise((resolve) => { started = resolve; });
    const result = receiveOnce(socket, { ...options, emit: (event) => { controls.push(event.controlDir); started(event); } });
    return { ready, result };
  };
  return { ...f, socket, startReceive, controls,
    disconnect: async () => { await server.close(); server = null; },
    reconnect: async () => { server = await startLocalServer(f.queue, { socketPath: socket }); },
  };
}

test('receive stays inside Node across empty timeouts, saves private claim, returns original text and replies once', async (t) => {
  const f = await ipcFixture(t);
  const receiving = f.startReceive({ timeoutMs: 10 });
  const { controlDir } = await receiving.ready;
  let ended = false;
  receiving.result.then(() => { ended = true; });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(ended, false);
  const exact = '  owner original\nline two  ';
  const item = raw('whitespace');
  item.item_list[0].text_item.text = exact;
  assert.equal(normalizeText(item).text, exact);
  await f.bridge.incoming(normalizeText(item));
  const claim = await receiving.result;
  assert.equal(claim.text, exact);
  assert.equal(claim.claimFile, join(controlDir, 'claim.json'));
  assert.equal((await stat(claim.claimFile)).mode & 0o077, 0);
  const privateClaim = JSON.parse(await readFile(claim.claimFile, 'utf8'));
  assert.equal(f.store.data.requests[claim.requestId].localQueue.status, 'acked');
  assert.equal(JSON.stringify(privateClaim).includes('fake-context-whitespace'), false);
  const reply = { requestId: claim.requestId, claimFile: claim.claimFile, text: ' parent exact\n' };
  assert.equal((await respondFromClaim(f.socket, reply)).duplicate, false);
  assert.equal((await respondFromClaim(f.socket, reply)).duplicate, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, reply.text);
  await assert.rejects(respondFromClaim(f.socket, { ...reply, text: 'changed' }), /different parent reply/);
  assert.equal(JSON.parse(await readFile(join(controlDir, 'outbox.json'), 'utf8')).outcome, 'accepted');
  assert.equal((await receiveOnce(f.socket, { controlDir, emit: () => {} })).status, 'already_finished');
});

test('receive reconnects after socket closes and cancellation exits without a message or send', async (t) => {
  const f = await ipcFixture(t);
  const receiving = f.startReceive({ reconnectMs: 2500 });
  const { controlDir } = await receiving.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.disconnect();
  await f.reconnect();
  await f.bridge.incoming(message('after-restart'));
  assert.equal((await receiving.result).text, 'text after-restart');
  const waiting = f.startReceive();
  const next = await waiting.ready;
  assert.equal((await cancelReceive(f.socket, { controlDir: next.controlDir })).status, 'cancellation_requested');
  assert.equal((await waiting.result).status, 'cancelled');
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.events.listenerCount('changed'), 0);
  const aborted = new AbortController();
  aborted.abort(new Error('already cancelled'));
  await assert.rejects(localCall(f.socket, { command: 'status' }, { signal: aborted.signal }), /already cancelled/);
  assert.equal((await stat(controlDir)).mode & 0o077, 0);
});

test('outbox reconciles lost success response by exact digest and never retries uncertain sends', async (t) => {
  const f = await ipcFixture(t);
  const receiving = f.startReceive();
  await receiving.ready;
  await f.bridge.incoming(message('lost-success'));
  const claim = await receiving.result;
  const original = f.queue.reply.bind(f.queue);
  f.queue.reply = async (input) => { await original(input); throw new Error('fake lost success response'); };
  const reply = { ...claim, text: 'exact same parent reply' };
  assert.equal((await respondFromClaim(f.socket, reply)).responseLost, true);
  assert.equal(f.sent.length, 1);
  await unlink(join(f.controls[0], 'outbox.json'));
  await assert.rejects(respondFromClaim(f.socket, { ...reply, text: 'different' }), /different reply was already accepted/);
  f.queue.reply = original;
  const next = f.startReceive();
  await next.ready;
  await f.bridge.incoming(message('uncertain'));
  const second = await next.result;
  let attempts = 0;
  f.client.sendText = async () => { attempts++; throw new Error('fake transport timeout'); };
  const uncertain = { ...second, text: 'parent reply for uncertain transport' };
  assert.equal((await respondFromClaim(f.socket, uncertain)).manualReconciliationRequired, true);
  assert.equal((await respondFromClaim(f.socket, uncertain)).status, 'unconfirmed');
  assert.equal(attempts, 1);
});

test('CLI supports activate, receive, parent respond and sequential rearm using fake local IPC only', { timeout: 15000 }, async (t) => {
  const f = await ipcFixture(t);
  const env = { ...process.env, WECHAT_CODEX_STATE: f.path, WECHAT_CODEX_SOCKET: f.socket };
  const run = (args, input) => {
    const child = spawn(process.execPath, ['src/local.mjs', ...args, '--live'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    return { child, result: childResult(child, input) };
  };
  const activated = await run(['activate'], JSON.stringify({ activationAt: 'now' })).result;
  assert.equal(JSON.parse(activated.stdout).duplicate, true);
  for (let index = 0; index < 2; index++) {
    const receiving = run(['receive']);
    t.after(() => { if (receiving.child.exitCode === null) receiving.child.kill('SIGTERM'); });
    const ready = new Promise((resolve) => {
      let output = '';
      receiving.child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
    });
    const event = await ready;
    f.controls.push(event.controlDir);
    await f.bridge.incoming(message(`round-${index}`));
    const received = await receiving.result;
    assert.equal(received.code, 0, received.stderr);
    const claim = JSON.parse(received.stdout.trim().split('\n').at(-1));
    assert.equal(claim.text, `text round-${index}`);
    const reply = await run(['respond'], JSON.stringify({ requestId: claim.requestId, claimFile: claim.claimFile, text: `fake parent round ${index}` })).result;
    assert.equal(reply.code, 0, reply.stderr);
    assert.equal(JSON.parse(reply.stdout).status, 'accepted');
  }
  assert.equal(f.sent.length, 2);
});
