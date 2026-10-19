// Builds dist/preview.html: a single static page that shows the sample report with no server.
// Use it to show prospects what they'll get, or post it as a "see an example" link.
//   npm run preview
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { scanStore } from '../src/scan.js';

const root = new URL('..', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

const [index, css, js, report] = await Promise.all([
  read('public/index.html'), read('public/styles.css'), read('public/app.js'), scanStore('demo'),
]);

const fonts = index.match(/<link href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];
const body = index
  .slice(index.indexOf('<body>') + 6, index.indexOf('</body>'))
  .replace(/<script src="\/app\.js"[^>]*><\/script>/, '');

const notice = 'Sample report for a fictional store. Edit the prices in the bill to see the totals recalculate. The live tool scans any real Shopify store.';

// In the preview, "scanning" any URL returns the sample and the email form explains itself.
const stub = `
window.__PRELOAD = ${JSON.stringify({ report, notice })};
const __realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url === '/api/scan') { await new Promise((r) => setTimeout(r, 2200)); return json(200, window.__PRELOAD.report); }
  if (url === '/api/lead') return json(400, { error: 'This is a preview, so no email is sent.' });
  return __realFetch(url, opts);
};`;

const page = `<title>StackAudit Preview</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts}
<style>
${css}
</style>
${body}
<script>${stub}</script>
<script type="module">
${js}
</script>
`;

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/preview.html', root), page);
console.log('Wrote dist/preview.html');
