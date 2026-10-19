// Fetches the pages of a store worth scanning and runs detection + analysis on them.
import { safeFetch } from './safe-fetch.js';
import { detect, looksLikeShopify } from './detect.js';
import { analyze } from './analyze.js';

export function normalizeStoreUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a store URL');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  return `https://${u.hostname.toLowerCase()}`;
}

// "demo" runs the audit on bundled sample pages — handy for showing prospects
// what a report looks like, and for working on the UI offline.
async function scanDemo() {
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../test/fixtures/', import.meta.url);
  const pages = [
    { url: 'https://demo-outdoor.com/', html: await readFile(new URL('home.html', dir), 'utf8'), kind: 'home' },
    { url: 'https://demo-outdoor.com/products/trail-jacket', html: await readFile(new URL('product.html', dir), 'utf8'), kind: 'product' },
  ];
  return { store: 'demo-outdoor.com (sample)', scannedAt: new Date().toISOString(), pagesScanned: pages.map((p) => p.kind), ...analyze(detect(pages, 'demo-outdoor.com')) };
}

export async function scanStore(input) {
  if (String(input).trim().toLowerCase() === 'demo') return scanDemo();
  const origin = normalizeStoreUrl(input);
  const home = await safeFetch(`${origin}/`);
  if (home.status >= 400) throw new Error(`The store returned HTTP ${home.status}`);
  const finalOrigin = new URL(home.url).origin;
  const storeHost = new URL(finalOrigin).hostname;

  if (/password/i.test(new URL(home.url).pathname)) {
    throw new Error('This store is password-protected, so its storefront can’t be scanned yet');
  }
  if (!looksLikeShopify(home.body)) throw new Error('That doesn’t look like a Shopify store');

  const pages = [{ url: home.url, html: home.body, kind: 'home' }];

  // Product pages carry review, upsell and size-chart widgets the homepage often doesn't.
  try {
    const pj = await safeFetch(`${finalOrigin}/products.json?limit=1`);
    const handle = JSON.parse(pj.body)?.products?.[0]?.handle;
    if (handle) {
      const prod = await safeFetch(`${finalOrigin}/products/${encodeURIComponent(handle)}`);
      if (prod.status < 400) pages.push({ url: prod.url, html: prod.body, kind: 'product' });
    }
  } catch { /* products.json can be disabled; homepage-only scan is still useful */ }

  try {
    const cart = await safeFetch(`${finalOrigin}/cart`);
    if (cart.status < 400) pages.push({ url: cart.url, html: cart.body, kind: 'cart' });
  } catch { /* optional */ }

  const detection = detect(pages, storeHost);
  return {
    store: storeHost,
    scannedAt: new Date().toISOString(),
    pagesScanned: pages.map((p) => p.kind),
    ...analyze(detection),
  };
}
