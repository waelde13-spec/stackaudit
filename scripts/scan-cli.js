// Scan a store from the terminal:  npm run scan -- allbirds.com
// Use this to tune data/fingerprints.json against stores whose apps you already know.
import { scanStore } from '../src/scan.js';

const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run scan -- <store-domain>');
  process.exit(1);
}

try {
  const r = await scanStore(target);
  console.log(`\n${r.store}  —  score ${r.summary.score}/100  (pages: ${r.pagesScanned.join(', ')})\n`);
  console.log('Apps detected:');
  for (const a of r.apps) console.log(`  • ${a.name.padEnd(24)} ${a.categoryLabel.padEnd(32)} ${a.confidence}  [${a.evidence}]`);
  if (!r.apps.length) console.log('  (none from the fingerprint list)');
  console.log(`\nUnnamed app embeds: ${r.summary.unidentifiedEmbeds}`);
  for (const e of r.findings.find((f) => f.type === 'unknown')?.extensions ?? []) console.log(`  ? ${e.folder}  (${e.id})`);
  console.log(`\nThird-party script hosts (${r.scripts.thirdPartyHosts.length}):`);
  for (const h of r.scripts.thirdPartyHosts) console.log(`  - ${h}`);
  console.log('\nFindings:');
  for (const f of r.findings) console.log(`  [${f.severity}] ${f.title}`);
  console.log(`\nEst. savings: $${r.summary.estMonthlySavings}/mo  ($${r.summary.estYearlySavings}/yr)\n`);
} catch (e) {
  console.error('Scan failed:', e.message);
  process.exit(1);
}
