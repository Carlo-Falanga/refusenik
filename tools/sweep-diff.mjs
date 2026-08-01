/**
 * Says what changed between two sweeps, and nothing else.
 *
 * analyse-sweep.mjs turns one report into a full picture, which is the right
 * tool the first time anyone looks at a sweep. It is the wrong tool the
 * second time: once a baseline exists, re-reading a report with hundreds of
 * "ok" and "nessun banner" entries just to spot the handful of sites that
 * moved is exactly the context cost sweep-plan.mjs's tiering was built to
 * avoid on the testing side. This is the reading-side equivalent - it never
 * prints anything that stayed the same, so the sites that actually need a
 * look are not buried in the ones that do not.
 *
 * Usage:
 *   node tools/sweep-diff.mjs sweep-v3.json sweep-v4.json   # prima, dopo
 *   node tools/sweep-diff.mjs sweep-v3.json sweep-v4.json --full
 *     # also lists the sites that stayed identical, instead of just counting them
 *
 * Both arguments are read from verification/, the same convention
 * analyse-sweep.mjs uses for its one report argument. "Changed" is judged on
 * three independent signals, each meaningful on its own regardless of what
 * the others did:
 *   - verdict crossing the ok / not-ok line in either direction
 *   - a damaged-page flag (`broke`) appearing or disappearing
 *   - which CMP (if any) was recognised
 * A site can trip more than one of these at once (e.g. a CMP swap that also
 * flips the verdict); when it does, one line lists every reason together
 * rather than the site appearing twice.
 *
 * The damage signal only exists on records from an --execute run, so
 * comparing a probe-only report (no `broke` field on any record) against an
 * --execute one would otherwise report every site as having newly acquired
 * damage, when really it just started being measured. That comparison is
 * skipped per-site whenever either side never measured it, and a single
 * warning line up top says so when the two reports are of different modes
 * entirely, rather than leaving the reader to assume a clean result on a
 * dimension that was simply never checked.
 *
 * Two reports covering different, only partly overlapping site lists (a
 * narrow probe next to a broad sweep, say) are expected and handled: sites
 * only present in one of the two are counted in the header and never
 * compared, since there is nothing to diff them against.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT_DIR = join(root, 'verification');

// How many example lines each of the changed-site sections prints before
// folding the rest into a count. This is the knob that keeps the output
// compact regardless of how many sites actually moved - two sweeps run far
// apart, or covering different site sets, can easily produce far more
// changes than two consecutive runs of the same sweep would.
const SECTION_EXAMPLES = 8;
// Same idea, for the per-cmpId aggregate lines in section 4 - there are
// normally only a handful of distinct CMPs involved even when many sites
// changed, but the cap exists so a pathological case cannot blow the budget.
const CMP_EXAMPLES = 10;

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const [firstArg, secondArg] = args.filter((a) => !a.startsWith('--'));

if (!firstArg || !secondArg) {
  console.error('Uso: node tools/sweep-diff.mjs <prima.json> <dopo.json> [--full]');
  process.exit(1);
}

function loadReport(name) {
  const path = join(OUT_DIR, name);
  const records = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(records)) {
    console.error(`${path} non contiene un array di record; impossibile confrontarlo.`);
    process.exit(1);
  }
  return records;
}

/** Mirrors verdictCategory() in verify-rules.mjs / analyse-sweep.mjs / sweep-plan.mjs. */
function verdictCategory(verdict) {
  const v = typeof verdict === 'string' ? verdict : 'sconosciuto';
  const i = v.indexOf('(');
  return i === -1 ? v.trim() : v.trim().slice(0, i).trim();
}

/** Pulls just the three signals this tool compares out of one raw record. */
function fingerprintOf(record) {
  return {
    verdict: typeof record.verdict === 'string' ? record.verdict : 'sconosciuto',
    category: verdictCategory(record.verdict),
    cmpId: (record.before && record.before.cmpId) || null,
    // `broke` only exists on records from an --execute run; a probe-only
    // report never has the field at all. That absence is "never measured",
    // not "confirmed clean", and the distinction matters a great deal here:
    // comparing a measured `[]` against an absent field would report every
    // site that merely started being checked for damage as having newly
    // acquired it. brokeMeasured is what lets the diff tell "nothing broke"
    // and "we never looked" apart instead of silently treating them the same.
    brokeMeasured: Array.isArray(record.broke),
    broke: Array.isArray(record.broke) ? record.broke : null,
    brokeNonEmpty: Array.isArray(record.broke) && record.broke.length > 0,
  };
}

/** `list.join(', ')`, capped at `max` entries with a "e altri N" tail. */
function listWithOverflow(list, max) {
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')}, e altri ${list.length - max}`;
}

function printExampleLines(items) {
  for (const line of items.slice(0, SECTION_EXAMPLES)) console.log(`  ${line}`);
  if (items.length > SECTION_EXAMPLES) console.log(`  ... e altri ${items.length - SECTION_EXAMPLES} casi`);
}

function main() {
  const before = loadReport(firstArg);
  const after = loadReport(secondArg);

  const beforeByUrl = new Map(before.filter((r) => r && r.url).map((r) => [r.url, r]));
  const afterByUrl = new Map(after.filter((r) => r && r.url).map((r) => [r.url, r]));

  const commonUrls = [...beforeByUrl.keys()].filter((u) => afterByUrl.has(u));
  const onlyBefore = beforeByUrl.size - commonUrls.length;
  const onlyAfter = afterByUrl.size - commonUrls.length;

  // A report has damage measurements at all only if it came from an
  // --execute run; a probe-only report has zero such records, never some.
  // When exactly one side has none, the two reports are of different modes
  // and the "broke" dimension is not comparable between them at all - this
  // is called out up front so nobody mistakes silence in that dimension for
  // "no damage found" instead of "not measured on one side".
  const beforeMeasuredCount = before.filter((r) => Array.isArray(r && r.broke)).length;
  const afterMeasuredCount = after.filter((r) => Array.isArray(r && r.broke)).length;
  if (beforeMeasuredCount === 0 && afterMeasuredCount > 0) {
    console.log(`confronto parziale: ${firstArg} non contiene misure di integrita' della pagina (passata senza --execute), i cambiamenti di danneggiamento non sono confrontabili`);
  } else if (afterMeasuredCount === 0 && beforeMeasuredCount > 0) {
    console.log(`confronto parziale: ${secondArg} non contiene misure di integrita' della pagina (passata senza --execute), i cambiamenti di danneggiamento non sono confrontabili`);
  }

  console.log(`${firstArg} -> ${secondArg}: ${commonUrls.length} siti in comune, ${onlyBefore} solo in ${firstArg}, ${onlyAfter} solo in ${secondArg}`);

  const worsenings = []; // { url, reasons: string[] }
  const improvements = [];
  const identical = [];
  const newCmpCounts = new Map();
  const goneCmpCounts = new Map();

  for (const url of commonUrls) {
    const b = fingerprintOf(beforeByUrl.get(url));
    const a = fingerprintOf(afterByUrl.get(url));

    const worseReasons = [];
    const improveReasons = [];

    if (b.category === 'ok' && a.category !== 'ok') worseReasons.push(`verdetto ok -> ${a.verdict}`);
    else if (b.category !== 'ok' && a.category === 'ok') improveReasons.push(`verdetto ${b.verdict} -> ok`);

    // Only meaningful when both sides actually measured page damage - a
    // report from a probe-only run has no `broke` field at all, so comparing
    // it against a measured `[]` would report "damage appeared" for every
    // site that simply started being checked, which is exactly the false
    // alarm this guard exists to prevent (see fingerprintOf's comment).
    if (b.brokeMeasured && a.brokeMeasured) {
      if (!b.brokeNonEmpty && a.brokeNonEmpty) worseReasons.push(`pagina danneggiata comparsa (${a.broke.join(', ')})`);
      else if (b.brokeNonEmpty && !a.brokeNonEmpty) improveReasons.push('pagina danneggiata sparita');
    }

    if (b.cmpId && b.cmpId !== a.cmpId) worseReasons.push(`cmp ${b.cmpId} -> ${a.cmpId || 'assente'}`);
    else if (!b.cmpId && a.cmpId) improveReasons.push(`nuovo cmp riconosciuto (${a.cmpId})`);

    // Aggregate CMP appearance/disappearance independently of the two lists
    // above, so a straight swap (cmp X -> cmp Y) is correctly counted as both
    // "X scomparso" and "Y nuovo" for section 4, without printing the site
    // itself twice in sections 2/3.
    if (a.cmpId && a.cmpId !== b.cmpId) newCmpCounts.set(a.cmpId, (newCmpCounts.get(a.cmpId) || 0) + 1);
    if (b.cmpId && b.cmpId !== a.cmpId) goneCmpCounts.set(b.cmpId, (goneCmpCounts.get(b.cmpId) || 0) + 1);

    if (worseReasons.length) {
      worsenings.push({ url, line: `${url}: ${worseReasons.join(', ')}` });
    } else if (improveReasons.length) {
      improvements.push({ url, line: `${url}: ${improveReasons.join(', ')}` });
    } else {
      identical.push(url);
    }
  }

  const nothingChanged = worsenings.length === 0 && improvements.length === 0
    && newCmpCounts.size === 0 && goneCmpCounts.size === 0 && onlyBefore === 0 && onlyAfter === 0;

  if (nothingChanged) {
    console.log('Nessuna differenza tra i due report.');
    return;
  }

  console.log('');
  console.log(`PEGGIORAMENTI (${worsenings.length})`);
  if (worsenings.length) printExampleLines(worsenings.map((w) => w.line));
  else console.log('  (nessuno)');

  console.log('');
  console.log(`MIGLIORAMENTI (${improvements.length})`);
  if (improvements.length) printExampleLines(improvements.map((w) => w.line));
  else console.log('  (nessuno)');

  console.log('');
  const newCmpList = [...newCmpCounts.entries()].sort((x, y) => y[1] - x[1]).map(([id, n]) => (n > 1 ? `${id} (x${n})` : id));
  const goneCmpList = [...goneCmpCounts.entries()].sort((x, y) => y[1] - x[1]).map(([id, n]) => (n > 1 ? `${id} (x${n})` : id));
  console.log(`NUOVI CMP RICONOSCIUTI: ${newCmpList.length ? listWithOverflow(newCmpList, CMP_EXAMPLES) : '(nessuno)'}`);
  console.log(`CMP SCOMPARSI: ${goneCmpList.length ? listWithOverflow(goneCmpList, CMP_EXAMPLES) : '(nessuno)'}`);

  console.log('');
  console.log(`${identical.length} siti rimasti identici`);
  if (FULL && identical.length) {
    for (const url of identical) console.log(`  ${url}`);
  }
}

main();
