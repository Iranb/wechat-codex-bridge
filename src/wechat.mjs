import { randomBytes, randomUUID } from 'node:crypto';
import { downloadAttachment, normalizeAttachments, saveAttachment } from './media.mjs';

const ROOT = 'https://ilinkai.weixin.qq.com';
const UIN = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
const BASE_INFO = { channel_version: '1.0.0', bot_agent: 'WeChatCodexBridge/0.1.0' };

export function trustedBaseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new Error('untrusted WeChat API host');
  return url.origin;
}

async function api(baseUrl, path, { method = 'POST', body, token, timeout = 40_000, fetchImpl = fetch, signal, extraHeaders = {} } = {}) {
  const url = new URL(path, `${trustedBaseUrl(baseUrl)}/`);
  const headers = { 'Content-Type': 'application/json', 'X-WECHAT-UIN': UIN, ...extraHeaders };
  if (token) { headers.AuthorizationType = 'ilink_bot_token'; headers.Authorization = `Bearer ${token}`; }
  const timeoutSignal = AbortSignal.timeout(timeout);
  const response = await fetchImpl(url, {
    method, headers, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  if (!response.ok) throw new Error(`WeChat API HTTP ${response.status}`);
  const value = await response.json();
  if (value && ((typeof value.ret === 'number' && value.ret !== 0) || (typeof value.errcode === 'number' && value.errcode !== 0))) {
    const error = new Error('WeChat API rejected request');
    error.code = value.errcode || value.ret;
    throw error;
  }
  return value;
}

export class WechatClient {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; }
  async createQr() {
    return api(ROOT, '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, fetchImpl: this.fetchImpl });
  }
  async qrStatus(qrcode, baseUrl = ROOT, verifyCode, signal) {
    const path = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}` + (verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : '');
    return api(baseUrl, path, { method: 'GET', timeout: 40_000, fetchImpl: this.fetchImpl, signal, extraHeaders: { 'iLink-App-ClientVersion': '1' } });
  }
  async getUpdates(account, signal) {
    return api(account.baseUrl, '/ilink/bot/getupdates', {
      token: account.token, body: { get_updates_buf: account.cursor || '', base_info: BASE_INFO },
      fetchImpl: this.fetchImpl, signal,
    });
  }
  async downloadAttachment(attachment) { return downloadAttachment(attachment); }
  async sendText(account, request, text) {
    return api(account.baseUrl, '/ilink/bot/sendmessage', {
      token: account.token, timeout: 15_000, fetchImpl: this.fetchImpl,
      body: { msg: {
        from_user_id: '', to_user_id: request.userId, client_id: request.sendClientId || randomUUID(),
        message_type: 2, message_state: 2, context_token: request.contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      }, base_info: BASE_INFO },
    });
  }
}

export function normalizeText(raw) {
  if (raw?.message_type !== 1 || !raw.from_user_id || !raw.message_id || !raw.context_token) return null;
  const text = raw.item_list?.filter((item) => item.type === 1 && typeof item.text_item?.text === 'string')
    .map((item) => item.text_item.text).filter((part) => part.trim().length).join('\n');
  if (!text || text.length > 4000) return null;
  return { userId: raw.from_user_id, messageId: String(raw.message_id), contextToken: raw.context_token,
    text, timestamp: new Date(raw.create_time_ms || Date.now()).toISOString() };
}

export function normalizeIncoming(raw, { media = false } = {}) {
  if (raw?.message_type !== 1 || !raw.from_user_id || !raw.message_id || !raw.context_token || raw.group_id) return null;
  const text = raw.item_list?.filter((item) => item.type === 1 && typeof item.text_item?.text === 'string')
    .map((item) => item.text_item.text).filter((part) => part.trim().length).join('\n') || '';
  if (text.length > 4000) return null;
  const attachments = media ? normalizeAttachments(raw) : [];
  if (!text && !attachments.length) return null;
  return { userId: raw.from_user_id, messageId: String(raw.message_id), contextToken: raw.context_token,
    text, timestamp: new Date(raw.create_time_ms || Date.now()).toISOString(), attachments };
}

export async function processPendingAttachments(client, store, bridge) {
  if (bridge.mode !== 'local-queue' || !store.data.localQueueActivation) return 0;
  let completed = 0;
  for (const request of Object.values(store.data.requests)) {
    if (request.userId !== store.data.account?.boundUserId || request.status !== 'pending' ||
        (request.ingressSequence || 0) <= store.data.localQueueActivation.afterSequence ||
        request.createdAt < store.data.localQueueActivation.at) continue;
    for (const attachment of request.attachments || []) {
      if (attachment.status !== 'pending' || attachment.nextAt > bridge.clock()) continue;
      try {
        const result = await (client.downloadAttachment ? client.downloadAttachment(attachment) : downloadAttachment(attachment));
        const path = await saveAttachment(store.path, request.requestId, attachment, result);
        await store.update((state) => {
          const current = state.requests[request.requestId]?.attachments?.find((value) => value.id === attachment.id);
          if (!current || current.status !== 'pending') return;
          Object.assign(current, { status: 'ready', path, mime: result.mime, size: result.bytes.length, sha256: result.sha256 });
          delete current.source; delete current.failure; delete current.nextAt;
        });
        completed++;
      } catch (error) {
        await store.update((state) => {
          const current = state.requests[request.requestId]?.attachments?.find((value) => value.id === attachment.id);
          if (!current || current.status !== 'pending') return;
          current.attempts++;
          const retry = error.retryable === true && current.attempts < 3;
          current.status = retry ? 'pending' : 'failed';
          current.failure = typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'storage_error';
          current.nextAt = retry ? bridge.clock() + 2000 * 5 ** (current.attempts - 1) : 0;
          if (!retry) delete current.source;
        });
        completed++;
      }
    }
  }
  if (completed) bridge.notifyIncoming();
  return completed;
}

export async function pollOnce(client, store, bridge, signal) {
  const account = store.data.account;
  if (!account?.boundUserId) throw new Error('WeChat account or owner is not bound');
  const batch = await client.getUpdates(account, signal);
  const messages = Array.isArray(batch.msgs) ? batch.msgs : [];
  const accepted = [];
  await store.update((state) => {
    bridge.prune(state);
    for (const raw of messages) {
      const message = normalizeIncoming(raw, { media: bridge.mode === 'local-queue' });
      if (message?.userId === state.account.boundUserId) {
        const record = bridge.recordIncoming(state, message);
        if (record) accepted.push(record);
      }
    }
    if (typeof batch.get_updates_buf === 'string' && batch.get_updates_buf) state.account.cursor = batch.get_updates_buf;
  });
  if (accepted.length) bridge.notifyIncoming();
  await processPendingAttachments(client, store, bridge);
  return accepted.length;
}

export async function bindOwner(client, store, phrase, { signal, onWaiting } = {}) {
  if (store.data.account?.boundUserId) throw new Error('owner is already bound');
  if (typeof phrase !== 'string' || phrase.length < 12 || phrase.length > 128) throw new Error('binding phrase must be 12–128 characters');
  for (;;) {
    if (signal?.aborted) throw new Error('binding canceled');
    const batch = await client.getUpdates(store.data.account, signal);
    const matches = (batch.msgs || []).map(normalizeText).filter((m) => m?.text === phrase);
    if (matches.length > 1 || new Set(matches.map((m) => m.userId)).size > 1) throw new Error('ambiguous binding phrase');
    await store.update((state) => {
      if (typeof batch.get_updates_buf === 'string' && batch.get_updates_buf) state.account.cursor = batch.get_updates_buf;
      if (matches.length === 1) state.account.boundUserId = matches[0].userId;
    });
    if (matches.length === 1) return;
    onWaiting?.();
  }
}
