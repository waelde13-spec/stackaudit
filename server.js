// StackAudit server — zero dependencies, Node 20+.
//   GET  /            the report page
//   POST /api/scan    { url }                     -> audit JSON
//   POST /api/lead    { email, store, savings }   -> saves a lead
import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStore, normalizeStoreUrl } from './src/scan.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const LEADS_FILE = process.env.LEADS_FILE || join(ROOT, 'leads', 'leads.jsonl');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// --- tiny in-memory rate limit + cache (fine for one instance; swap for Redis later)
const hits = new Map();          // ip -> [timestamps]
const SCANS_PER_HOUR = Number(process.env.SCANS_PER_HOUR) || 12;
const cache = new Map();         // store host -> { at, result }
const CACHE_MS = 60 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > SCANS_PER_HOUR;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req, limit = 10_000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('Request too large');
  }
  return JSON.parse(data || '{}');
}

const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const { url: storeUrl } = await readJson(req);
      if (String(storeUrl).trim().toLowerCase() === 'demo') return send(res, 200, await scanStore('demo'));
      let host;
      try { host = new URL(normalizeStoreUrl(storeUrl)).hostname; } catch (e) { return send(res, 400, { error: e.message }); }

      const hit = cache.get(host);
      if (hit && Date.now() - hit.at < CACHE_MS) return send(res, 200, hit.result);
      if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many scans from your connection. Try again in an hour.' });

      try {
        const result = await scanStore(storeUrl);
        cache.set(host, { at: Date.now(), result });
        return send(res, 200, result);
      } catch (e) {
        const msg = e.code === 'ENOTFOUND' ? 'We couldn’t find that domain.'
          : e.code === 'EBLOCKED' ? 'That address isn’t allowed.'
          : e.message || 'Scan failed';
        return send(res, 422, { error: msg });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/lead') {
      const { email, store, savings } = await readJson(req);
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
        return send(res, 400, { error: 'Enter a valid email' });
      }
      await mkdir(join(LEADS_FILE, '..'), { recursive: true });
      await appendFile(LEADS_FILE, JSON.stringify({
        email: email.trim().toLowerCase(),
        store: String(store || '').slice(0, 200),
        savings: Number(savings) || 0,
        at: new Date().toISOString(),
      }) + '\n');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC, path));
      if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
      try {
        return send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
      } catch {
        return send(res, 404, 'Not found', 'text/plain');
      }
    }

    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Bad request' });
  }
});

server.listen(PORT, () => console.log(`StackAudit running on http://localhost:${PORT}`));
