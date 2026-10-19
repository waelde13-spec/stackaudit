// Fetches a public web page while refusing anything that resolves to a private,
// loopback or link-local address (SSRF protection). The IP check runs inside the
// socket's DNS lookup, so a hostname can't pass the check and then re-resolve to
// an internal address (DNS rebinding).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'StackAuditBot/0.1 (+https://stackaudit.example/bot)';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return (
    v6 === '::' || v6 === '::1' ||
    v6.startsWith('fc') || v6.startsWith('fd') ||   // unique local
    v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || // link-local
    v6.startsWith('ff')                               // multicast
  );
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isPrivateIp(a.address));
    if (bad) return callback(Object.assign(new Error(`Blocked private address for ${hostname}`), { code: 'EBLOCKED' }));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new Error('Only http(s) URLs are allowed'));
    if (url.port && !['80', '443'].includes(url.port)) return reject(new Error('Non-standard ports are not allowed'));
    if (net.isIP(url.hostname)) return reject(new Error('Enter a store domain, not an IP address'));

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url).toString(), status: res.statusCode });
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'deflate' ? res.pipe(zlib.createInflate())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks = []; let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); stream.destroy(); reject(new Error('Page too large')); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url: url.toString() }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function safeFetch(urlString) {
  let current = urlString;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestOnce(current);
    if (!res.redirect) return res;
    current = res.redirect;
  }
  throw new Error('Too many redirects');
}
