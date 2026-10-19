import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detect, looksLikeShopify } from '../src/detect.js';
import { analyze } from '../src/analyze.js';
import { isPrivateIp } from '../src/safe-fetch.js';
import { normalizeStoreUrl, scanStore } from '../src/scan.js';

const page = (f, url) => ({ url, html: readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8') });
const pages = [page('home.html', 'https://demo-outdoor.com/'), page('product.html', 'https://demo-outdoor.com/products/x')];

test('recognizes a Shopify storefront', () => {
  assert.ok(looksLikeShopify(pages[0].html));
  assert.ok(!looksLikeShopify('<html><script src="/wp-content/x.js"></script></html>'));
});

test('detects known apps from script URLs and theme embeds', () => {
  const d = detect(pages, 'demo-outdoor.com');
  const ids = d.apps.map((a) => a.id).sort();
  for (const id of ['klaviyo', 'privy', 'hotjar', 'weglot', 'vitals', 'hextom', 'tidio', 'gorgias', 'attentive', 'judgeme', 'loox', 'rebuy', 'fastbundle', 'kiwisizing']) {
    assert.ok(ids.includes(id), `expected ${id} in ${ids.join(',')}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'no duplicate detections');
});

test('names extension embeds it can and lists the rest as unidentified', () => {
  const d = detect(pages, 'demo-outdoor.com');
  assert.deepEqual(d.unidentifiedExtensions.map((e) => e.folder), ['mystery-countdown']);
});

test('ignores first-party Shopify assets and flags render-blocking third-party scripts', () => {
  const d = detect(pages, 'demo-outdoor.com');
  assert.ok(!d.scripts.thirdPartyHosts.includes('demo-outdoor.com'));
  assert.ok(!d.scripts.thirdPartyHosts.includes('cdn.shopify.com'));
  assert.ok(!d.scripts.thirdPartyHosts.includes('www.googletagmanager.com'), 'analytics infra not counted as app bloat');
  const blocking = d.scripts.renderBlocking.join(' ');
  assert.match(blocking, /privy/);
  assert.match(blocking, /hotjar/);
  assert.doesNotMatch(blocking, /klaviyo/, 'async scripts are not render-blocking');
});

test('finds duplicates, overlaps and native replacements without double-counting savings', () => {
  const r = analyze(detect(pages, 'demo-outdoor.com'));
  const titles = r.findings.map((f) => f.title).join('\n');
  assert.match(titles, /2 apps doing the same job: Product reviews/);
  assert.match(titles, /2 apps doing the same job: Live chat/);
  assert.match(titles, /Pop-ups & signup forms \+ Email/);
  assert.match(titles, /Weglot may be replaceable/);
  // Credibility guards: email + dedicated SMS is a normal setup, and big platforms
  // never get a "replace with free Shopify feature" suggestion.
  assert.doesNotMatch(titles, /same job: Email/);
  assert.match(titles, /SMS marketing \+ Email & SMS marketing/);
  for (const big of ['Klaviyo', 'Attentive', 'Rebuy', 'Gorgias']) assert.doesNotMatch(titles, new RegExp(`${big} may be replaceable`));
  assert.ok(!r.removableAppIds.includes('klaviyo') && !r.removableAppIds.includes('attentive'));
  assert.equal(new Set(r.removableAppIds).size, r.removableAppIds.length);
  assert.equal(r.summary.estMonthlySavings, r.removableAppIds.length * r.summary.defaultAppCost);
  assert.ok(r.summary.score >= 0 && r.summary.score <= 100);
  // Duplicates keep one app: one of judge.me/loox stays.
  const reviewsCut = r.removableAppIds.filter((id) => ['judgeme', 'loox'].includes(id));
  assert.equal(reviewsCut.length, 1);
});

test('a lean store gets a clean report', () => {
  const html = '<html><head><script src="https://cdn.shopify.com/s/files/x.js"></script></head><body class="shopify-section"></body></html>';
  const r = analyze(detect([{ url: 'https://lean.com/', html }], 'lean.com'));
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.score, 100);
  assert.equal(r.summary.estMonthlySavings, 0);
});

test('blocks private and internal addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['23.227.38.65', '8.8.8.8', '2606:4700::1']) assert.ok(!isPrivateIp(ip), ip);
});

test('normalizes store URLs', () => {
  assert.equal(normalizeStoreUrl('Example.com/products/x?y=1'), 'https://example.com');
  assert.equal(normalizeStoreUrl('http://shop.example.com'), 'https://shop.example.com');
  assert.throws(() => normalizeStoreUrl(''));
});

test('refuses to scan localhost', async () => {
  await assert.rejects(scanStore('localhost'), /Blocked|private|allowed|ENOTFOUND|EBLOCKED/i);
});

test('demo mode produces a full report', async () => {
  const r = await scanStore('demo');
  assert.ok(r.apps.length >= 10);
  assert.ok(r.findings.length > 0);
});
