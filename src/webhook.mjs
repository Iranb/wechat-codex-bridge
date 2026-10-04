import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

function publicIp(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a >= 1 && a <= 223 && a !== 10 && a !== 127 &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168)) &&
      !(a === 198 && (b === 18 || b === 19)) && !(a === 203 && b === 0 && c === 113) &&
      !(a === 198 && b === 51 && c === 100) && !(a === 192 && b === 0 && c === 2);
  }
  if (family === 6) {
    const [a, b] = address.split(':').map((value) => Number.parseInt(value || '0', 16));
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 &&
      !(a === 0x2001 && (b === 0 || b === 0xdb8)); // exclude tunnels and documentation ranges
  }
  return false;
}

export async function resolveCallback(raw, resolver = lookup) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('callback must be public HTTPS hostname');
  const addresses = await resolver(url.hostname, { all: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !publicIp(item.address))) throw new Error('callback address is not public');
  return { url, address: addresses[0] };
}

export async function postCallback(raw, { body, headers }, resolver = lookup) {
  const { url, address } = await resolveCallback(raw, resolver);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', timeout: 10_000, servername: url.hostname,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
        if (responseBody.length > 4096) req.destroy(new Error('callback response too large'));
      });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body: responseBody }));
    });
    req.on('timeout', () => req.destroy(new Error('callback timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export function validateSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('invalid signing secret');
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== secret.slice(6)) throw new Error('invalid signing secret');
  return key;
}

export function signWebhook(secret, id, timestamp, body) {
  const mac = createHmac('sha256', validateSecret(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export function equalText(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
