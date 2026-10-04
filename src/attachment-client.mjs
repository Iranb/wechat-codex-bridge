import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { statePath as defaultStatePath } from './runtime.mjs';
import { inspectContent, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES } from './media.mjs';

async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('private regular file required');
  return info;
}

// This local-only helper validates the private claim and saved file before a
// child task reads it. The parent dot receives extracted findings, not a path.
export async function attachmentFromClaim({ claimFile, attachmentId }, { statePath = defaultStatePath() } = {}) {
  if (typeof claimFile !== 'string' || basename(claimFile) !== 'claim.json' ||
      !basename(dirname(claimFile)).startsWith('wechat-codex-receive-') ||
      !/^att_[0-7]$/.test(attachmentId || '')) throw new Error('invalid attachment claim');
  const dir = await lstat(dirname(claimFile));
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid()) throw new Error('private receive directory required');
  await privateFile(claimFile);
  const claim = JSON.parse(await readFile(claimFile, 'utf8'));
  const request = claim?.request;
  if (claim.status !== 'claimed' || request?.ownerMatched !== true || !/^wx_[a-f0-9]{32}$/.test(request.requestId || '')) throw new Error('invalid owner claim');
  const item = request.attachments?.find((value) => value.id === attachmentId);
  if (!item || item.status !== 'ready' || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw new Error('attachment not ready');
  const root = join(dirname(statePath), 'attachments');
  const folder = join(root, request.requestId);
  const expected = join(folder, `${attachmentId}${/\.[a-z0-9]{1,8}$/i.exec(item.path)?.[0] || ''}`);
  if (resolve(item.path) !== resolve(expected)) throw new Error('attachment path mismatch');
  const rootInfo = await lstat(root), folderInfo = await lstat(folder);
  for (const info of [rootInfo, folderInfo]) {
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('unsafe attachment directory');
  }
  const info = await privateFile(item.path);
  const max = item.kind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  if (info.size !== item.size || info.size > max) throw new Error('attachment size mismatch');
  const bytes = await readFile(item.path);
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('attachment digest mismatch');
  const extension = /\.[a-z0-9]{1,8}$/i.exec(item.path)?.[0].toLowerCase() || '';
  const type = inspectContent(bytes, { kind: item.kind, extension });
  if (type.mime !== item.mime) throw new Error('attachment type mismatch');
  return { requestId: request.requestId, attachmentId, name: item.name, kind: item.kind, mime: item.mime,
    size: item.size, sha256: item.sha256, path: item.path };
}
