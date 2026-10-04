import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { postCallback, resolveCallback, signWebhook, validateSecret, equalText } from './webhook.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const MAX_AGE = 24 * 60 * 60 * 1000;
const EVENT = 'wechat.message.created';
const textValue = (value, max, label, preserve = false) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid ${label}`);
  return preserve ? value : value.trim();
};

export class Bridge {
  constructor({ store, client, post = postCallback, resolver = lookup, clock = Date.now, mode = 'webhook' }) {
    if (!['webhook', 'local-queue'].includes(mode)) throw new Error('invalid bridge mode');
    this.store = store;
    this.client = client;
    this.post = post;
    this.resolver = resolver;
    this.clock = clock;
    this.mode = mode;
    this.onIncoming = null;
    this.delivery = null;
  }

  listEvents() {
    if (this.mode === 'local-queue') return [];
    return [{ name: EVENT, description: 'A new text message from the owner-bound WeChat sender.', delivery: ['webhook'],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      payloadSchema: { type: 'object', properties: { requestId: { type: 'string' }, text: { type: 'string' }, timestamp: { type: 'string' } },
        required: ['requestId', 'text', 'timestamp'], additionalProperties: false } }];
  }

  recordIncoming(state, { userId, messageId, contextToken, text, timestamp, attachments = [] }) {
    if (userId !== state.account?.boundUserId) return null;
    if (typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 4000 || !messageId || !contextToken) return null;
    if (attachments.length && this.mode !== 'local-queue') return null;
    const requestId = `wx_${hash(`${state.account.accountId}\0${userId}\0${messageId}`)}`;
    if (state.requests[requestId]) return null;
    const targets = Object.values(state.subscriptions).filter((s) => s.expiresAt > this.clock()).map((s) => s.id);
    if (this.mode === 'local-queue') state.localIngressSequence = (state.localIngressSequence || 0) + 1;
    state.requests[requestId] = { requestId, eventId: `evt_${requestId}`, userId, messageId: String(messageId), contextToken, text, timestamp,
      createdAt: this.clock(), status: 'pending', route: this.mode,
      ...(attachments.length ? { attachments } : {}),
      targets: this.mode === 'webhook' ? Object.fromEntries(targets.map((id) => [id, { attempts: 0, nextAt: 0 }])) : {},
      ...(this.mode === 'local-queue' ? { ingressSequence: state.localIngressSequence, localQueue: { status: 'pending', attempts: 0 } } : {}) };
    return requestId;
  }

  async incoming(message) {
    let result;
    await this.store.update((state) => { result = this.recordIncoming(state, message); });
    if (result) this.notifyIncoming();
    return { requestId: result, duplicate: !result };
  }

  notifyIncoming() {
    this.onIncoming?.();
    if (this.mode === 'webhook') void this.deliverPending().catch(() => {});
  }

  prune(state) {
    for (const [id, request] of Object.entries(state.requests)) {
      const age = this.clock() - request.createdAt;
      if (age > 30 * MAX_AGE) { delete state.requests[id]; continue; }
      if (age >= MAX_AGE) {
        delete request.text;
        delete request.contextToken;
        for (const item of request.attachments || []) delete item.source;
        delete request.targets;
        if (request.status === 'pending') request.status = 'expired';
        if (request.localQueue && !['done', 'blocked'].includes(request.localQueue.status)) request.localQueue.status = 'expired';
      }
    }
  }

  async recover() {
    await this.store.update((state) => {
      this.prune(state);
      for (const request of Object.values(state.requests)) {
        if (request.status === 'sending') {
          request.status = 'unconfirmed';
          if (request.localQueue) request.localQueue.status = 'blocked';
        }
        const queue = request.localQueue;
        if (request.status === 'pending' && queue && ['claimed', 'acked'].includes(queue.status) && queue.leaseExpiresAt <= this.clock()) {
          request.localQueue = { status: 'pending', attempts: queue.attempts, expiredClaimId: queue.claimId, leaseMs: queue.leaseMs, workerId: queue.workerId };
        }
      }
    });
  }

  subscriptionId(name, url) {
    const accountId = this.store.data.account?.accountId;
    if (!accountId) throw new Error('WeChat account not configured');
    return `sub_${hash(`${accountId}\0${name}\0{}\0${url}`)}`;
  }

  async subscribe({ name, arguments: args = {}, delivery, ttlMs, cursor } = {}) {
    if (this.mode !== 'webhook') throw new Error('webhooks disabled in local-queue mode');
    if (name !== EVENT || !args || Object.keys(args).length || cursor) throw new Error('unsupported event or filter');
    if (delivery?.mode !== 'webhook') throw new Error('webhook required');
    validateSecret(delivery.secret);
    await resolveCallback(delivery.url, this.resolver);
    const id = this.subscriptionId(name, delivery.url);
    if (Object.values(this.store.data.subscriptions).some((item) => item.id !== id && item.expiresAt > this.clock())) {
      throw new Error('another active dot subscription exists; unsubscribe it first');
    }
    const old = this.store.data.subscriptions[id];
    const expiresAt = this.clock() + Math.min(Math.max(Number(ttlMs) || 3_600_000, 60_000), MAX_AGE);
    const sub = { id, name, url: delivery.url, secret: delivery.secret, expiresAt };
    if (!old || old.secret !== sub.secret || old.expiresAt <= this.clock()) {
      const challenge = randomBytes(24).toString('base64url');
      const response = await this.sendWebhook(sub, { type: 'verification', challenge }, `verify_${randomUUID()}`);
      if (!response.ok) throw new Error(`callback verification status ${response.status}`);
      let answer;
      try { answer = JSON.parse(response.body); } catch { throw new Error('callback challenge invalid'); }
      if (typeof answer?.challenge !== 'string' || !equalText(challenge, answer.challenge)) throw new Error('callback challenge mismatch');
    }
    await this.store.update((state) => {
      state.subscriptions[id] = sub;
      for (const request of Object.values(state.requests)) {
        if (request.status === 'pending' && !request.localQueue && this.clock() - request.createdAt < MAX_AGE && !Object.keys(request.targets || {}).length) {
          request.targets = { [id]: { attempts: 0, nextAt: 0 } };
        }
      }
    });
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }

  async unsubscribe({ name, arguments: args = {}, delivery } = {}) {
    if (name !== EVENT || !args || Object.keys(args).length || delivery?.mode !== 'webhook') throw new Error('invalid subscription');
    const id = this.subscriptionId(name, delivery.url);
    await this.store.update((state) => { delete state.subscriptions[id]; });
    return {};
  }

  async sendWebhook(sub, event, id = event.eventId) {
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body) > 262_144) throw new Error('event too large');
    const timestamp = String(Math.floor(this.clock() / 1000));
    return this.post(sub.url, { body, headers: { 'Content-Type': 'application/json', 'webhook-id': id,
      'webhook-timestamp': timestamp, 'webhook-signature': signWebhook(sub.secret, id, timestamp, body),
      'X-MCP-Subscription-Id': sub.id } }, this.resolver);
  }

  async deliverPending() {
    if (this.delivery) return this.delivery;
    this.delivery = this._deliverPending().finally(() => { this.delivery = null; });
    return this.delivery;
  }

  async _deliverPending() {
    if (this.mode !== 'webhook') return;
    for (const request of Object.values(this.store.data.requests)) {
      if (request.localQueue) continue;
      if (this.clock() - request.createdAt > MAX_AGE) continue;
      for (const [id, target] of Object.entries(request.targets || {})) {
        const sub = this.store.data.subscriptions[id];
        if (!sub || sub.expiresAt <= this.clock() || target.done || target.attempts >= 8 || target.nextAt > this.clock()) continue;
        const event = { eventId: request.eventId, name: EVENT, timestamp: request.timestamp,
          data: { requestId: request.requestId, text: request.text, timestamp: request.timestamp }, cursor: null };
        let status;
        try { const response = await this.sendWebhook(sub, event); status = response.ok ? 200 : response.status; }
        catch { status = 0; }
        await this.store.update((state) => {
          const item = state.requests[request.requestId]?.targets[id];
          if (!item) return;
          item.attempts++;
          if (status === 200) item.done = true;
          else if (status === 410 || status === 413) item.attempts = 8;
          else item.nextAt = this.clock() + Math.min(60_000 * 2 ** (item.attempts - 1), 3_600_000);
        });
      }
    }
  }

  async reply(requestId, text, { claimId } = {}) {
    requestId = textValue(requestId, 128, 'request id');
    text = textValue(text, 800, 'reply text', true);
    const replyDigest = createHash('sha256').update(text).digest('hex');
    let duplicate = false;
    await this.store.update((state) => {
      const current = state.requests[requestId];
      if (!current || current.userId !== state.account?.boundUserId) throw new Error('unknown request');
      if (this.clock() - current.createdAt >= MAX_AGE) throw new Error('request expired');
      const queue = current.localQueue;
      if (queue && (!claimId || queue.claimId !== claimId)) throw new Error('claim does not match request');
      if (current.status === 'accepted') {
        if (current.replyDigest && current.replyDigest !== replyDigest) throw new Error('a different reply was already accepted');
        duplicate = true;
        return;
      }
      if (current.status !== 'pending') throw new Error(`request ${current.status}; manual reconciliation required`);
      if (queue && (!['claimed', 'acked'].includes(queue.status) || queue.leaseExpiresAt <= this.clock())) throw new Error('claim expired or not active');
      current.status = 'sending';
      current.sendClientId = randomUUID();
      current.replyDigest = replyDigest;
    });
    if (duplicate) return { status: 'accepted', duplicate: true };
    try {
      const request = this.store.data.requests[requestId];
      await this.client.sendText(this.store.data.account, request, text);
      await this.store.update((state) => {
        state.requests[requestId].status = 'accepted';
        delete state.requests[requestId].contextToken;
        if (state.requests[requestId].localQueue) state.requests[requestId].localQueue.status = 'done';
      });
      return { status: 'accepted', duplicate: false };
    } catch {
      await this.store.update((state) => {
        state.requests[requestId].status = 'unconfirmed';
        if (state.requests[requestId].localQueue) state.requests[requestId].localQueue.status = 'blocked';
      });
      throw new Error('WeChat send unconfirmed; do not retry automatically');
    }
  }
}
