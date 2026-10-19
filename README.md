# StackAudit

A free Shopify app-bloat audit. A merchant pastes their store URL and gets an itemized "app bill":

- **Duplicate apps.** Two review apps, two chat widgets, and so on.
- **Overlaps.** For example, a pop-up app on top of an email platform that already has pop-ups.
- **Free Shopify replacements.** Only flagged where Shopify's free tool realistically covers the job, such as Weglot → Translate & Adapt or Privy → Shopify Forms. It never suggests swapping Klaviyo for Shopify Email.
- **Speed problems.** Render-blocking third-party scripts, too many script domains, and app embeds nobody remembers installing.
- **A savings figure.** It starts from a $58/mo average per paid app, and the merchant overwrites it with their real prices so the total recalculates live.

It works on **any** public Shopify storefront with no install or login, so it doubles as a lead magnet. The email form at the end collects leads.

## Run it

Requires Node 20+. There are no dependencies to install.

```bash
npm start              # http://localhost:3000
npm test               # 10 tests: detection, analysis, SSRF guards
npm run scan -- allbirds.com   # scan a real store from the terminal
npm run preview        # build dist/preview.html, a static sample report
```

Type `demo` into the URL box to see a full sample report without scanning anything.

## Before launch: tune the fingerprints (day 1–2)

`data/fingerprints.json` is a seed list of about 50 apps. Detection is only as good as this file.

1. Pick 10–15 stores whose apps you know. Good sources are app-store "featured merchant" lists, your own dev store, or stores that show the app's branding (e.g. a "Powered by Judge.me" badge).
2. Run `npm run scan -- <store>` on each.
3. For anything missed, check the store's page source for the app's script domain and add it to `patterns`.
4. The **"unnamed app embeds"** section of each scan prints folder names like `mystery-countdown`. These are apps you haven't fingerprinted yet. Add the popular ones.

To mark an app as replaceable by a free Shopify feature, set `"nativeReplaceable": true`. Be conservative here, because one bad suggestion makes merchants distrust the whole report.

## Deploy (day 3)

It's a single Node process, so any Node host works:

- **Render / Railway / Fly.io.** Connect the repo, use start command `npm start`, and the host sets `PORT` automatically.
- Set `LEADS_FILE` to a path on a persistent disk, or the leads file is wiped on redeploy.
- When you're ready, swap the leads file for a real list. The `/api/lead` handler in `server.js` is about 10 lines, so point it at Resend, ConvertKit, or a Google Sheet.

The rate limit is 12 scans/hour per IP (`SCANS_PER_HOUR`), and results are cached for an hour per store. Both are in memory, which is fine for one instance.

## How detection works

- It fetches the homepage, one product page (found via `/products.json`), and the cart.
- It matches script, link, and iframe URLs against known app domains. That's high confidence. A match only in the page source is medium confidence.
- Theme app extensions load from `cdn.shopify.com/extensions/<id>/<app-folder>/`. The folder name usually identifies the app. Unrecognized folders are still counted as apps.
- Back-office apps (inventory, shipping, accounting) never touch the storefront, so they can't be seen. The report says so, and merchants can add them to the bill by hand.

**Security:** every fetch goes through `src/safe-fetch.js`. It allows only http(s) on ports 80/443, rejects raw IPs, and checks resolved addresses inside the socket's DNS lookup, so private, loopback, and cloud-metadata addresses are refused even under DNS rebinding. Responses are capped at 3 MB with a 10s timeout.

## Roadmap

1. **Paid tier ($9–19/mo):** monthly re-scan plus an email when a new app embed appears or a script starts blocking rendering. Most of this already exists, since it's a scheduled `scanStore()` and a diff.
2. **Removal checklists:** for each flagged app, the steps to uninstall cleanly and remove leftover theme code. This is what the email capture promises, so build it next.
3. **Embedded Shopify app (later):** with the `read_themes` scope, an installed app can read the theme's `config/settings_data.json` and template JSON, which list every enabled app embed and block. That's more complete than the storefront scan. Note that Shopify doesn't offer public apps an API to list a store's other installed apps, so theme files plus the storefront are the realistic sources.

## Files

```
server.js              HTTP server: page, /api/scan, /api/lead
src/safe-fetch.js      SSRF-safe page fetcher
src/scan.js            which pages to fetch; demo mode
src/detect.js          app fingerprinting + script analysis (pure, testable)
src/analyze.js         findings, savings, score
data/fingerprints.json known apps and their script patterns
data/categories.json   categories, free Shopify alternatives, overlap rules
public/                the report page
scripts/               terminal scanner, preview builder
test/                  tests + sample store pages
```
