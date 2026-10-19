// Turns raw detection into findings a merchant can act on, plus a savings estimate.
import { readFileSync } from 'node:fs';

const { categories: CATEGORIES, overlaps: OVERLAPS } =
  JSON.parse(readFileSync(new URL('../data/categories.json', import.meta.url)));

// Default monthly cost per paid app when we don't know the real price.
// Source: eightx "Shopify app bloat report 2026" (~$58/month average per paid app).
// The report UI lets the merchant overwrite every number with what they actually pay.
export const DEFAULT_APP_COST = 58;

const FP_BY_ID = Object.fromEntries(
  JSON.parse(readFileSync(new URL('../data/fingerprints.json', import.meta.url))).apps.map((a) => [a.id, a]),
);

// Shared with the report page: given cost per app id, drop all but the priciest.
export function keepPriciest(ids, costs) {
  const sorted = [...ids].sort((a, b) => (costs[b] ?? 0) - (costs[a] ?? 0));
  return sorted.slice(1);
}
const costsDefault = (list) => Object.fromEntries(list.map((a) => [a.id, a.free ? 0 : DEFAULT_APP_COST]));

export function analyze(detection) {
  const apps = detection.apps.map((a) => ({
    ...a,
    nativeReplaceable: !!FP_BY_ID[a.id]?.nativeReplaceable,
    categoryLabel: CATEGORIES[a.category]?.label ?? a.category,
    defaultCost: a.free ? 0 : DEFAULT_APP_COST,
  }));
  const paid = apps.filter((a) => !a.free);
  const byCategory = groupBy(paid, (a) => a.category);
  const findings = [];
  const removable = new Set(); // app ids that could plausibly be cut; each counted once

  // 1. Two or more paid apps doing the same job
  for (const [cat, list] of Object.entries(byCategory)) {
    if (list.length < 2 || CATEGORIES[cat]?.skipDuplicates) continue;
    if (CATEGORIES[cat]?.multiOk) {
      // Running several affiliate networks or attribution tools is often deliberate.
      findings.push({
        type: 'stack', severity: 'low',
        title: `${list.length} tools for ${(CATEGORIES[cat]?.label ?? cat).toLowerCase()}`,
        detail: `${list.map((a) => a.name).join(', ')}. Running several can be deliberate. Check which ones actually bring in sales and drop the rest.`,
        apps: list.map((a) => a.id), removable: [],
      });
      continue;
    }
    // Which one to keep is the merchant's call; savings assume they keep the priciest
    // (the conservative estimate). The report page recalculates as real prices are typed in.
    const cut = keepPriciest(list.map((a) => a.id), costsDefault(list));
    findings.push({
      type: 'duplicate', severity: 'high',
      title: `${list.length} apps doing the same job: ${CATEGORIES[cat]?.label ?? cat}`,
      detail: `${list.map((a) => a.name).join(', ')} all cover ${(CATEGORIES[cat]?.label ?? cat).toLowerCase()}. Most stores need one — keep whichever you rely on most.`,
      apps: list.map((a) => a.id),
      removable: cut,
    });
    cut.forEach((id) => removable.add(id));
  }

  // 2. Cross-category overlaps (e.g. pop-up app + email platform that has pop-ups built in)
  for (const o of OVERLAPS) {
    const [c1, c2] = o.categories;
    if (!byCategory[c1] || !byCategory[c2]) continue;
    const involved = [...byCategory[c1], ...byCategory[c2]];
    const cut = o.redundant ? byCategory[o.redundant].map((a) => a.id) : [];
    findings.push({
      type: 'overlap', severity: o.redundant ? 'medium' : 'low',
      title: `Possible overlap: ${CATEGORIES[c1]?.label} + ${CATEGORIES[c2]?.label}`,
      detail: o.note,
      apps: involved.map((a) => a.id),
      removable: cut,
    });
    cut.forEach((id) => removable.add(id));
  }

  // 2b. Tools meant for the store team that load for every shopper
  for (const a of paid) {
    const msg = CATEGORIES[a.category]?.leftover;
    if (!msg) continue;
    findings.push({
      type: 'leftover', severity: 'medium',
      title: `${a.name} is loading on your live store`,
      detail: `${a.name} ${msg}`,
      apps: [a.id], removable: [a.id],
    });
    removable.add(a.id);
  }

  // 3. Paid apps where Shopify's free first-party tool realistically covers the typical use.
  // Only apps marked nativeReplaceable qualify — telling a merchant to swap Klaviyo for
  // Shopify Email would cost the whole report its credibility.
  for (const a of paid) {
    const native = CATEGORIES[a.category]?.native;
    if (!native || !a.nativeReplaceable || removable.has(a.id)) continue;
    findings.push({
      type: 'native', severity: 'medium',
      title: `${a.name} may be replaceable with a free Shopify feature`,
      detail: `${native}. Check whether it covers the features you actually use before switching.`,
      apps: [a.id],
      removable: [a.id],
    });
    removable.add(a.id);
  }

  // 4. Script weight / speed
  const { scripts } = detection;
  if (scripts.renderBlocking.length) {
    findings.push({
      type: 'speed', severity: scripts.renderBlocking.length > 2 ? 'high' : 'medium',
      title: `${scripts.renderBlocking.length} third-party script${plural(scripts.renderBlocking.length)} ${scripts.renderBlocking.length === 1 ? 'blocks' : 'block'} the page from rendering`,
      detail: 'These load in the <head> without async/defer, so shoppers stare at a blank page until they finish. Ask the app vendor for an async embed or remove the app.',
      apps: [], removable: [], urls: scripts.renderBlocking,
    });
  }
  if (scripts.thirdPartyHosts.length >= 10) {
    findings.push({
      type: 'speed', severity: scripts.thirdPartyHosts.length >= 20 ? 'high' : 'medium',
      title: `Scripts load from ${scripts.thirdPartyHosts.length} different third-party domains`,
      detail: 'Each domain adds a connection and download before the page is fully interactive. Uninstalled apps often leave scripts behind — check for any you no longer recognize.',
      apps: [], removable: [], hosts: scripts.thirdPartyHosts,
    });
  }

  // 5. Theme app extensions we couldn't identify — still apps the merchant is running
  if (detection.unidentifiedExtensions.length) {
    findings.push({
      type: 'unknown', severity: 'low',
      title: `${detection.unidentifiedExtensions.length} more app embed${plural(detection.unidentifiedExtensions.length)} we couldn't name`,
      detail: 'These are apps loading through your theme. Check Online Store → Themes → Customize → App embeds and turn off any you don\'t use.',
      apps: [], removable: [], extensions: detection.unidentifiedExtensions,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const estMonthlySpend = paid.length * DEFAULT_APP_COST;
  const estMonthlySavings = [...removable].length * DEFAULT_APP_COST;

  return {
    apps,
    findings,
    removableAppIds: [...removable],
    scripts,
    summary: {
      appsDetected: apps.length,
      paidAppsDetected: paid.length,
      unidentifiedEmbeds: detection.unidentifiedExtensions.length,
      estMonthlySpend,
      estMonthlySavings,
      estYearlySavings: estMonthlySavings * 12,
      score: score(findings, scripts),
      defaultAppCost: DEFAULT_APP_COST,
    },
  };
}

function score(findings, scripts) {
  let s = 100;
  for (const f of findings) {
    if (f.type === 'duplicate') s -= 12;
    else if (f.type === 'leftover') s -= 6;
    else if (f.type === 'overlap') s -= f.severity === 'medium' ? 8 : 4;
    else if (f.type === 'native') s -= 5;
  }
  s -= Math.min(15, scripts.renderBlocking.length * 3);
  s -= Math.min(10, Math.max(0, scripts.thirdPartyHosts.length - 10));
  return Math.max(0, Math.min(100, Math.round(s)));
}

const plural = (n) => (n === 1 ? '' : 's');
function groupBy(arr, fn) {
  return arr.reduce((acc, x) => ((acc[fn(x)] ??= []).push(x), acc), {});
}
