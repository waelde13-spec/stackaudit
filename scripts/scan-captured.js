// Run the audit on pages captured by scripts/browser-collector.js.
//   node scripts/scan-captured.js captures/*.json
import { readFileSync } from 'node:fs';
import { detect } from '../src/detect.js';
import { analyze } from '../src/analyze.js';

for (const file of process.argv.slice(2)) {
  const cap = JSON.parse(readFileSync(file, 'utf8'));
  const r = analyze(detect(cap.pages, cap.store));
  console.log(`\n=== ${cap.store}  score ${r.summary.score}/100  pages: ${cap.pages.map((p) => p.kind).join(',')}`);
  console.log('apps:     ' + (r.apps.map((a) => `${a.name}${a.confidence === 'high' ? '' : '?'}`).join(', ') || '(none)'));
  const unk = r.findings.find((f) => f.type === 'unknown')?.extensions ?? [];
  console.log('unnamed:  ' + (unk.map((e) => e.folder).join(', ') || '-'));
  console.log('hosts:    ' + r.scripts.thirdPartyHosts.join(', '));
  console.log('findings: ' + r.findings.map((f) => `[${f.severity[0]}] ${f.title}`).join(' | '));
}
