import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_AGE } from './bridge.mjs';
import { publicAttachment } from './media.mjs';

const DEFAULT_LEASE = 600_000;
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid ${label}`);
  return value;
};
const validateMatch = (value) => {
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 4000)) throw new Error('invalid exact text filter');
};
const validateWorker = (value) => {
  if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value))) throw new Error('invalid receiver handle');
};
const validateExclusions = (value) => {
  if (!Array.isArray(value) || value.length > 100 || !value.every(id => typeof id === 'string' && /^wx_[a-f0-9]{32}$/.test(id))) throw new Error('invalid request exclusions');
};

// Queue metadata stays in the existing private state. IPC never returns account,
// userId, messageId, contextToken, subscriptions, or transport credentials.
export class LocalQueue {
  constructor(bridge) {
    if (bridge.mode !== 'local-queue') throw new Error('local-queue mode required');
    this.bridge = bridge;
    this.store = bridge.store;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.bridge.onIncoming = () => this.notify();
  }

  notify() { this.events.emit('changed'); }

  async activate({ activationAt } = {}) {
    if (activationAt !== 'now') integer(activationAt, 1, this.bridge.clock(), 'activation timestamp');
    let result;
    await this.store.update((state) => {
      if (!state.account?.boundUserId) throw new Error('owner binding required');
      const duplicate = Boolean(state.localQueueActivation);
      if (duplicate && activationAt !== 'now' && state.localQueueActivation.at !== activationAt) throw new Error('activation already exists; do not skip queued new messages');
      state.localQueueActivation ||= { at: activationAt === 'now' ? this.bridge.clock() : activationAt, afterSequence: state.localIngressSequence || 0 };
      result = { status: 'activated', activationAt: new Date(state.localQueueActivation.at).toISOString(), duplicate };
    });
    this.notify();
    return result;
  }

  publicClaim(request) {
    return { requestId: request.requestId, text: request.text, timestamp: request.timestamp, ownerMatched: true,
      ...(request.attachments?.length ? { attachments: request.attachments.map((item) => publicAttachment(item, true)) } : {}),
      claimId: request.localQueue.claimId, leaseExpiresAt: new Date(request.localQueue.leaseExpiresAt).toISOString() };
  }

  take(request, now, leaseMs, workerId) {
    request.localQueue = { status: 'claimed', claimId: randomUUID(), claimedAt: now,
      leaseExpiresAt: Math.min(now + leaseMs, request.createdAt + MAX_AGE), leaseMs,
      attempts: (request.localQueue.attempts || 0) + 1, ...(workerId ? { workerId } : {}) };
    return this.publicClaim(request);
  }

  eligible(request, now, matchText, excludeRequestIds = []) {
    const queue = request.localQueue;
    return !excludeRequestIds.includes(request.requestId) && request.status === 'pending' && request.userId === this.store.data.account?.boundUserId && queue &&
      now - request.createdAt < MAX_AGE && typeof request.text === 'string' &&
      (request.attachments || []).every((item) => ['ready', 'failed'].includes(item.status)) &&
      (matchText === undefined || request.text === matchText) &&
      (matchText !== undefined || (this.store.data.localQueueActivation &&
        (request.ingressSequence || 0) > this.store.data.localQueueActivation.afterSequence && request.createdAt >= this.store.data.localQueueActivation.at)) &&
      (queue.status === 'pending' || (['claimed', 'acked'].includes(queue.status) && queue.leaseExpiresAt <= now));
  }

  async claim({ leaseMs = DEFAULT_LEASE, matchText, workerId, excludeRequestIds = [] } = {}) {
    integer(leaseMs, 1000, 3_600_000, 'lease duration');
    validateMatch(matchText);
    validateWorker(workerId);
    validateExclusions(excludeRequestIds);
    if (matchText === undefined && !this.store.data.localQueueActivation) throw new Error('normal reception is not activated');
    const heldByWorker = (state) => workerId && Object.values(state.requests).find((item) => !excludeRequestIds.includes(item.requestId) && item.status === 'pending' &&
      item.userId === state.account?.boundUserId && item.localQueue?.workerId === workerId &&
      ['pending', 'claimed', 'acked'].includes(item.localQueue.status) && this.bridge.clock() - item.createdAt < MAX_AGE &&
      (matchText !== undefined ? item.text === matchText : (item.ingressSequence || 0) > state.localQueueActivation.afterSequence));
    const held = heldByWorker(this.store.data);
    if (held && held.localQueue.leaseExpiresAt > this.bridge.clock()) return this.publicClaim(held);
    if (!held && !Object.values(this.store.data.requests).some((item) => this.eligible(item, this.bridge.clock(), matchText, excludeRequestIds))) return null;
    let claimed = null;
    await this.store.update((state) => {
      const now = this.bridge.clock();
      const resumed = heldByWorker(state);
      if (resumed) {
        claimed = resumed.localQueue.leaseExpiresAt > now ? this.publicClaim(resumed) : this.take(resumed, now, leaseMs, workerId);
        return;
      }
      const request = Object.values(state.requests).filter((item) => this.eligible(item, now, matchText, excludeRequestIds)).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!request) return;
      claimed = this.take(request, now, leaseMs, workerId);
    });
    return claimed;
  }

  requestStatus({ requestId, claimId, text }) {
    const request = this.store.data.requests[requestId];
    const queue = request?.localQueue;
    if (!request || request.userId !== this.store.data.account?.boundUserId || !claimId ||
      (queue?.claimId !== claimId && queue?.expiredClaimId !== claimId)) throw new Error('claim does not match request');
    if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > 800)) throw new Error('invalid reply text');
    return { requestId, status: request.status, queueStatus: queue.status,
      ...(text === undefined ? {} : { replyMatches: request.replyDigest === createHash('sha256').update(text).digest('hex') }),
      leaseActive: ['claimed', 'acked'].includes(queue.status) && queue.leaseExpiresAt > this.bridge.clock() };
  }

  async reclaim({ requestId, claimId, leaseMs = 3_600_000 }) {
    integer(leaseMs, 1000, 3_600_000, 'lease duration');
    let request;
    await this.store.update((state) => {
      const current = state.requests[requestId];
      const queue = current?.localQueue;
      if (!current || current.userId !== state.account?.boundUserId || !claimId ||
        (queue?.claimId !== claimId && queue?.expiredClaimId !== claimId)) throw new Error('claim no longer owns request');
      if (current.status !== 'pending' || this.bridge.clock() - current.createdAt >= MAX_AGE) throw new Error('request cannot be reclaimed');
      if (['claimed', 'acked'].includes(queue.status) && queue.leaseExpiresAt > this.bridge.clock()) throw new Error('claim still active; renew it');
      request = this.take(current, this.bridge.clock(), leaseMs, queue.workerId);
    });
    return { status: 'claimed', request };
  }

  async releaseWorker({ workerId }) {
    validateWorker(workerId);
    if (!workerId) throw new Error('receiver handle required');
    let released = 0;
    await this.store.update((state) => {
      for (const request of Object.values(state.requests)) {
        if (request.status === 'pending' && request.userId === state.account?.boundUserId && request.localQueue?.workerId === workerId) {
          request.localQueue = { status: 'pending', attempts: request.localQueue.attempts };
          released++;
        }
      }
    });
    this.notify();
    return { status: 'released', released };
  }

  requireClaim(state, { requestId, claimId }) {
    const request = state.requests[requestId];
    const queue = request?.localQueue;
    if (!request || request.userId !== state.account?.boundUserId || !queue || !claimId || queue.claimId !== claimId) throw new Error('claim does not match request');
    if (request.status !== 'pending') throw new Error(`request ${request.status}; cannot change claim`);
    if (!['claimed', 'acked'].includes(queue.status) || queue.leaseExpiresAt <= this.bridge.clock() || this.bridge.clock() - request.createdAt >= MAX_AGE) throw new Error('claim expired or not active');
    return request;
  }

  async ack(args) {
    let result;
    await this.store.update((state) => {
      const request = this.requireClaim(state, args);
      const duplicate = request.localQueue.status === 'acked';
      request.localQueue.status = 'acked';
      request.localQueue.ackedAt ??= this.bridge.clock();
      result = { status: 'acknowledged', requestId: request.requestId, duplicate };
    });
    return result;
  }

  async renew(args) {
    let result;
    await this.store.update((state) => {
      const request = this.requireClaim(state, args);
      request.localQueue.leaseExpiresAt = Math.min(this.bridge.clock() + request.localQueue.leaseMs, request.createdAt + MAX_AGE);
      result = { status: 'renewed', requestId: request.requestId, leaseExpiresAt: new Date(request.localQueue.leaseExpiresAt).toISOString() };
    });
    return result;
  }

  async release(args) {
    await this.store.update((state) => {
      const request = this.requireClaim(state, args);
      request.localQueue = { status: 'pending', attempts: request.localQueue.attempts };
    });
    this.notify();
    return { status: 'released', requestId: args.requestId };
  }

  async reply({ requestId, claimId, text }) {
    if (!this.store.data.requests[requestId]?.localQueue) throw new Error('unknown local request');
    return this.bridge.reply(requestId, text, { claimId });
  }

  status() {
    const counts = {};
    for (const request of Object.values(this.store.data.requests)) {
      if (request.localQueue) counts[request.status] = (counts[request.status] || 0) + 1;
    }
    return { running: true, mode: 'local-queue', ownerBound: Boolean(this.store.data.account?.boundUserId),
      accountConfigured: Boolean(this.store.data.account?.token), counts,
      normalReceptionActivated: Boolean(this.store.data.localQueueActivation),
      activationAt: this.store.data.localQueueActivation ? new Date(this.store.data.localQueueActivation.at).toISOString() : null,
      ...(this.receiveStatus ? { receive: structuredClone(this.receiveStatus) } : {}) };
  }

  async wait({ timeoutMs = 60_000, leaseMs = DEFAULT_LEASE, matchText, workerId, excludeRequestIds = [] } = {}, signal) {
    integer(timeoutMs, 0, 86_400_000, 'wait timeout');
    integer(leaseMs, 1000, 3_600_000, 'lease duration');
    validateMatch(matchText);
    validateWorker(workerId);
    validateExclusions(excludeRequestIds);
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      signal?.throwIfAborted();
      const request = await this.claim({ leaseMs, matchText, workerId, excludeRequestIds });
      if (request) return { status: 'claimed', request };
      if (Date.now() >= deadline) return { status: 'timeout', request: null };
      // The timer also wakes an expired claim. This is ordinary Node work and
      // does not call an agent/model. Listener registration precedes awaiting.
      await new Promise((resolve, reject) => {
        const clean = () => { clearTimeout(timer); this.events.off('changed', changed); signal?.removeEventListener('abort', aborted); };
        const changed = () => { clean(); resolve(); };
        const aborted = () => { clean(); reject(signal.reason || new Error('wait cancelled')); };
        const timer = setTimeout(changed, Math.max(1, Math.min(1000, deadline - Date.now())));
        this.events.once('changed', changed);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    }
  }
}
