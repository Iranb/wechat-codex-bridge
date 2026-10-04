import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended release files before running the release check');
const allowedRoots = new Set(['README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'package.json', 'package-lock.json', 'requirements.txt', '.gitignore']);
const forbidden = /(?:^|\/)(?:auth\.json(?:\..*)?|state\.json(?:\..*)?|(?:native-codex|codex-session)\.json(?:\..*)?|claim\.json|outbox\.json|worker\.json|exec-final\.txt|probe_[^/]*\.txt|\.env(?:\..*)?)$|\.(?:log|sock|pem|key|lock)$|(?:^|\/)(?:bin|data|private|runtime|attachments|node_modules|\.venv|__pycache__|(?:dot-wechat|wechat-codex)-receive-[^/]*)(?:\/|$)/;
const checks = [
  ['private-home-or-volume-path', /\/(?:Users|Volumes)\/[A-Za-z0-9_.-]+\//g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['model-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['bearer-credential', /Bearer\s+[A-Za-z0-9._-]{24,}/g],
  ['personal-email', /\b[A-Z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163)\.com\b/gi],
];
const syntheticUuid = new Set(['11111111-1111-4111-8111-111111111111', '258eafa5-e914-47da-95ca-c5ab0dc85b11']);
const issues = [];
for (const file of files) {
  if (!allowedRoots.has(file) && !/^(?:src|test|docs|scripts|\.github\/workflows)\//.test(file)) issues.push({ file, category: 'unexpected-release-path' });
  if (forbidden.test(file)) issues.push({ file, category: 'runtime-or-credential-file' });
  const path = resolve(root, file), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 262_144) {
    issues.push({ file, category: 'unexpected-file-type-or-size' }); continue;
  }
  const bytes = await readFile(path);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { issues.push({ file, category: 'binary-content' }); continue; }
  if (bytes.includes(0)) issues.push({ file, category: 'binary-content' });
  for (const [category, pattern] of checks) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) issues.push({ file, category });
  }
  for (const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
    if (!syntheticUuid.has(match[0].toLowerCase())) issues.push({ file, category: 'non-synthetic-session-id' });
  }
  if (basename(file) === 'package.json' && JSON.parse(text).license !== 'MIT') issues.push({ file, category: 'license-mismatch' });
}
console.log(JSON.stringify({ trackedFiles: files.length, issues }, null, 2));
if (issues.length) process.exitCode = 1;
