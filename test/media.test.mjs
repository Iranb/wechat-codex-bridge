import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { LocalQueue } from '../src/local-queue.mjs';
import { downloadAttachment, fetchCdn, inspectContent, MediaError, normalizeAttachments, saveAttachment, MAX_ATTACHMENT_BYTES } from '../src/media.mjs';
import { pollOnce } from '../src/wechat.mjs';
import { attachmentFromClaim } from '../src/attachment-client.mjs';

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const encrypt = (bytes, key) => { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(bytes), cipher.final()]); };
function minimalZip(names) {
  const parts = []; const central = []; let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(bytes.length, 26);
    parts.push(local, bytes);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(bytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, bytes); offset += local.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}
const media = (key, overrides = {}) => ({ encrypt_query_param: 'private-query-token', aes_key: key.toString('base64'), encrypt_type: 1, ...overrides });
const raw = (id, key, options = {}) => ({ message_type: 1, from_user_id: options.user || 'owner', message_id: id,
  context_token: 'private-context-token', item_list: options.items || [{ type: 4, file_item: { file_name: '../../report.pdf', len: String(pdf.length), media: media(key) } }] });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-media-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new JsonStore(join(dir, 'state.json')).load();
  await store.update((s) => { s.account = { token: 'private-bot-token', boundUserId: 'owner', accountId: 'bot', cursor: '' }; });
  let now = Date.now();
  const bridge = new Bridge({ store, client: { sendText: async () => ({ ret: 0 }) }, mode: 'local-queue', clock: () => now });
  const queue = new LocalQueue(bridge);
  await queue.activate({ activationAt: 'now' });
  return { dir, store, bridge, queue, advance: (ms) => { now += ms; } };
}

test('owner PDF attachment decrypts, saves privately, deduplicates, and exposes no access token', async (t) => {
  const f = await fixture(t);
  const key = randomBytes(16); const cipher = encrypt(pdf, key);
  let downloads = 0;
  const client = { getUpdates: async () => ({ get_updates_buf: 'cursor-media', msgs: [raw('m1', key), raw('m2', key, { user: 'stranger' })] }),
    downloadAttachment: (attachment) => { downloads++; return downloadAttachment(attachment, { fetchImpl: async () => cipher }); } };
  assert.equal(await pollOnce(client, f.store, f.bridge), 1);
  assert.equal(await pollOnce(client, f.store, f.bridge), 0);
  assert.equal(downloads, 1);
  const claim = await f.queue.claim();
  assert.equal(claim.text, '');
  assert.equal(claim.attachments[0].status, 'ready');
  assert.equal(claim.attachments[0].name, '_.._report.pdf');
  assert.deepEqual(await readFile(claim.attachments[0].path), pdf);
  assert.equal((await stat(claim.attachments[0].path)).mode & 0o077, 0);
  const publicText = JSON.stringify(claim);
  for (const secret of ['private-query-token', 'private-context-token', 'private-bot-token', key.toString('base64'), 'from_user_id']) {
    assert.equal(publicText.includes(secret), false);
  }
  const stored = await new JsonStore(f.store.path).load();
  assert.equal(stored.data.requests[claim.requestId].attachments[0].source, undefined);
  assert.equal(stored.data.account.cursor, 'cursor-media');
  assert.equal(Object.keys(stored.data.requests).length, 1);
  await assert.rejects(saveAttachment(f.store.path, claim.requestId, { id: 'att_0' }, {
    bytes: Buffer.from('other'), extension: '.pdf', sha256: '0'.repeat(64),
  }), /storage_collision/);
  assert.deepEqual(await readFile(claim.attachments[0].path), pdf);
  const receiveDir = await mkdtemp(join(tmpdir(), 'wechat-codex-receive-'));
  t.after(() => rm(receiveDir, { recursive: true, force: true }));
  const claimFile = join(receiveDir, 'claim.json');
  await writeFile(claimFile, JSON.stringify({ status: 'claimed', request: claim }), { mode: 0o600 });
  const resolved = await attachmentFromClaim({ claimFile, attachmentId: 'att_0' }, { statePath: f.store.path });
  assert.equal(resolved.path, claim.attachments[0].path);
  await writeFile(resolved.path, 'tampered');
  await assert.rejects(attachmentFromClaim({ claimFile, attachmentId: 'att_0' }, { statePath: f.store.path }), /size mismatch/);
  f.advance(8 * 24 * 60 * 60 * 1000);
  await f.bridge.recover();
  await pollOnce({ getUpdates: async () => ({ msgs: [], get_updates_buf: '' }) }, f.store, f.bridge);
  assert.equal((await stat(resolved.path)).isFile(), true); // No automatic deletion of saved files.
});

test('image decrypt uses item hex key and verifies actual pixels format signature', async () => {
  const key = randomBytes(16);
  const attachments = normalizeAttachments(raw('i1', key, { items: [{ type: 2, image_item: {
    aeskey: key.toString('hex'), media: media(key), mid_size: encrypt(png, key).length } }] }));
  assert.equal(attachments.length, 1);
  const result = await downloadAttachment(attachments[0], { fetchImpl: async () => encrypt(png, key) });
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.bytes, png);
  await assert.rejects(downloadAttachment(attachments[0], { fetchImpl: async () => encrypt(Buffer.alloc(png.length, 65), key) }), /invalid_image_signature/);
});

test('file signatures, filenames, unsupported types, size and decryption failures are bounded', async () => {
  assert.equal(inspectContent(pdf, { kind: 'pdf', extension: '.pdf' }).mime, 'application/pdf');
  assert.throws(() => inspectContent(Buffer.from('not pdf'), { kind: 'pdf', extension: '.pdf' }), /invalid_document_signature/);
  assert.throws(() => inspectContent(Buffer.from('PK\x03\x04junk'), { kind: 'word', extension: '.docx' }), /invalid_document_signature/);
  assert.equal(inspectContent(minimalZip(['[Content_Types].xml', 'word/document.xml']), { kind: 'word', extension: '.docx' }).mime.includes('wordprocessingml'), true);
  assert.equal(inspectContent(minimalZip(['[Content_Types].xml', 'xl/workbook.xml']), { kind: 'excel', extension: '.xlsx' }).mime.includes('spreadsheetml'), true);
  assert.throws(() => inspectContent(minimalZip(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']),
    { kind: 'word', extension: '.docx' }), /invalid_document_signature/);
  assert.throws(() => inspectContent(Buffer.from([0, 1, 2]), { kind: 'text', extension: '.txt' }), /invalid_text_content/);
  const key = randomBytes(16);
  const oversized = normalizeAttachments(raw('large', key, { items: [{ type: 4, file_item: { file_name: 'big.pdf', len: String(MAX_ATTACHMENT_BYTES + 1), media: media(key) } }] }));
  assert.equal(oversized[0].failure, 'size_limit');
  const archive = normalizeAttachments(raw('zip', key, { items: [{ type: 4, file_item: { file_name: 'archive.zip', media: media(key) } }] }));
  assert.equal(archive[0].failure, 'unsupported_type');
  const attachment = normalizeAttachments(raw('bad', key))[0];
  await assert.rejects(downloadAttachment(attachment, { fetchImpl: async () => Buffer.alloc(17) }), /invalid_ciphertext/);
  await assert.rejects(downloadAttachment(attachment, { fetchImpl: async () => encrypt(Buffer.from('other'), key) }), /size_mismatch/);
  const fakeImage = normalizeAttachments(raw('fake-image', key, { items: [{ type: 4, file_item: { file_name: 'photo.jpg', media: media(key) } }] }))[0];
  await assert.rejects(downloadAttachment(fakeImage, { fetchImpl: async () => encrypt(pdf, key) }), /invalid_image_signature/);
});

test('media transport rejects non-Tencent URLs and private DNS before any request', async () => {
  await assert.rejects(fetchCdn({ fullUrl: 'https://example.com/c2c/download?token=secret' }, 1024), /untrusted_media_url/);
  await assert.rejects(fetchCdn({ fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?token=secret' }, 1024,
    { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }), /unsafe_media_host/);
});

test('pre-activation attachment stays untouched and is not downloaded', async (t) => {
  const f = await fixture(t);
  const key = randomBytes(16);
  await f.store.update((s) => {
    s.localQueueActivation = null;
  });
  await f.bridge.incoming({ userId: 'owner', messageId: 'old', contextToken: 'ctx', text: '', timestamp: new Date().toISOString(),
    attachments: normalizeAttachments(raw('old', key)) });
  await f.queue.activate({ activationAt: 'now' });
  let downloads = 0;
  await pollOnce({ getUpdates: async () => ({ msgs: [], get_updates_buf: '' }), downloadAttachment: async () => { downloads++; } }, f.store, f.bridge);
  assert.equal(downloads, 0);
  assert.equal(await f.queue.claim(), null);
});

test('transient media failure retries, keeps claim pending, then releases failed metadata without secrets', async (t) => {
  const f = await fixture(t);
  const key = randomBytes(16);
  let downloads = 0;
  const client = { getUpdates: async () => ({ get_updates_buf: 'c', msgs: [raw('retry', key)] }),
    downloadAttachment: async () => { downloads++; throw new MediaError('media_timeout', true); } };
  await pollOnce(client, f.store, f.bridge);
  assert.equal(await f.queue.claim(), null);
  f.advance(2000); await pollOnce(client, f.store, f.bridge);
  assert.equal(await f.queue.claim(), null);
  f.advance(10000); await pollOnce(client, f.store, f.bridge);
  assert.equal(downloads, 3);
  const claim = await f.queue.claim();
  assert.equal(claim.attachments[0].status, 'failed');
  assert.equal(claim.attachments[0].failure, 'media_timeout');
  assert.equal(f.store.data.requests[claim.requestId].attachments[0].source, undefined);
  assert.equal(JSON.stringify(claim).includes('private-query-token'), false);
});
