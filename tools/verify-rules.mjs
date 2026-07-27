/**
 * Checks the shipped rules against live sites.
 *
 * This is not a one-off audit. Consent platforms change their markup on their
 * own schedule, and the whole premise of this project is noticing that before
 * users do - every competing extension died by going stale, not by being
 * wrong at launch. So this is a tool meant to be re-run.
 *
 *   node tools/verify-rules.mjs                 # probe only, no clicking
 *   node tools/verify-rules.mjs --execute       # also run the refusal flow
 *   node tools/verify-rules.mjs --headed        # watch it happen
 *   node tools/verify-rules.mjs --site bbc.com  # single site
 *
 * Probe mode reports whether each rule's selectors resolve on the real page.
 * It never clicks, so it is safe to run broadly and fast. --execute additionally
 * performs the refusal and re-probes, which is the only way to catch rules that
 * resolve but do not actually work.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

import { resolveTextMatchRefs } from '../src/rules/expandTextMatchRefs.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT_DIR = join(root, 'verification');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const HEADED = args.includes('--headed');
const ONLY = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
const NAV_TIMEOUT = 45_000;
// A fixed wait is the wrong instrument: consent platforms load on their own
// schedule, and Cookiebot on its own site takes over 6s. The extension does not
// wait either - it observes until something appears. So does this, and it
// records how long detection took, which is useful data in its own right.
const DETECT_POLL_MS = 500;
const DETECT_MAX_MS = 20_000;

function loadRuleset() {
  const rules = JSON.parse(readFileSync(join(root, 'src/rules/rules.json'), 'utf8'));
  const labels = JSON.parse(readFileSync(join(root, 'src/rules/labels.json'), 'utf8'));
  return resolveTextMatchRefs(rules, labels);
}

function loadSites() {
  const sites = JSON.parse(readFileSync(join(here, 'verify-sites.json'), 'utf8'));
  return ONLY ? sites.filter((s) => s.url.includes(ONLY)) : sites;
}

/** Bundles the probe from the real engine sources so nothing is reimplemented. */
async function buildProbe() {
  const result = await build({
    entryPoints: [join(here, 'probe-entry.js')],
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
  });
  return result.outputFiles[0].text;
}

function verdict(site, probe) {
  if (!probe.cmpId) {
    return probe.suspected > 0 ? 'BANNER NON COPERTO' : 'nessun banner';
  }
  if (site.expect && probe.cmpId !== site.expect) return `CMP DIVERSO (${probe.cmpId})`;
  const required = probe.steps.filter((s) => !s.optional);
  const missing = required.filter((s) => !s.found);
  if (missing.length) return `SELETTORI MANCANTI (${missing.length}/${required.length})`;
  return 'ok';
}

async function probeSite(context, site, ruleset, probeSource) {
  const page = await context.newPage();
  const record = { url: site.url, expect: site.expect || null };
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.addScriptTag({ content: probeSource });

    const startedAt = Date.now();
    let before = null;
    while (Date.now() - startedAt < DETECT_MAX_MS) {
      before = await page.evaluate((rs) => window.__crProbe.run(rs), ruleset);
      if (before.cmpId) break;
      await page.waitForTimeout(DETECT_POLL_MS);
    }
    // One last look once the window closes, so a late banner that never matched
    // a known CMP is still reported as an uncovered banner rather than nothing.
    if (!before || !before.cmpId) {
      before = await page.evaluate((rs) => window.__crProbe.run(rs), ruleset);
    }
    record.detectMs = before.cmpId ? Date.now() - startedAt : null;
    record.before = before;
    record.verdict = verdict(site, before);

    if (EXECUTE && before.cmpId) {
      await page.screenshot({ path: join(OUT_DIR, `${site.slug}-prima.png`) }).catch(() => {});
      // Execute the real flow through the engine, in the page, exactly as the
      // extension would - including the click simulation and waits.
      await page.evaluate(async ({ rs, id }) => {
        const cmp = rs.cmps.find((c) => c.id === id);
        if (cmp && window.__crRunFlow) await window.__crRunFlow(cmp.flow);
      }, { rs: ruleset, id: before.cmpId });
      await page.waitForTimeout(2500);
      record.after = await page.evaluate((rs) => window.__crProbe.run(rs), ruleset);
      await page.screenshot({ path: join(OUT_DIR, `${site.slug}-dopo.png`) }).catch(() => {});
    }
  } catch (error) {
    record.verdict = 'ERRORE';
    record.error = String(error).split('\n')[0].slice(0, 120);
  } finally {
    await page.close().catch(() => {});
  }
  return record;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ruleset = loadRuleset();
  const sites = loadSites();
  const probeSource = await buildProbe();

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    viewport: { width: 1366, height: 900 },
  });

  const results = [];
  for (const site of sites) {
    const record = await probeSite(context, site, ruleset, probeSource);
    results.push(record);
    const found = record.before && record.before.cmpId ? record.before.cmpId : '-';
    const ms = record.detectMs !== null && record.detectMs !== undefined ? `${(record.detectMs / 1000).toFixed(1)}s` : '';
    console.log(`${record.verdict.padEnd(26)} ${String(found).padEnd(22)} ${ms.padStart(5)}  ${site.url}`);
  }

  await browser.close();
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(results, null, 2));

  const ok = results.filter((r) => r.verdict === 'ok').length;
  console.log(`\n${ok}/${results.length} regole confermate sul campo`);
  console.log(`dettaglio completo: verification/report.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
