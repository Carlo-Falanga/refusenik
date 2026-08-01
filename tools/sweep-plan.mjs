/**
 * Decides which sites are worth testing on any given run, and writes that
 * decision to a file the verifier can consume directly.
 *
 * verify-rules.mjs is built to sweep the whole list, and analyse-sweep.mjs is
 * built to read a whole report - both correctly assume "the whole list" is
 * the unit of work. That assumption gets expensive at 393+ sites: a full
 * --execute sweep is hours of wall-clock time, and every full report is
 * thousands of lines that whoever is investigating a regression has to wade
 * through again even when almost nothing changed since last time. The fix is
 * not to test less carefully, it is to test the RIGHT sites more often and
 * the rest more rarely, and to remember what each site did last time so that
 * decision can be made without re-reading a report at all.
 *
 * This tool is the memory. It keeps a rolling history (verification/history.json,
 * the last HISTORY_LIMIT runs per site - see that constant for why 10) and,
 * from that history alone, computes four tiers of "what to test next":
 *
 *   sentinel - a small, high-signal set built to catch regressions fast: the
 *     two most reliable sites per recognised CMP (so a change to any rule
 *     shows up almost immediately) plus every site that has broken the page
 *     after refusal in its recent history (because that is the single most
 *     expensive kind of bug this project can ship). It is deliberately kept
 *     small - the entire point is that it is cheap enough to run constantly.
 *   queue - the sites that actually need work right now: banners this engine
 *     does not recognise yet, or recognises wrong, plus anything never tested
 *     at all (there is no history to judge those by, so they are always in).
 *   rotate - the long tail of sites that have been quiet and stable for a
 *     while. Re-testing all of them every time is exactly the waste this tool
 *     exists to avoid, so they are split into 5 deterministic groups and one
 *     group comes back per invocation, rotating via a counter kept in the
 *     same history file - five runs and the whole tail has been re-checked.
 *   full - everything, unchanged, for when a real full sweep is what is
 *     actually wanted.
 *
 * Usage:
 *   node tools/sweep-plan.mjs --absorb sweep-v3.json   # learn from a report
 *   node tools/sweep-plan.mjs --tier sentinel          # write plan-sentinel.json
 *   node tools/sweep-plan.mjs --tier queue             # write plan-queue.json
 *   node tools/sweep-plan.mjs --tier rotate            # write plan-rotate.json
 *   node tools/sweep-plan.mjs --tier full              # write plan-full.json
 *   node tools/sweep-plan.mjs --status                 # print tier sizes, write nothing
 *
 * Every --tier run writes verification/plan-<tier>.json in exactly the shape
 * of verify-sites.json, so it can be fed straight back into verify-rules.mjs
 * once that tool grows a way to point at an alternate site list (or, today,
 * simply be copied over verify-sites.json for a single run).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT_DIR = join(root, 'verification');
const SITES_PATH = join(here, 'verify-sites.json');
const HISTORY_PATH = join(OUT_DIR, 'history.json');

// How many past runs to keep per site. Ten is enough for the rotate tier's
// "same verdict 3+ times" stability check and for the sentinel tier's
// streak/detection-time ranking to have real signal, without the file
// growing without bound as sweeps pile up over months.
const HISTORY_LIMIT = 10;

// The rotate tier's long tail is split into this many deterministic groups;
// one comes back per invocation, so this many invocations cover the whole
// tail once. 5 keeps each slice a manageable size at hundreds of sites while
// not requiring an unreasonable number of runs to get full coverage back.
const ROTATE_GROUPS = 5;

// How many stable verdicts in a row a site needs before rotate will consider
// it settled enough to only re-check occasionally rather than every run.
const ROTATE_STABILITY_RUNS = 3;

// Verdicts that a site needs to hold steady on to count as "stable" for the
// rotate tier. Anything else (uncovered banners, broken pages, errors) is a
// site that still needs attention on every run, not once every five.
const STABLE_VERDICTS = new Set(['ok', 'nessun banner']);

// Verdict categories that belong on the work queue - a banner is either not
// recognised at all, recognised as the wrong CMP, or recognised but with
// selectors that no longer resolve. All three mean "someone needs to look at
// this", which is exactly what the queue tier is for.
const QUEUE_VERDICTS = new Set(['BANNER NON COPERTO', 'SELETTORI MANCANTI', 'CMP DIVERSO']);

// How many example lines a per-tier justification print shows before folding
// the rest into a count; the goal (per the brief) is a few compact lines, not
// a re-print of the plan file itself.
const REASON_EXAMPLES = 6;

const args = process.argv.slice(2);
function flagValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const ABSORB_NAME = flagValue('--absorb');
const TIER = flagValue('--tier');
const STATUS = args.includes('--status');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads and parses a JSON file, retrying once after a short pause if it is
 * caught mid-write (truncated JSON) - the same situation analyse-sweep.mjs
 * guards against, because a sweep report is rewritten after every single
 * site while it runs, and there is nothing stopping someone from absorbing a
 * report while the sweep that produces it is still going.
 */
async function readJsonWithRetry(path, label) {
  const attempt = () => JSON.parse(readFileSync(path, 'utf8'));
  try {
    return attempt();
  } catch (firstError) {
    console.error(`Impossibile leggere ${label} al primo tentativo (${firstError.message}); nuovo tentativo tra 1.5s...`);
    await sleep(1500);
    return attempt();
  }
}

function loadSites() {
  return JSON.parse(readFileSync(SITES_PATH, 'utf8'));
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { rotateCounter: 0, sites: {} };
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
    return {
      rotateCounter: Number.isInteger(parsed.rotateCounter) ? parsed.rotateCounter : 0,
      sites: (parsed && typeof parsed.sites === 'object' && parsed.sites) || {},
    };
  } catch {
    // A corrupt or half-written history is not worth crashing over - it is
    // rebuilt from scratch by the next --absorb, same spirit as the retry
    // above but for the file this tool itself owns.
    return { rotateCounter: 0, sites: {} };
  }
}

function saveHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Strips the parenthetical detail off verdicts like "CMP DIVERSO (klaro)" or
 * "SELETTORI MANCANTI (2/5)" so history and tier logic can key off the fixed
 * set of verdict kinds. Mirrors the function of the same name in
 * verify-rules.mjs and analyse-sweep.mjs (duplicated rather than imported,
 * since verify-rules.mjs is off-limits right now and neither file exports it).
 */
function verdictCategory(verdict) {
  const v = typeof verdict === 'string' ? verdict : 'sconosciuto';
  const i = v.indexOf('(');
  return i === -1 ? v.trim() : v.trim().slice(0, i).trim();
}

// ---------------------------------------------------------------------------
// --absorb: fold a report's verdicts into the rolling per-site history.
// ---------------------------------------------------------------------------

async function absorb(reportName) {
  const reportPath = join(OUT_DIR, reportName);
  const records = await readJsonWithRetry(reportPath, reportPath);
  if (!Array.isArray(records)) {
    console.error(`${reportPath} non contiene un array di record; impossibile assorbirlo.`);
    process.exitCode = 1;
    return;
  }

  const history = loadHistory();
  const date = new Date().toISOString();
  let newSites = 0;
  let updatedSites = 0;

  for (const record of records) {
    if (!record || !record.url) continue; // guard against a stray malformed entry

    const cmpId = (record.before && record.before.cmpId) || null;
    const detectMs = typeof record.detectMs === 'number' ? record.detectMs : null;
    // Three states, not two: true (broke, --execute ran and found damage),
    // false (--execute ran and found none) and null (probe-only report, never
    // measured at all). Collapsing the last two into "not broken" would let a
    // site that was simply never checked masquerade as one confirmed clean.
    const damaged = Array.isArray(record.broke) ? record.broke.length > 0 : null;

    if (!history.sites[record.url]) {
      history.sites[record.url] = { runs: [] };
      newSites += 1;
    } else {
      updatedSites += 1;
    }

    const entry = history.sites[record.url];
    entry.runs.push({
      date,
      verdict: typeof record.verdict === 'string' ? record.verdict : 'sconosciuto',
      cmpId,
      detectMs,
      damaged,
    });
    if (entry.runs.length > HISTORY_LIMIT) {
      entry.runs.splice(0, entry.runs.length - HISTORY_LIMIT);
    }
  }

  saveHistory(history);
  console.log(`Storico aggiornato da ${reportName}: ${records.length} record assorbiti (${newSites} siti nuovi, ${updatedSites} gia' noti aggiornati).`);
  console.log(`Siti totali nello storico: ${Object.keys(history.sites).length}`);
}

// ---------------------------------------------------------------------------
// Tier computation - each returns { urls: Set<string>, ...whatever explains why }
// ---------------------------------------------------------------------------

function latestRun(entry) {
  return entry.runs[entry.runs.length - 1];
}

function isUntested(history, url) {
  const entry = history.sites[url];
  return !entry || entry.runs.length === 0;
}

/**
 * The two most reliable sites per recognised CMP, plus every site with a
 * damaged page anywhere in its recent history.
 *
 * "Reliable" is ranked by how long the site's trailing streak of identical
 * verdicts is (a site that keeps landing on the same verdict is one where a
 * change in that verdict is trustworthy signal, not noise) and, as a
 * tiebreaker, by how fast detection resolved on average (per the brief:
 * "verdetto stabile e rilevamento veloce", in that order of priority).
 *
 * Deliberately excludes untested sites even though every other tier includes
 * them: a site with zero history carries no CMP identity and no reliability
 * signal to rank by, so it cannot serve sentinel's actual job (fast, cheap
 * regression detection on CMPs already known to work). Folding untested
 * sites in here anyway would mean this tier grows with the whole site list
 * instead of staying small - the opposite of what it is for.
 */
function computeSentinel(sites, history) {
  const siteUrls = new Set(sites.map((s) => s.url));
  const byCmp = new Map();
  const damagedUrls = new Set();

  for (const [url, entry] of Object.entries(history.sites)) {
    if (!siteUrls.has(url) || !entry.runs.length) continue;
    const last = latestRun(entry);

    if (last.cmpId) {
      let streak = 0;
      for (let i = entry.runs.length - 1; i >= 0; i -= 1) {
        if (entry.runs[i].verdict === last.verdict) streak += 1;
        else break;
      }
      const detectValues = entry.runs.map((r) => r.detectMs).filter((ms) => typeof ms === 'number');
      const avgDetect = detectValues.length ? detectValues.reduce((a, b) => a + b, 0) / detectValues.length : Infinity;
      if (!byCmp.has(last.cmpId)) byCmp.set(last.cmpId, []);
      byCmp.get(last.cmpId).push({ url, streak, avgDetect });
    }

    if (entry.runs.some((r) => r.damaged === true)) damagedUrls.add(url);
  }

  const reasons = new Map(); // url -> human-readable reason(s)
  for (const [cmpId, candidates] of byCmp) {
    const ranked = [...candidates].sort((a, b) => (b.streak - a.streak) || (a.avgDetect - b.avgDetect));
    for (const c of ranked.slice(0, 2)) {
      const tag = `cmp ${cmpId}`;
      reasons.set(c.url, reasons.has(c.url) ? `${reasons.get(c.url)}, ${tag}` : tag);
    }
  }
  for (const url of damagedUrls) {
    const tag = 'danni pregressi';
    reasons.set(url, reasons.has(url) ? `${reasons.get(url)}, ${tag}` : tag);
  }

  return { urls: new Set(reasons.keys()), reasons, cmpCount: byCmp.size, damagedCount: damagedUrls.size };
}

/**
 * Everything that still needs real attention: banners not recognised, mis-
 * recognised, or recognised with selectors that no longer resolve - plus
 * every site with no history at all, since "we do not know what this site
 * does" is itself exactly the kind of gap this tier exists to close.
 */
function computeQueue(sites, history) {
  const reasons = new Map();
  const counts = { uncovered: 0, missingSelectors: 0, wrongCmp: 0, untested: 0 };

  for (const site of sites) {
    if (isUntested(history, site.url)) {
      reasons.set(site.url, 'mai testato');
      counts.untested += 1;
      continue;
    }
    const last = latestRun(history.sites[site.url]);
    const category = verdictCategory(last.verdict);
    if (!QUEUE_VERDICTS.has(category)) continue;
    reasons.set(site.url, last.verdict);
    if (category === 'BANNER NON COPERTO') counts.uncovered += 1;
    else if (category === 'SELETTORI MANCANTI') counts.missingSelectors += 1;
    else if (category === 'CMP DIVERSO') counts.wrongCmp += 1;
  }

  return { urls: new Set(reasons.keys()), reasons, counts };
}

// A short, fixed hash (FNV-1a) so group assignment only depends on the url
// string itself, not on array position - sites keep the same rotate group
// even as verify-sites.json grows or shrinks around them.
function hashUrl(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isStable(entry) {
  if (!entry || entry.runs.length < ROTATE_STABILITY_RUNS) return false;
  const recent = entry.runs.slice(-ROTATE_STABILITY_RUNS);
  const verdict = recent[0].verdict;
  if (!STABLE_VERDICTS.has(verdict)) return false;
  return recent.every((r) => r.verdict === verdict);
}

/**
 * One of the 5 deterministic groups of "stable, boring" sites, chosen by a
 * counter persisted in history.json. Untested sites are excluded on purpose
 * (per the brief, rotate is the one tier that never grabs them) - they
 * belong to the queue tier instead, precisely because rotating them in would
 * delay finding out what they do for up to 5 runs.
 *
 * `advance` controls whether the counter actually moves: --status previews
 * the current group without consuming it, only an actual --tier rotate run
 * does.
 */
function computeRotate(sites, history, { advance }) {
  const stableUrls = sites.map((s) => s.url).filter((url) => isStable(history.sites[url]));
  const groupIndex = ((history.rotateCounter % ROTATE_GROUPS) + ROTATE_GROUPS) % ROTATE_GROUPS;
  const groupUrls = stableUrls.filter((url) => hashUrl(url) % ROTATE_GROUPS === groupIndex);
  if (advance) history.rotateCounter = (history.rotateCounter + 1) % ROTATE_GROUPS;
  return { urls: new Set(groupUrls), groupIndex, stableTotal: stableUrls.length };
}

// ---------------------------------------------------------------------------
// Output: writing plan-<tier>.json and printing the compact justification.
// ---------------------------------------------------------------------------

function writePlan(tierName, sites, urlSet) {
  const plan = sites.filter((s) => urlSet.has(s.url));
  const outPath = join(OUT_DIR, `plan-${tierName}.json`);
  writeFileSync(outPath, JSON.stringify(plan, null, 2));
  return { outPath, count: plan.length };
}

/** `Map(url -> reason)` rendered as up to REASON_EXAMPLES "url (reason)" lines. */
function printReasonExamples(reasons) {
  const entries = [...reasons.entries()];
  for (const [url, reason] of entries.slice(0, REASON_EXAMPLES)) {
    console.log(`    ${url}  (${reason})`);
  }
  if (entries.length > REASON_EXAMPLES) {
    console.log(`    ... e altri ${entries.length - REASON_EXAMPLES} siti`);
  }
}

function runTierSentinel(sites, history) {
  const { urls, reasons, cmpCount, damagedCount } = computeSentinel(sites, history);
  const { outPath, count } = writePlan('sentinel', sites, urls);
  console.log(`Livello "sentinel": ${count} siti -> ${outPath}`);
  console.log(`  ${cmpCount} CMP coperti (fino a 2 siti piu' affidabili ciascuno) + ${damagedCount} siti con danni pregressi`);
  printReasonExamples(reasons);
}

function runTierQueue(sites, history) {
  const { urls, reasons, counts } = computeQueue(sites, history);
  const { outPath, count } = writePlan('queue', sites, urls);
  console.log(`Livello "queue": ${count} siti -> ${outPath}`);
  console.log(`  ${counts.uncovered} banner non coperti, ${counts.missingSelectors} selettori mancanti, ${counts.wrongCmp} cmp diverso, ${counts.untested} mai testati`);
  printReasonExamples(reasons);
}

function runTierRotate(sites, history) {
  const { urls, groupIndex, stableTotal } = computeRotate(sites, history, { advance: true });
  const { outPath, count } = writePlan('rotate', sites, urls);
  saveHistory(history); // persist the counter this run just advanced
  console.log(`Livello "rotate": gruppo ${groupIndex + 1}/${ROTATE_GROUPS}, ${count} siti -> ${outPath}`);
  console.log(`  ${stableTotal} siti stabili totali suddivisi in ${ROTATE_GROUPS} gruppi deterministici; contatore ora a ${history.rotateCounter}`);
}

function runTierFull(sites) {
  const urls = new Set(sites.map((s) => s.url));
  const { outPath, count } = writePlan('full', sites, urls);
  console.log(`Livello "full": ${count} siti -> ${outPath} (tutti i siti della lista)`);
}

function printStatus(sites, history) {
  const testedCount = sites.filter((s) => !isUntested(history, s.url)).length;
  console.log(`Sweep-plan - stato storico: ${testedCount}/${sites.length} siti con almeno una run, contatore rotazione: ${history.rotateCounter}`);
  console.log('');

  const sentinel = computeSentinel(sites, history);
  console.log(`  sentinel : ${sentinel.urls.size} siti  (${sentinel.cmpCount} cmp coperti x2 + ${sentinel.damagedCount} con danni pregressi)`);

  const queue = computeQueue(sites, history);
  console.log(`  queue    : ${queue.urls.size} siti  (${queue.counts.uncovered} non coperti, ${queue.counts.missingSelectors} selettori mancanti, ${queue.counts.wrongCmp} cmp diverso, ${queue.counts.untested} mai testati)`);

  const rotate = computeRotate(sites, history, { advance: false });
  console.log(`  rotate   : gruppo ${rotate.groupIndex + 1}/${ROTATE_GROUPS} -> ${rotate.urls.size} siti  (${rotate.stableTotal} stabili totali)`);

  console.log(`  full     : ${sites.length} siti  (tutta la lista)`);
}

async function main() {
  if (ABSORB_NAME) {
    await absorb(ABSORB_NAME);
    return;
  }

  const sites = loadSites();
  const history = loadHistory();

  if (STATUS) {
    printStatus(sites, history);
    return;
  }

  switch (TIER) {
    case 'sentinel': runTierSentinel(sites, history); break;
    case 'queue': runTierQueue(sites, history); break;
    case 'rotate': runTierRotate(sites, history); break;
    case 'full': runTierFull(sites); break;
    default:
      console.log('Uso:');
      console.log('  node tools/sweep-plan.mjs --absorb <report.json>');
      console.log('  node tools/sweep-plan.mjs --tier sentinel|queue|rotate|full');
      console.log('  node tools/sweep-plan.mjs --status');
      process.exitCode = TIER ? 1 : 0;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
