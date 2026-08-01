/**
 * Turns a raw report from tools/verify-rules.mjs into something a human can
 * actually act on.
 *
 * verify-rules.mjs is deliberately silent about interpretation - it dumps one
 * record per site and moves on, because the sweep runs against 300+ sites and
 * re-deciding what a "family" of banners is every time it runs would slow it
 * down for no reason. This script is the other half: it reads the same JSON
 * after the fact and turns it into a work queue, in particular for section 4
 * below, which is the whole point of running a sweep in the first place -
 * finding which consent platforms are not covered yet, not just confirming
 * the ones that already are.
 *
 * Usage:
 *   node tools/analyse-sweep.mjs                    # reads verification/report.json
 *   node tools/analyse-sweep.mjs sweep-probe.json   # reads verification/<name>
 *
 * The report file is rewritten after every single site while a sweep is
 * running (see persistResults() in verify-rules.mjs), so it is normal to
 * point this at a report that is still being written. If a read lands mid
 * write and JSON.parse chokes on a half-written array, this retries once
 * after a short pause rather than crashing - by the second attempt the
 * writer has almost always finished its rewrite.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT_DIR = join(root, 'verification');

const reportName = process.argv[2] || 'report.json';
const reportPath = join(OUT_DIR, reportName);
const sitesPath = join(here, 'verify-sites.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads and parses `path`, retrying once after a short pause if the file is
 * caught mid rewrite (truncated JSON, or missing entirely for an instant
 * between unlink and write on some filesystems). A second failure is a real
 * problem, not a race, so it is reported plainly instead of retried forever.
 */
async function readJsonWithRetry(path, label) {
  const attempt = () => JSON.parse(readFileSync(path, 'utf8'));
  try {
    return attempt();
  } catch (firstError) {
    console.error(`Impossibile leggere ${label} al primo tentativo (${firstError.message}).`);
    console.error('Probabile scrittura in corso da parte dello sweep; nuovo tentativo tra 1.5s...');
    await sleep(1500);
    try {
      return attempt();
    } catch (secondError) {
      console.error(`Anche il secondo tentativo e' fallito: ${secondError.message}`);
      console.error(`${label} risulta troncato o non valido. Riprova quando lo sweep avra' scritto un checkpoint completo.`);
      process.exit(1);
      return undefined; // unreachable, keeps linters happy about return paths
    }
  }
}

/**
 * Strips the parenthetical detail off verdicts like "CMP DIVERSO (klaro)" or
 * "SELETTORI MANCANTI (2/5)" so the summary groups by the fixed set of
 * verdict kinds instead of fragmenting into one bucket per site. Mirrors the
 * function of the same name in verify-rules.mjs (duplicated rather than
 * imported, since that file is not to be touched and does not export it).
 */
function verdictCategory(verdict) {
  const v = typeof verdict === 'string' ? verdict : 'sconosciuto';
  const i = v.indexOf('(');
  return i === -1 ? v.trim() : v.trim().slice(0, i).trim();
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return 'n/d';
  return `${(ms / 1000).toFixed(1)}s`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || 'url sconosciuto');
  }
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `list.join(', ')`, capped at `max` entries with a "e altri N" tail. */
function listWithOverflow(list, max) {
  if (list.length <= max) return list.join(', ');
  const shown = list.slice(0, max);
  return `${shown.join(', ')}, e altri ${list.length - max}`;
}

/** Frequency-ranked top N tokens as "token (xCount)", most common first. */
function topTokens(tokens, n) {
  const counts = new Map();
  for (const t of tokens) {
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([token, count]) => (count > 1 ? `${token} (x${count})` : token));
}

/** "tutti" / "alcuni" / "nessuno" / "n/d" summary of a boolean flag across records. */
function refusalSummary(records, field) {
  const values = records
    .map((r) => r.fingerprint && r.fingerprint[field])
    .filter((v) => typeof v === 'boolean');
  if (!values.length) return 'n/d';
  if (values.every(Boolean)) return 'tutti';
  if (values.every((v) => !v)) return 'nessuno';
  return 'alcuni';
}

function section(title) {
  console.log('');
  console.log(`== ${title} ==`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 1. General summary, grouped by normalised verdict category.
// ---------------------------------------------------------------------------

function printSummary(records) {
  section('1. Riepilogo generale');
  const total = records.length;
  console.log(`Totale siti nel report: ${total}`);
  if (!total) return;

  const counts = new Map();
  for (const r of records) {
    const category = verdictCategory(r.verdict);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('');
  for (const [category, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(4)}  ${`${pct}%`.padStart(6)}  ${category}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Coverage per country group.
// ---------------------------------------------------------------------------

function printCoverageByGroup(records, groupOf) {
  section('2. Copertura per gruppo');
  if (!records.length) {
    console.log('(nessun dato)');
    return;
  }

  const groups = new Map();
  for (const r of records) {
    const g = groupOf(r.url);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  const rows = [...groups.entries()].map(([group, list]) => ({
    group,
    total: list.length,
    recognised: list.filter((r) => r.before && r.before.cmpId).length,
    uncovered: list.filter((r) => r.verdict === 'BANNER NON COPERTO').length,
    noBanner: list.filter((r) => r.verdict === 'nessun banner').length,
    error: list.filter((r) => r.verdict === 'ERRORE').length,
  })).sort((a, b) => b.total - a.total);

  const groupWidth = Math.max(8, ...rows.map((r) => r.group.length)) + 2;
  console.log(`${'gruppo'.padEnd(groupWidth)}${'siti'.padStart(6)}${'cmp riconosciuto'.padStart(18)}${'banner non coperto'.padStart(20)}${'nessun banner'.padStart(15)}${'errori'.padStart(9)}`);
  for (const row of rows) {
    console.log(
      `${row.group.padEnd(groupWidth)}${String(row.total).padStart(6)}`
      + `${String(row.recognised).padStart(18)}${String(row.uncovered).padStart(20)}`
      + `${String(row.noBanner).padStart(15)}${String(row.error).padStart(9)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Recognised CMPs, with median detection time.
// ---------------------------------------------------------------------------

function printRecognisedCmps(records) {
  section('3. CMP riconosciuti');
  const withCmp = records.filter((r) => r.before && r.before.cmpId);
  if (!withCmp.length) {
    console.log('(nessun CMP riconosciuto finora)');
    return;
  }

  const byId = new Map();
  for (const r of withCmp) {
    const id = r.before.cmpId;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  }

  const rows = [...byId.entries()].map(([id, list]) => ({
    id,
    count: list.length,
    medianMs: median(list.map((r) => r.detectMs).filter((ms) => typeof ms === 'number')),
  })).sort((a, b) => b.count - a.count);

  const idWidth = Math.max(10, ...rows.map((r) => r.id.length)) + 2;
  for (const row of rows) {
    console.log(`  ${row.id.padEnd(idWidth)}${String(row.count).padStart(4)} siti   rilevamento mediano: ${formatMs(row.medianMs)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Uncovered banners, clustered into families - the real point of the tool.
// ---------------------------------------------------------------------------

// Third-party hosts known to belong to a specific consent platform. This is
// necessarily a hand-maintained, incomplete list (new platforms and new CDN
// hostnames appear all the time) - it is the strongest signal available
// because a script host is much harder to fake or reuse by accident than an
// id or class name, but it only covers what someone has already noticed.
// Add entries here as new platforms are identified in section 4's leftovers.
const HOST_HINTS = [
  ['cmp.inmobi.com', 'Quantcast Choice'],
  ['quantcast.mgr.consensu.org', 'Quantcast Choice'],
  ['cdn.cookielaw.org', 'OneTrust'],
  ['geolocation.onetrust.com', 'OneTrust'],
  ['optanon.blob.core.windows.net', 'OneTrust'],
  ['sdk.privacy-center.org', 'Didomi'],
  ['api.privacy-center.org', 'Didomi'],
  ['consent.cookiebot.com', 'Cookiebot'],
  ['consentcdn.cookiebot.com', 'Cookiebot'],
  ['app.usercentrics.eu', 'Usercentrics'],
  ['privacy-proxy.usercentrics.eu', 'Usercentrics'],
  ['cdn.privacy-mgmt.com', 'Sourcepoint'],
  ['ccpa.sp-prod.net', 'Sourcepoint'],
  ['consent.trustarc.com', 'TrustArc'],
  ['widget.trustarc.com', 'TrustArc'],
  ['cmp.osano.com', 'Osano'],
  ['cdn.osano.com', 'Osano'],
  ['cdn-cookieyes.com', 'CookieYes'],
  ['cookieyes.com', 'CookieYes'],
  ['consent.cookiefirst.com', 'Cookiefirst'],
  ['cdn.consentmanager.net', 'ConsentManager'],
  ['delivery.consentmanager.net', 'ConsentManager'],
  ['cdn.secureprivacy.ai', 'Secure Privacy'],
  ['cmp.ketch.com', 'Ketch'],
  ['global.ketchcdn.com', 'Ketch'],
  ['piwik.pro', 'Piwik PRO'],
  ['sirdata.io', 'Sirdata'],
  ['axept.io', 'Axeptio'],
  ['static.axept.io', 'Axeptio'],
  ['app.termly.io', 'Termly'],
  ['app.cdn.termly.io', 'Termly'],
  ['bigid.com', 'BigID'],
  ['datagrail.io', 'DataGrail'],
  ['cc.cdn.civiccomputing.com', 'Civic Cookie Control'],
];

function matchHostHint(scripts) {
  for (const script of scripts || []) {
    for (const [host, label] of HOST_HINTS) {
      if (script.includes(host) || host.includes(script)) return label;
    }
  }
  return null;
}

// Class/id prefixes too generic to identify a specific platform on their
// own (they show up on almost any hand-rolled cookie banner regardless of
// which vendor built it), so they are excluded from prefix clustering even
// when they recur across sites.
const GENERIC_PREFIX_WORDS = new Set([
  'cookie', 'cookies', 'consent', 'banner', 'popup', 'modal', 'overlay',
  'dialog', 'notice', 'privacy', 'gdpr', 'accept', 'decline', 'reject',
  'close', 'button', 'btn', 'wrapper', 'container', 'content', 'header',
  'footer', 'title', 'text', 'message', 'preferences', 'settings',
  'options', 'list', 'item', 'group', 'box', 'panel', 'layer', 'root',
  'wrap', 'inner', 'outer', 'main', 'ui', 'info', 'logo', 'section', 'summary',
]);

/** Cumulative prefixes at the first two separator boundaries of a token. */
function tokenPrefixCandidates(token) {
  const candidates = new Set();
  const positions = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === '-' || token[i] === '_') positions.push(i);
  }
  for (let depth = 0; depth < Math.min(2, positions.length); depth += 1) {
    candidates.add(token.slice(0, positions[depth] + 1));
  }
  if (positions.length === 0 && token.length >= 3) candidates.add(token);
  return [...candidates].filter((p) => {
    const bare = p.replace(/[-_]$/, '').toLowerCase();
    return bare.length >= 3 && !GENERIC_PREFIX_WORDS.has(bare);
  });
}

/**
 * Clusters records (each `{ url, fingerprint }`, none matched by a known
 * host) by shared id/class prefixes. A prefix only counts as a family when
 * at least two distinct sites share it - a single site's own naming scheme
 * is not evidence of a platform. Assignment is greedy, most specific and
 * most widely shared prefixes first, so a broad accidental match (e.g. a
 * two-letter prefix) does not swallow sites better explained by a longer,
 * more specific one.
 */
function clusterByPrefix(records) {
  const byPrefix = new Map(); // prefix -> { urls: Set, tokens: Set }
  for (const r of records) {
    const tokens = new Set([...(r.fingerprint.ids || []), ...(r.fingerprint.classes || [])]);
    for (const token of tokens) {
      for (const prefix of tokenPrefixCandidates(token)) {
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, { urls: new Set(), tokens: new Set() });
        const entry = byPrefix.get(prefix);
        entry.urls.add(r.url);
        entry.tokens.add(token);
      }
    }
  }

  const candidates = [...byPrefix.entries()]
    .map(([prefix, entry]) => ({ prefix, urls: entry.urls, tokens: entry.tokens }))
    .filter((c) => c.urls.size >= 2)
    .sort((a, b) => b.urls.size - a.urls.size || b.prefix.length - a.prefix.length);

  const claimed = new Set();
  const families = [];
  for (const candidate of candidates) {
    const availableUrls = [...candidate.urls].filter((u) => !claimed.has(u));
    if (availableUrls.length < 2) continue;
    availableUrls.forEach((u) => claimed.add(u));
    families.push({
      label: `prefisso \`${candidate.prefix}\``,
      urls: new Set(availableUrls),
    });
  }
  return { families, claimed };
}

function printFamily(label, records) {
  const domains = records.map((r) => hostnameOf(r.url));
  console.log(`  ${label} - ${records.length} siti`);
  console.log(`    domini: ${listWithOverflow(domains, 12)}`);
  const ids = topTokens(records.flatMap((r) => r.fingerprint.ids || []), 5);
  const classes = topTokens(records.flatMap((r) => r.fingerprint.classes || []), 5);
  const scripts = topTokens(records.flatMap((r) => r.fingerprint.scripts || []), 5);
  if (ids.length) console.log(`    id: ${ids.join(', ')}`);
  if (classes.length) console.log(`    classi: ${classes.join(', ')}`);
  if (scripts.length) console.log(`    script: ${scripts.join(', ')}`);
  console.log(`    rifiuto diretto offerto: ${refusalSummary(records, 'offersRefusal')}`);
  console.log('');
}

function printUncoveredFamilies(records) {
  section('4. Banner non coperti, per famiglia (coda di lavoro per nuove regole)');
  const uncovered = records
    .filter((r) => r.verdict === 'BANNER NON COPERTO')
    .map((r) => ({ url: r.url, fingerprint: (r.before && r.before.fingerprint) || {} }));

  if (!uncovered.length) {
    console.log('(nessun banner non coperto nel report)');
    return;
  }

  // Pass 1: group by known third-party script host - the strongest signal.
  const byHostLabel = new Map();
  const unmatched = [];
  for (const r of uncovered) {
    const label = matchHostHint(r.fingerprint.scripts);
    if (label) {
      if (!byHostLabel.has(label)) byHostLabel.set(label, []);
      byHostLabel.get(label).push(r);
    } else {
      unmatched.push(r);
    }
  }

  // Pass 2: for whatever a known host could not explain, group by shared
  // id/class prefix.
  const { families: prefixFamilies, claimed } = clusterByPrefix(unmatched);
  const leftover = unmatched.filter((r) => !claimed.has(r.url));

  const allFamilies = [
    ...[...byHostLabel.entries()].map(([label, list]) => ({ label, records: list })),
    ...prefixFamilies.map((f) => ({
      label: f.label,
      records: unmatched.filter((r) => f.urls.has(r.url)),
    })),
  ].sort((a, b) => b.records.length - a.records.length);

  console.log(`${uncovered.length} banner non coperti totali, raggruppati in ${allFamilies.length} famiglie` + (leftover.length ? ` (+ ${leftover.length} senza segnale condiviso)` : ''));
  console.log('');
  for (const family of allFamilies) {
    printFamily(family.label, family.records);
  }

  if (leftover.length) {
    console.log('  --- non raggruppabili (nessun host o prefisso condiviso con altri siti) ---');
    printFamily('non raggruppati', leftover);
  }
}

// ---------------------------------------------------------------------------
// 5. Recognised CMPs with selectors that no longer resolve.
// ---------------------------------------------------------------------------

function printBrokenSelectors(records) {
  section('5. CMP riconosciuto ma selettori mancanti (regole da riparare)');
  const broken = records.filter((r) => verdictCategory(r.verdict) === 'SELETTORI MANCANTI');
  if (!broken.length) {
    console.log('(nessuna regola rotta nel report)');
    return;
  }
  for (const r of broken) {
    const cmpId = (r.before && r.before.cmpId) || 'n/d';
    console.log(`  ${r.url}  [${cmpId}]`);
    const steps = (r.before && r.before.steps) || [];
    const missing = steps.filter((s) => !s.optional && !s.found);
    for (const step of missing) {
      console.log(`    non risolve: ${step.action} ${truncate(step.css, 80)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Errors, grouped by similar message.
// ---------------------------------------------------------------------------

function normaliseError(message) {
  return String(message || '(nessun messaggio)').replace(/https?:\/\/\S+/g, '<url>').trim();
}

function printErrors(records) {
  section('6. Errori');
  const errors = records.filter((r) => r.verdict === 'ERRORE');
  if (!errors.length) {
    console.log('(nessun errore nel report)');
    return;
  }

  const groups = new Map();
  for (const r of errors) {
    const key = normaliseError(r.error);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.url);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [message, urls] of sorted) {
    console.log(`  ${urls.length} siti - ${truncate(message, 110)}`);
    for (const url of urls) console.log(`    ${url}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Broken pages after --execute, only when execute data is present.
// ---------------------------------------------------------------------------

function printBrokenPages(records) {
  const hasExecuteData = records.some((r) => Object.prototype.hasOwnProperty.call(r, 'broke'));
  if (!hasExecuteData) return;

  section('7. Pagine danneggiate (dati --execute)');
  const broken = records.filter((r) => Array.isArray(r.broke) && r.broke.length);
  if (!broken.length) {
    console.log('(nessuna pagina danneggiata rilevata)');
    return;
  }
  for (const r of broken) {
    const cmpId = (r.before && r.before.cmpId) || 'n/d';
    console.log(`  ${r.url}  [${cmpId}]  ${r.broke.join(', ')}`);
  }
}

async function main() {
  const records = await readJsonWithRetry(reportPath, reportPath);
  if (!Array.isArray(records)) {
    console.error(`${reportPath} non contiene un array di record; impossibile continuare.`);
    process.exit(1);
  }

  let sites = [];
  try {
    sites = JSON.parse(readFileSync(sitesPath, 'utf8'));
  } catch (error) {
    console.error(`Attenzione: impossibile leggere ${sitesPath} (${error.message}); i gruppi (country) saranno "sconosciuto".`);
  }
  // verify-rules.mjs does not copy `country` into the record, so it has to be
  // re-joined here by url against the site list it was generated from.
  const countryByUrl = new Map(sites.map((s) => [s.url, s.country]));
  const groupOf = (url) => countryByUrl.get(url) || 'sconosciuto';

  console.log(`Report analizzato: ${reportPath}`);

  printSummary(records);
  printCoverageByGroup(records, groupOf);
  printRecognisedCmps(records);
  printUncoveredFamilies(records);
  printBrokenSelectors(records);
  printErrors(records);
  printBrokenPages(records);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
