import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecClient, execArguments } from '../src/exec-client.mjs';
import { ExecController } from '../src/exec-controller.mjs';
import { NativeJournal } from '../src/native-journal.mjs';
import { MODEL } from '../src/native-client.mjs';
import { marker } from '../src/native-controller.mjs';
import { JsonStore } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { LocalQueue } from '../src/local-queue.mjs';
import { startLocalServer } from '../src/local-ipc.mjs';
import { receiveOnce } from '../src/receive-client.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wx-exec-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function fakeSpawn(finish) {
  return (_executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    let prompt = '';
    child.stdin.on('data', chunk => { prompt += chunk; });
    child.stdin.on('finish', () => { void finish({ child, args, options, prompt }); });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}
function events(child, values) { for (const value of values) child.stdout.write(JSON.stringify(value) + '\n'); }

test('exec accepts an exact existing UUID, uses stdin/private output and keeps explicit policy/model', async t => {
  const dir = await directory(t), outputPath = join(dir, 'final.txt');
  const privateText = 'private-test-input';
  let saved = false;
  const client = new ExecClient({ spawnChild: fakeSpawn(async ({ child, args, options, prompt }) => {
    assert.equal(saved, true); assert.equal(prompt, privateText); assert.equal(args.includes(privateText), false);
    assert.equal(options.shell, false); assert.equal(args.includes('--last'), false);
    assert.equal(args[args.indexOf('--model') + 1], MODEL);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('approval_policy="on-request"')); assert.ok(args.includes('approvals_reviewer="user"'));
    assert.equal(args.at(-2), threadId); assert.equal(args.at(-1), '-');
    child.stderr.write('WARNING: harmless PATH aliases: Operation not permitted\n');
    child.stdout.write('{"type":"thread.sta'); child.stdout.write(`rted","thread_id":"${threadId}"}\n`);
    events(child, [{ type: 'turn.started' },
      { type: 'item.completed', item: { id: 'comment', type: 'agent_message', phase: 'commentary', text: 'working' } },
      { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: '最终答复' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, arbitrary: 'private' } }]);
    await writeFile(outputPath, '最终答复\n'); child.emit('close', 0);
  }) });
  const result = await client.run({ threadId, cwd: dir, outputPath, input: [{ type: 'text', text: privateText }],
    onStarted: async () => { saved = true; } });
  assert.equal(result.reply, '最终答复'); assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal((await stat(outputPath)).mode & 0o077, 0);
  assert.throws(() => execArguments({ threadId: '--last', cwd: dir, outputPath }), /target_required/);
});

test('exit success without turn completion or with an inconsistent final file cannot cause a reply', async t => {
  const dir = await directory(t);
  for (const mode of ['missing_completion', 'mismatch', 'failed']) {
    const outputPath = join(dir, mode + '.txt');
    const client = new ExecClient({ spawnChild: fakeSpawn(async ({ child }) => {
      events(child, [{ type: 'thread.started', thread_id: threadId }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: 'answer' } },
        ...(mode === 'missing_completion' ? [] : [{ type: 'turn.completed' }])]);
      await writeFile(outputPath, mode === 'mismatch' ? 'different' : 'answer');
      child.emit('close', mode === 'failed' ? 1 : 0);
    }) });
    await assert.rejects(client.run({ threadId, cwd: dir, outputPath, input: [{ type: 'text', text: 'test' }] }), /unconfirmed|reply_invalid/);
  }
});

test('a different thread or an aborted execution is killed and never returns a reply', async t => {
  const dir = await directory(t);
  for (const mode of ['wrong-thread', 'abort']) {
    const abort = new AbortController();
    const client = new ExecClient({ spawnChild: fakeSpawn(({ child }) => {
      if (mode === 'abort') abort.abort();
      else events(child, [{ type: 'thread.started', thread_id: 'other-thread' }]);
    }) });
    await assert.rejects(client.run({ threadId, cwd: dir, outputPath: join(dir, mode + '.txt'),
      input: [{ type: 'text', text: 'test' }], signal: abort.signal }), /mismatch|unconfirmed/);
  }
});

async function fixture(t) {
  const dir = await directory(t), statePath = join(dir, 'state.json'), socketPath = join(dir, 'queue.sock');
  const store = await new JsonStore(statePath).load();
  await store.update(data => { data.account = { token: 'fake-only', accountId: 'fake-bot', boundUserId: 'owner' }; });
  const sent = [];
  const bridge = new Bridge({ store, mode: 'local-queue', client: { sendText: async (_a, _r, text) => { sent.push(text); } } });
  const queue = new LocalQueue(bridge);
  const message = (id, userId = 'owner') => ({ messageId: id, userId, contextToken: 'fake-only', text: id, timestamp: new Date().toISOString() });
  const old = await bridge.incoming(message('pre-activation'));
  await queue.activate({ activationAt: 'now' });
  const server = await startLocalServer(queue, { socketPath });
  t.after(() => server.close());
  const journal = await new NativeJournal(join(dir, 'codex-session.json')).load();
  await journal.update(data => { data.threadId = threadId; data.probe = { stage: 'completed' }; });
  const turns = [];
  const client = new EventEmitter();
  client.requireModel = async () => ({ model: MODEL });
  client.request = async (method, params) => {
    assert.equal(params.threadId, threadId);
    if (method === 'thread/read') return { thread: { id: threadId, model: MODEL, turns } };
    if (method === 'thread/queue/list') return { data: [] };
    throw new Error('unexpected_model_mutation');
  };
  const exec = { calls: 0, run: async ({ input, onStarted }) => {
    exec.calls++; await onStarted?.();
    const reply = 'reply-' + exec.calls;
    turns.push({ id: 'turn-' + exec.calls, status: 'completed', items: [
      { id: 'u' + exec.calls, type: 'userMessage', content: input },
      { id: 'a' + exec.calls, type: 'agentMessage', phase: 'final_answer', text: reply }] });
    return { reply };
  } };
  const controller = new ExecController({ client, journal, exec, socketPath, statePath, cwd: dir });
  return { dir, bridge, queue, journal, controller, turns, exec, sent, old, message, store, socketPath };
}

test('migration preserves uncertain request; serial CLI replies skip it across lease expiry and restart', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const at = f.store.data.localQueueActivation.at;
  const uncertain = await f.bridge.incoming(f.message('uncertain'));
  const claim = await f.queue.claim({ leaseMs: 1000 });
  await f.queue.release(claim); // An expired/released claim must still be excluded.
  await f.journal.update(data => { data.active = { requestId: uncertain.requestId, stage: 'submitting', delivery: 'cli_queue' };
    data.phase = 'paused'; data.pauseReason = 'native_queue_submission_unconfirmed'; });
  await f.controller.prepare();
  assert.equal(f.journal.data.quarantined.length, 1); assert.equal(f.journal.data.active, null);
  const restored = await new NativeJournal(f.journal.path).load(); f.controller.journal = restored;
  await f.bridge.incoming(f.message('m1')); await f.bridge.incoming(f.message('m1'));
  await f.bridge.incoming(f.message('foreign', 'other')); await f.bridge.incoming(f.message('m2'));
  await restored.update(data => { data.phase = 'prepared'; delete data.pauseReason; });
  const abort = new AbortController();
  f.controller.emit = event => { if (event.event === 'native_wechat_reply_accepted' && f.sent.length === 2) abort.abort(); };
  await f.controller.run(abort.signal);
  assert.deepEqual(f.sent, ['reply-1', 'reply-2']); assert.equal(f.exec.calls, 2);
  assert.equal(f.store.data.requests[uncertain.requestId].status, 'pending');
  assert.equal(f.store.data.requests[f.old.requestId].status, 'pending');
  assert.equal(f.store.data.localQueueActivation.at, at);
  assert.equal(restored.data.quarantined[0].stage, 'submitting');
});

test('interrupted exec recovers only a unique completed original turn, never invokes CLI again', async t => {
  const f = await fixture(t);
  await f.bridge.incoming(f.message('m1'));
  await f.controller.claim();
  const id = f.journal.data.active.requestId;
  await f.journal.update(data => { data.active.stage = 'running'; data.active.delivery = 'codex_exec'; });
  await assert.rejects(f.controller.processActive(), /submission_unconfirmed/);
  assert.equal(f.exec.calls, 0); assert.equal(f.sent.length, 0);
  f.turns.push({ id: 'saved-turn', status: 'completed', items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: marker(id) + '\nowner input' }] },
    { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'saved reply' }] });
  await f.controller.processActive();
  assert.deepEqual(f.sent, ['saved reply']); assert.equal(f.exec.calls, 0);
});

test('receive exclusions work over IPC and cannot revive an excluded saved claim', async t => {
  const f = await fixture(t);
  const first = await f.bridge.incoming(f.message('blocked'));
  await f.bridge.incoming(f.message('available'));
  const received = await receiveOnce(f.socketPath, { timeoutMs: 100, excludeRequestIds: [first.requestId], emit: () => {} });
  assert.equal(received.text, 'available');
  await assert.rejects(receiveOnce(f.socketPath, { controlDir: join(received.claimFile, '..'),
    excludeRequestIds: [received.requestId], emit: () => {} }), /quarantined_request/);
  await assert.rejects(f.queue.claim({ excludeRequestIds: ['invalid'] }), /invalid request exclusions/);
});
