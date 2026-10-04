import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { pollOnce, bindOwner, WechatClient } from '../src/wechat.mjs';
import { createMcpHandler } from '../src/mcp.mjs';
import { resolveCallback } from '../src/webhook.mjs';

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const delivery = { mode: 'webhook', url: 'https://callback.example.test/events', secret };
const resolver = async () => [{ address: '8.8.8.8', family: 4 }];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-wechat-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = await new JsonStore(path).load();
  await store.update((s) => { s.account = { token: 'fake-token', baseUrl: 'https://ilinkai.weixin.qq.com', accountId: 'bot-a', boundUserId: 'owner', cursor: '' }; });
  const posts = [];
  const sends = [];
  const client = { getUpdates: async () => ({ get_updates_buf: 'cursor-1', msgs: [] }), sendText: async (_account, request, text) => { sends.push({ request, text }); return { ret: 0 }; } };
  const post = async (_url, value) => {
    const body = JSON.parse(value.body);
    posts.push({ body, headers: value.headers });
    return { ok: true, status: 200, body: body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '' };
  };
  const bridge = new Bridge({ store, client, resolver, post });
  return { path, store, posts, sends, client, bridge };
}

test('bound sender reaches the MCP event and one idempotent reply', async (t) => {
  const f = await fixture(t);
  const handler = createMcpHandler(f.bridge);
  const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
  const subscribe = await handler({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: { ...meta, name: 'wechat.message.created', arguments: {}, delivery } });
  assert.ok(subscribe.result.id.startsWith('sub_'));
  assert.equal(f.posts.length, 1);
  f.client.getUpdates = async () => ({ get_updates_buf: 'cursor-1', msgs: [
    { message_type: 1, from_user_id: 'stranger', message_id: 'm0', context_token: 'stranger-secret', item_list: [{ type: 1, text_item: { text: 'ignore' } }] },
    { message_type: 1, from_user_id: 'owner', message_id: 'm1', context_token: 'context-1', item_list: [{ type: 1, text_item: { text: 'hello' } }] },
  ] });
  assert.equal(await pollOnce(f.client, f.store, f.bridge), 1);
  await f.bridge.deliverPending();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].body.data.text, 'hello');
  assert.equal(f.posts[1].headers['webhook-id'], f.posts[1].body.eventId);
  const requestId = f.posts[1].body.data.requestId;
  const answer = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { ...meta, name: 'reply_to_wechat_request', arguments: { requestId, text: 'Hi' } } });
  assert.equal(answer.result.structuredContent.status, 'accepted');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].request.contextToken, 'context-1');
  const duplicate = await f.bridge.reply(requestId, 'Hi');
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.sends.length, 1);
  assert.equal((await readFile(f.path, 'utf8')).includes('stranger-secret'), false);
  const restarted = await new JsonStore(f.path).load();
  assert.equal(restarted.data.account.cursor, 'cursor-1');
  assert.equal(restarted.data.requests[requestId].status, 'accepted');
});

test('failed delivery retries same event id; uncertain send is not retried', async (t) => {
  const f = await fixture(t);
  let fail = false;
  const originalPost = f.bridge.post;
  f.bridge.post = async (...args) => fail ? { ok: false, status: 503, body: '' } : originalPost(...args);
  await f.bridge.subscribe({ name: 'wechat.message.created', arguments: {}, delivery });
  fail = true;
  const result = await f.bridge.incoming({ userId: 'owner', messageId: 'm2', contextToken: 'ctx', text: 'hello', timestamp: new Date().toISOString() });
  await f.bridge.deliverPending();
  const item = f.store.data.requests[result.requestId];
  assert.equal(item.targets[Object.keys(item.targets)[0]].attempts, 1);
  fail = false;
  await f.store.update((s) => { s.requests[result.requestId].targets[Object.keys(item.targets)[0]].nextAt = 0; });
  await f.bridge.deliverPending();
  assert.equal(f.posts.at(-1).body.eventId, item.eventId);
  f.client.sendText = async () => { throw new Error('network timeout'); };
  await assert.rejects(f.bridge.reply(result.requestId, 'answer'), /unconfirmed/);
  await assert.rejects(f.bridge.reply(result.requestId, 'answer'), /manual reconciliation/);
});

test('binding consumes only the matching fresh phrase and does not create an event', async (t) => {
  const f = await fixture(t);
  await f.store.update((s) => { s.account.boundUserId = null; });
  const client = { getUpdates: async () => ({ get_updates_buf: 'bind-cursor', msgs: [
    { message_type: 1, from_user_id: 'owner', message_id: 'bind-1', context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'wechat-bind-secret-phrase' } }] },
  ] }) };
  await bindOwner(client, f.store, 'wechat-bind-secret-phrase');
  assert.equal(f.store.data.account.boundUserId, 'owner');
  assert.equal(f.store.data.account.cursor, 'bind-cursor');
  assert.deepEqual(f.store.data.requests, {});
});

test('WeChat client sends the request context token to the official endpoint shape', async () => {
  let observed;
  const client = new WechatClient({ fetchImpl: async (url, options) => { observed = { url: url.toString(), options }; return { ok: true, json: async () => ({ ret: 0 }) }; } });
  await client.sendText({ token: 'fake', baseUrl: 'https://ilinkai.weixin.qq.com' }, { userId: 'owner', contextToken: 'context' }, 'Hi');
  assert.equal(new URL(observed.url).pathname, '/ilink/bot/sendmessage');
  assert.equal(JSON.parse(observed.options.body).msg.context_token, 'context');
  assert.equal(observed.options.redirect, 'error');
});

test('callback validation rejects local and private destinations', async () => {
  await assert.rejects(resolveCallback('http://callback.example.test/events', resolver), /public HTTPS/);
  await assert.rejects(resolveCallback('https://127.0.0.1/events', resolver), /public HTTPS/);
  await assert.rejects(resolveCallback('https://[::1]/events', resolver), /public HTTPS/);
  await assert.rejects(resolveCallback('https://callback.example.test/events', async () => [{ address: '10.0.0.1', family: 4 }]), /not public/);
  await assert.rejects(resolveCallback('https://callback.example.test/events', async () => [{ address: '::ffff:127.0.0.1', family: 6 }]), /not public/);
});

test('a second dot callback cannot subscribe while the first is active', async (t) => {
  const f = await fixture(t);
  await f.bridge.subscribe({ name: 'wechat.message.created', arguments: {}, delivery });
  await assert.rejects(f.bridge.subscribe({ name: 'wechat.message.created', arguments: {},
    delivery: { ...delivery, url: 'https://second.example.test/events' } }), /another active dot subscription/);
  assert.equal(Object.keys(f.store.data.subscriptions).length, 1);
});
