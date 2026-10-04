import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmod, unlink } from 'node:fs/promises';
import { JsonStore } from './store.mjs';
import { WechatClient, bindOwner, trustedBaseUrl } from './wechat.mjs';
import { acquireLock, statePath } from './runtime.mjs';

const command = process.argv[2];
if (!['login', 'bind'].includes(command)) throw new Error('Use login or bind');
const path = statePath();
const release = await acquireLock(path);
const reader = createInterface({ input: process.stdin, output: process.stderr });
const controller = new AbortController();
const qrFiles = new Set();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

function renderQr(value, qrFile) {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL('./qr.swift', import.meta.url));
    const child = spawn('/usr/bin/swift', [script, ...(qrFile ? ['--png', qrFile] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let diagnostic = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { diagnostic += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`QR rendering failed: ${diagnostic.slice(0, 300)}`)));
    child.stdin.end(value);
  });
}

async function displayQr(client) {
  const qr = await client.createQr();
  if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error('QR response incomplete');
  const qrFile = process.env.WECHAT_CODEX_QR_FILE ? `${process.env.WECHAT_CODEX_QR_FILE}.${Date.now()}.png` : undefined;
  if (qrFile) qrFiles.add(qrFile);
  const rendered = await renderQr(qr.qrcode_img_content, qrFile);
  if (qrFile) {
    await chmod(qrFile, 0o600);
    if (process.env.WECHAT_CODEX_SHOW_QR === '1') {
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', ['-a', 'Preview', qrFile], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Could not open QR image in Preview')));
      });
    }
    process.stderr.write('New QR image opened. Waiting for your WeChat scan.\n');
  } else {
    process.stderr.write('Scan this QR code in WeChat. Credentials stay in the local state file.\n');
    process.stderr.write(rendered);
  }
  return qr;
}

try {
  const store = await new JsonStore(path).load();
  const client = new WechatClient();
  if (command === 'login') {
    if (store.data.account && process.argv[3] !== '--replace') throw new Error('Account already configured; use login --replace for explicit replacement');
    let qr = await displayQr(client);
    let refreshes = 0;
    let baseUrl = 'https://ilinkai.weixin.qq.com';
    let verifyCode;
    for (;;) {
      if (controller.signal.aborted) throw new Error('Login canceled');
      let status;
      try { status = await client.qrStatus(qr.qrcode, baseUrl, verifyCode, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw new Error('Login canceled');
        if (error.name === 'TimeoutError' || error.name === 'TypeError') {
          process.stderr.write('Login status temporarily unavailable; still waiting for your scan.\n');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        throw error;
      }
      verifyCode = undefined;
      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_bot_id) throw new Error('login response incomplete');
        const finalUrl = trustedBaseUrl(status.baseurl || baseUrl);
        await store.update((state) => { state.account = { token: status.bot_token, baseUrl: finalUrl, accountId: status.ilink_bot_id,
          boundUserId: null, cursor: '' }; state.requests = {}; state.subscriptions = {}; state.localIngressSequence = 0; state.localQueueActivation = null; });
        process.stderr.write('Login stored privately. Run bind next.\n');
        break;
      }
      if (status.status === 'scaned_but_redirect' && status.redirect_host) {
        baseUrl = trustedBaseUrl(status.redirect_host.startsWith('https://') ? status.redirect_host : `https://${status.redirect_host}`);
      }
      if (status.status === 'need_verifycode') verifyCode = await reader.question('Enter the code shown in WeChat: ');
      if (status.status === 'verify_code_blocked') throw new Error('Verification blocked; login stopped');
      if (status.status === 'expired') {
        if (refreshes++ >= 3) throw new Error('Login window ended; run login again');
        qr = await displayQr(client);
        baseUrl = 'https://ilinkai.weixin.qq.com';
        verifyCode = undefined;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } else {
    if (!store.data.account?.token) throw new Error('Run login first');
    const phrase = `wechat-bind-${randomBytes(12).toString('hex')}`;
    process.stderr.write(`Send this exact one-time text to the newly linked WeChat bot from your own account:\n${phrase}\n`);
    await bindOwner(client, store, phrase, { signal: controller.signal });
    process.stderr.write('Owner bound. The binding message was not sent to Codex.\n');
  }
} finally {
  reader.close();
  for (const file of qrFiles) await unlink(file).catch(() => {});
  await release();
}
