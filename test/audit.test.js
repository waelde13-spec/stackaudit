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

// ---- regression fixtures from live stores ----
const real = JSON.parse(readFileSync(new URL('./fixtures/real-stores.json', import.meta.url), 'utf8')).stores;
const toPage = (s) => {
  const tags = [
    ...s.hosts.map((h) => `<script src="https://${h}" async></script>`),
    ...s.proxies.map((p) => `<script src="https://${s.store}${p}/x.js" async></script>`),
    ...s.exts.map((e, i) => `<script src="https://cdn.shopify.com/extensions/0190aaaa-bbbb-7ccc-8ddd-00000000000${i}/${e}-12/assets/a.js" defer></script>`),
  ];
  return { url: `https://${s.store}/`, html: `<html><head></head><body class="shopify-section">${tags.join('\n')}</body></html>` };
};

for (const s of real) {
  test(`live store: ${s.store}`, () => {
    const d = detect([toPage(s)], s.store);
    const ids = d.apps.map((a) => a.id);
    for (const id of s.expected) assert.ok(ids.includes(id), `missed ${id}; got ${ids.join(',')}`);
    for (const id of s.notExpected || []) assert.ok(!ids.includes(id), `false positive ${id}`);
    const r = analyze(d);
    assert.ok(!r.findings.some((f) => f.type === 'duplicate' && f.apps.includes('yotpo-suite')));
    for (const h of d.scripts.thirdPartyHosts) assert.ok(!/doubleclick|facebook|googletagmanager|taboola|outbrain|bing/.test(h), `ad pixel counted: ${h}`);
  });
}

test('live store findings are sensible', () => {
  const report = (name) => analyze(detect([toPage(real.find((s) => s.store === name))], name));
  const ridge = report('ridge.com');
  const t = (r) => r.findings.map((f) => f.title).join('\n');
  assert.match(t(ridge), /Email marketing \+ Email & SMS/);            // Klaviyo + Mailchimp
  assert.ok(ridge.removableAppIds.includes('mailchimp'));
  assert.match(t(ridge), /5 tools for affiliate & referral programs/);   // several affiliate networks: low, not a cut
  assert.ok(!ridge.removableAppIds.some((id) => ['shareasale', 'awin', 'superfiliate', 'socialsnowball', 'growi'].includes(id)));
  const colourpop = report('colourpop.com');
  assert.match(t(colourpop), /2 apps doing the same job: Cookie consent/); // OneTrust + GDPR Cookie Consent
  assert.match(t(colourpop), /Yotpo widgets/);
});
