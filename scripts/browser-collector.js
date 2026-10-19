// Paste-able collector: run in a browser tab that has a Shopify store open (DevTools console
// or an automation tool). It gathers what StackAudit's server-side scanner would see, plus
// scripts injected after load, and returns compact "pages" for `node scripts/scan-captured.js`.
// Used for tuning fingerprints from a machine whose shell can't reach the open web.
(async () => {
  const PATTERNS = __PATTERNS__;
  const EXT = /(?:cdn\.shopify\.com|\/cdn\/shop)\/extensions\/[a-z0-9-]{8,}\/[a-z0-9._-]+\//gi;
  const esc = (s) => s.replace(/"/g, '&quot;');

  // Drop the store's own theme/Shopify assets to keep the capture small; keep app proxies and embeds.
  function worthKeeping(u) {
    if (!u) return false;
    try {
      const url = new URL(u, location.href);
      const own = url.hostname === location.hostname || url.hostname.endsWith('shopify.com') || url.hostname === 'shop.app';
      return !own || /\/(extensions|apps|a)\//.test(url.pathname);
    } catch { return false; }
  }

  function synth(raw, extraUrls = []) {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const tag = (el) => {
      const t = el.tagName.toLowerCase();
      const url = el.getAttribute(t === 'link' ? 'href' : 'src');
      if (!url || url.startsWith('data:')) return '';
      const flags = [el.hasAttribute('async') && 'async', el.hasAttribute('defer') && 'defer',
        el.getAttribute('type') === 'module' && 'type="module"'].filter(Boolean).join(' ');
      return `<${t} ${t === 'link' ? 'href' : 'src'}="${esc(url)}" ${flags}></${t}>`;
    };
    const sel = 'script[src],iframe[src],link[rel~=stylesheet][href],link[rel~=preload][href],link[rel~=modulepreload][href]';
    const keep = (el) => worthKeeping(el.getAttribute(el.tagName === 'LINK' ? 'href' : 'src'));
    const head = [...doc.head.querySelectorAll(sel)].filter(keep).map(tag).join('\n');
    const body = [...doc.body.querySelectorAll(sel)].filter(keep).map(tag).join('\n');
    const late = extraUrls.filter(worthKeeping).map((u) => `<script src="${esc(u)}" async></script>`).join('\n');
    const lower = raw.toLowerCase();
    const hits = PATTERNS.filter((p) => lower.includes(p.toLowerCase())).map((p) => `<!-- ${p} -->`).join('\n');
    const exts = [...new Set(raw.match(EXT) || [])].map((u) => `<!-- ${u} -->`).join('\n');
    const shopify = lower.includes('cdn.shopify.com') || lower.includes('shopify-section') ? '<!-- cdn.shopify.com -->' : '';
    return `<html><head>\n${head}\n</head><body>\n${body}\n${late}\n${hits}\n${exts}\n${shopify}\n</body></html>`;
  }

  const get = (p) => fetch(p, { credentials: 'omit' }).then((r) => (r.ok ? r.text() : ''));
  await new Promise((r) => setTimeout(r, 4000)); // let apps inject their scripts
  const live = [...new Set(performance.getEntriesByType('resource')
    .filter((e) => ['script', 'iframe', 'link'].includes(e.initiatorType))
    .map((e) => e.name.split('#')[0]))];

  const pages = [{ kind: 'home', url: location.origin + '/', html: synth(await get('/'), live) }];
  try {
    const handle = JSON.parse(await get('/products.json?limit=1')).products?.[0]?.handle;
    if (handle) pages.push({ kind: 'product', url: `${location.origin}/products/${handle}`, html: synth(await get(`/products/${handle}`)) });
  } catch {}
  const cart = await get('/cart');
  if (cart) pages.push({ kind: 'cart', url: location.origin + '/cart', html: synth(cart) });
  return JSON.stringify({ store: location.hostname, pages });
})();
