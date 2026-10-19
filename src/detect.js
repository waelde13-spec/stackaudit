// Pure detection logic: takes page HTML strings, returns what apps/scripts are on them.
// No network access here, so it can be tested against saved pages.
import { readFileSync } from 'node:fs';

const { apps: FINGERPRINTS } = JSON.parse(readFileSync(new URL('../data/fingerprints.json', import.meta.url)));

// Hosts that belong to Shopify itself or the store — not third-party app scripts.
const FIRST_PARTY = [
  'cdn.shopify.com', 'shopify.com', 'myshopify.com', 'shopifycdn.com', 'shopifycloud.com',
  'shop.app', 'shopifysvc.com', 'monorail-edge.shopifysvc.com',
];
// Common non-app infrastructure we don't count as app bloat.
const INFRA = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.googletagmanager.com', 'www.google-analytics.com',
  'connect.facebook.net', 'analytics.tiktok.com', 'static.ads-twitter.com', 'snap.licdn.com', 'bat.bing.com'];

const TAG_RE = /<(script|link|iframe)\b([^>]*)>/gi;
const ATTR_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

export function extractResources(html, baseUrl) {
  const resources = [];
  let inHead = true;
  const headEnd = html.search(/<\/head>/i);
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const [, tag, attrs] = m;
    inHead = headEnd === -1 ? false : m.index < headEnd;
    const attrName = tag.toLowerCase() === 'link' ? 'href' : 'src';
    const am = attrs.match(ATTR_RE(attrName));
    if (!am) continue;
    const raw = (am[1] ?? am[2] ?? am[3] ?? '').trim();
    if (!raw || raw.startsWith('data:')) continue;
    let url;
    try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, baseUrl); } catch { continue; }
    resources.push({
      tag: tag.toLowerCase(),
      url: url.toString(),
      host: url.hostname.toLowerCase(),
      inHead,
      async: /\b(async|defer)\b/i.test(attrs) || /type\s*=\s*["']?module/i.test(attrs),
    });
  }
  return resources;
}

const isFirstParty = (host, storeHost) =>
  host === storeHost || FIRST_PARTY.some((d) => host === d || host.endsWith(`.${d}`));
const isInfra = (host) => INFRA.includes(host);

// Theme app extensions (app embeds/blocks) load assets from /extensions/<id>/<name>/...
const EXT_RE = /(?:cdn\.shopify\.com|\/cdn\/shop)\/extensions\/([a-z0-9-]{8,})\/([a-z0-9._-]+)\//gi;

export function detect(pages, storeHost) {
  const allResources = [];
  const sourceText = [];
  for (const p of pages) {
    allResources.push(...extractResources(p.html, p.url));
    sourceText.push(p.html.toLowerCase());
  }
  const joined = sourceText.join('\n');
  const urls = allResources.map((r) => r.url.toLowerCase());

  // 1. Known apps
  const detected = [];
  for (const fp of FINGERPRINTS) {
    const urlHit = fp.patterns.find((p) => urls.some((u) => u.includes(p.toLowerCase())));
    const srcHit = urlHit ? null : fp.patterns.find((p) => joined.includes(p.toLowerCase()));
    if (urlHit || srcHit) {
      detected.push({
        id: fp.id, name: fp.name, category: fp.category, free: !!fp.free,
        confidence: urlHit ? 'high' : 'medium',
        evidence: urlHit || srcHit,
      });
    }
  }

  // 2. Theme app extensions we couldn't name
  const extensions = new Map();
  let em;
  EXT_RE.lastIndex = 0;
  while ((em = EXT_RE.exec(joined))) {
    const [, id, folder] = em;
    if (!extensions.has(id)) extensions.set(id, folder.replace(/-\d+(\.\d+)*$/, ''));
  }
  // Extension folders are usually named after the app ("vitals-app-412", "kiwi-size-chart-15"),
  // so they can identify apps on their own, and confirm ones already found.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const unidentifiedExtensions = [];
  for (const [id, folder] of extensions) {
    const f = norm(folder);
    const fp = FINGERPRINTS.find((x) => f.includes(norm(x.id)) || f.includes(norm(x.name)));
    if (!fp) { unidentifiedExtensions.push({ id, folder }); continue; }
    const existing = detected.find((d) => d.id === fp.id);
    if (existing) { existing.confidence = 'high'; continue; }
    detected.push({ id: fp.id, name: fp.name, category: fp.category, free: !!fp.free, confidence: 'high', evidence: `theme embed: ${folder}` });
  }

  // 3. Script weight
  const scripts = allResources.filter((r) => r.tag === 'script');
  const uniqueScripts = [...new Map(scripts.map((s) => [s.url, s])).values()];
  const thirdParty = uniqueScripts.filter((s) => !isFirstParty(s.host, storeHost));
  const thirdPartyApps = thirdParty.filter((s) => !isInfra(s.host));
  const renderBlocking = uniqueScripts.filter((s) => s.inHead && !s.async && !isFirstParty(s.host, storeHost));

  return {
    apps: detected,
    unidentifiedExtensions,
    scripts: {
      total: uniqueScripts.length,
      thirdParty: thirdParty.length,
      thirdPartyHosts: [...new Set(thirdPartyApps.map((s) => s.host))].sort(),
      renderBlocking: renderBlocking.map((s) => s.url),
    },
  };
}

export function looksLikeShopify(html) {
  const h = html.toLowerCase();
  return h.includes('cdn.shopify.com') || h.includes('shopify.shop') || h.includes('/cdn/shop/') || h.includes('shopify-section');
}
