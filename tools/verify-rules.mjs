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
 *   node tools/verify-rules.mjs --sites plan-queue.json
 *     # reads the site list from verification/plan-queue.json instead of
 *     # tools/verify-sites.json - a bare name is looked up under
 *     # verification/, which is exactly where sweep-plan.mjs writes its tiers
 *     # (plan-sentinel.json, plan-queue.json, ...), so a plan produced there
 *     # can be fed straight into a run without copying anything by hand. An
 *     # absolute or cwd-relative path also works.
 *   node tools/verify-rules.mjs --resume sweep-v3.json --out sweep-v4.json
 *     # picks up a sweep that was cut short: sites that already have a real
 *     # verdict (anything but NON PROVATO or ERRORE) in
 *     # verification/sweep-v3.json are skipped, everything else - untested,
 *     # NON PROVATO or ERRORE alike - is (re)tried, and the union of both is
 *     # written to verification/sweep-v4.json - see --resume's own section
 *     # below for why this exists.
 *
 * Probe mode reports whether each rule's selectors resolve on the real page.
 * It never clicks, so it is safe to run broadly and fast. --execute additionally
 * performs the refusal and re-probes, which is the only way to catch rules that
 * resolve but do not actually work.
 *
 * The sweep this is meant for is 300+ sites, and with detection alone allowed to
 * take up to 20s and navigation up to 60s, running that sequentially is an
 * afternoon lost for no good reason. So sites are pulled off a shared queue by a
 * small pool of workers instead of being awaited one at a time:
 *
 *   node tools/verify-rules.mjs --concurrency 8  # workers in the pool (default 6, max 12)
 *   node tools/verify-rules.mjs --out sweep2.json # report file name under verification/
 *   node tools/verify-rules.mjs --no-shots        # skip screenshots (hundreds of MB at this scale)
 *
 * Each worker gets its own browser context so one site's cookies or consent
 * state can never leak into another's. Results keep the order of
 * verify-sites.json regardless of which site finished first, and the report is
 * rewritten after every single site so a crash midway through a long sweep does
 * not throw away everything that ran before it.
 *
 * A sweep of hundreds of sites, with --execute driving a real page through its
 * refusal flow, is exactly the kind of long-running headless Chromium session
 * that runs out of memory partway through. Two things exist because of that:
 * each worker recycles its context every CONTEXT_RECYCLE_SITES sites so no
 * single context accumulates state for the whole run, and if the browser
 * still dies anyway, the pool notices, relaunches it, and puts the site that
 * was in flight back on the queue instead of recording it as a failure it
 * never actually tried. Sites that end up genuinely untested when the browser
 * cannot be revived (or the sweep is interrupted while it is down) get their
 * own verdict, NON PROVATO, so they are never confused with ERRORE - which
 * means "tried and failed", not "never got the chance".
 *
 * That "the browser died" recovery, though, only fires on an actual thrown
 * error - and a 2026-08 diagnosis of a sweep genuinely stuck at 208/393, with
 * no error and no progress, found the failure mode it never covered: a
 * browser that is still alive as an OS process (21 chrome-headless-shell.exe
 * children still running, ~3.5GB RAM, CPU flat across all of them) but has
 * simply stopped answering commands. Nothing throws when that happens, so the
 * existing recovery never triggered, and the missing piece turned out to be
 * page.close() itself: it had no timeout, so once a page wedged - waiting on
 * a mute browser rather than one that had actually died - the finally block
 * meant to close it hung forever too, leaving the page open, its worker
 * stuck, and the browser never asked to restart. Every page-lifecycle
 * operation in this file (newPage, close, the periodic context recycle,
 * even browser.close() during a restart) now races against its own short
 * ceiling instead of being trusted to resolve, and a watchdog independently
 * tracks wall-clock time since any site last finished: if the whole pool goes
 * quiet for a few multiples of SITE_BUDGET_MS, it assumes the browser (not
 * one difficult site) is the problem and forces the same restart a thrown
 * error would have.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { build } from 'esbuild';

import { resolveTextMatchRefs } from '../src/rules/expandTextMatchRefs.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT_DIR = join(root, 'verification');

const args = process.argv.slice(2);

function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

const EXECUTE = args.includes('--execute');
const HEADED = args.includes('--headed');
const ONLY = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
const NO_SHOTS = args.includes('--no-shots');
// 6 workers is a reasonable default for a laptop running headless Chromium
// instances side by side; 12 is a ceiling, not a recommendation - past that the
// machine itself becomes the bottleneck rather than site load times.
const CONCURRENCY = Math.max(1, Math.min(12, Number(argValue('--concurrency', 6)) || 6));
const OUT_NAME = argValue('--out', 'report.json');
// Name of a previous report under verification/ to resume from; see the
// "--resume" section of main() for what "resume" actually means here.
const RESUME_NAME = argValue('--resume', null);
// Alternate site list to sweep instead of tools/verify-sites.json - see
// resolveSitesPath() for how the name is turned into an actual path. Exists
// so the tiered plans sweep-plan.mjs writes to verification/ (plan-sentinel.json,
// plan-queue.json, ...) can be handed straight to a run instead of only ever
// being usable as documentation of what a full sweep would need to cover.
const SITES_NAME = argValue('--sites', null);
const NAV_TIMEOUT = 60_000;
// How many sites a single BrowserContext is allowed to process before a
// worker closes it and opens a fresh one. Consent banners are dismissed by
// running real DOM code (and, with --execute, driving a full click flow)
// against pages a verifier does not control, so leaked listeners, detached
// nodes and cached responses build up across sites the same way open tabs do
// in a browser nobody restarts. 25 is a compromise: low enough that a context
// never lives long enough to be the reason Chromium runs out of memory mid
// sweep, high enough that the constant relaunching itself is not what slows
// the sweep down.
const CONTEXT_RECYCLE_SITES = 25;
// How many times the pool will relaunch a Chromium instance that has died
// mid-sweep before giving up. A dead browser is recoverable - a resource
// exhaustion crash does not usually recur immediately on a freshly launched
// process - but if it keeps dying right after each relaunch, something more
// fundamental is wrong (out of disk, out of real memory, a bad flag) and
// retrying forever would just hang the sweep instead of reporting that
// honestly.
const MAX_BROWSER_RESTARTS = 3;
// Some sites suppress their consent banner - or refuse the connection outright -
// when they recognise Chromium's default headless UA string. usercentrics.com is
// a confirmed case: it logs "not launching due to suspicious userAgent" and leaves
// its widget's shadow root empty, which would silently undercount coverage without
// this ever showing up as an error. Spoofing a normal desktop Chrome UA (with no
// "Headless" substring) is what lets the sweep measure what a real visitor sees.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// A fixed wait is the wrong instrument: consent platforms load on their own
// schedule, and Cookiebot on its own site takes over 6s. The extension does not
// wait either - it observes until something appears. So does this, and it
// records how long detection took, which is useful data in its own right.
const DETECT_POLL_MS = 500;
const DETECT_MAX_MS = 20_000;
// A hard ceiling on the entire per-site workload - navigation, detection,
// the refusal flow and its waits, screenshots, everything. This exists
// because of a real hang: verifying rewe.de with --execute left a worker
// stuck for over 18 minutes at near-zero CPU. The refusal click there trips
// Cloudflare Turnstile's anti-bot challenge, and the frame.evaluate() driving
// the flow has no timeout of its own - it simply never resolves or rejects
// while the challenge sits there. NAV_TIMEOUT only bounds page.goto; nothing
// bounded what came after it. With 393 sites on the queue, one site wedging
// like this ties up its worker forever and quietly shrinks the pool. 120s is
// generous enough to comfortably fit navigation, up to DETECT_MAX_MS of
// detection and a normal --execute run, while staying nowhere near the 18
// minutes actually observed, so a genuinely stuck site is abandoned instead
// of hanging the sweep.
const SITE_BUDGET_MS = 120_000;
// Ceiling for opening a brand-new page or context - context.newPage(), and
// every browser.newContext() call below, whether at worker startup, during a
// restart, or during the periodic per-context recycle. On a healthy browser
// this is a single cheap CDP round trip, well under a second, so the ceiling
// is not really about slowness: it exists because the 2026-08 stall diagnosis
// found a browser that was still alive as an OS process (21
// chrome-headless-shell.exe children still running, ~3.5GB RAM, CPU flat
// across all of them for 20s) but had stopped answering commands entirely -
// a failure mode that never throws on its own, it just hangs. Before this
// existed, newPage() had no protection at all: a hang there blocked its
// worker forever with no page ever created, so there was not even anything
// to close.
const HANDLE_OPEN_TIMEOUT_MS = 15_000;
// Ceiling for closing a page or a context. Shorter than
// HANDLE_OPEN_TIMEOUT_MS on purpose - releasing resources is normally faster
// than allocating them on a browser that is actually healthy, and the one
// thing this guards against (a renderer or browser that has gone completely
// quiet) will not start answering just because it is given more time. This is
// arguably the single most important number in this file: page.close() used
// to have no timeout whatsoever, so a hang here - waiting on exactly the
// mute-but-alive browser described above - blocked the finally block meant to
// close it forever, which is precisely how pages piled up and workers froze
// in the stall this file was rewritten to fix. A few seconds is enough for a
// merely slow close to still succeed while bounding the wait when it never
// will.
const HANDLE_CLOSE_TIMEOUT_MS = 5_000;
// Ceiling for browser.close() during a forced restart (see doRestart()).
// Slightly more generous than HANDLE_CLOSE_TIMEOUT_MS because tearing down an
// entire browser - and whatever renderer processes are still hanging off it -
// is more work than closing one page or context, but this still must not be
// allowed to hang indefinitely: doRestart() has to reach launchBrowser()
// regardless of whether the old browser cooperates on the way out.
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
// How long the pool can go without a single site finishing before the
// watchdog (see watchdog() in main()) assumes the browser itself has gone
// quiet, not that one site is merely difficult. SITE_BUDGET_MS already bounds
// how long any one site can wedge its own worker; if every worker in the
// pool, on whatever site it happened to be on, goes silent for several
// multiples of that, the common cause is no longer content on one page, it is
// the browser underneath all of them. 4x is deliberately generous: a
// --concurrency pool does not start every site in lockstep, so some
// staggering across SITE_BUDGET_MS is normal and should never trip this on
// its own, while still catching a real stall long before it can pile up the
// kind of orphaned process count the 2026-08 diagnosis found.
const WATCHDOG_STALL_MS = SITE_BUDGET_MS * 4;
// How often the watchdog checks for that stall. Coarse enough to cost
// nothing, fine enough that the extra detection delay past
// WATCHDOG_STALL_MS is negligible next to it.
const WATCHDOG_POLL_MS = 5_000;

/**
 * Races an arbitrary in-flight operation against a timeout without cancelling
 * it - Playwright gives no way to cancel a newPage(), a close() or an
 * evaluate() once started, so "abandon and move on" is the only option when
 * something takes too long. Both branches of the settle logic below are
 * attached synchronously to `promise` before either the timer or the promise
 * itself can fire, which means there is always a rejection handler in place:
 * if the abandoned promise fails later, after the timeout has already won,
 * that failure is swallowed here instead of surfacing as an unhandled
 * rejection with nobody left awaiting it.
 *
 * `browserHung`, when set, tags the timeout error so callers that only know
 * how to recognise a browser dying via isBrowserDeadError() (an actual thrown
 * "Target closed") can also recognise a browser that never throws anything at
 * all because it has simply stopped answering - see isBrowserUnresponsive().
 */
function raceTimeout(promise, ms, label, { browserHung = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`${label} scaduto dopo ${ms / 1000}s`);
      if (browserHung) error.browserHung = true;
      reject(error);
    }, ms);

    promise.then(
      (value) => {
        if (settled) return; // the timeout already won; a late success no longer matters
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return; // the timeout already won; this is exactly the late failure described above
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Races a site's entire probeSite workload against SITE_BUDGET_MS. This is
 * the one raceTimeout() use that is deliberately not tagged browserHung: a
 * site wedging its own worker (the rewe.de/Cloudflare Turnstile case this
 * budget was first built for) is a site problem, not proof the browser
 * itself is unresponsive, so it keeps the existing ERRORE verdict rather than
 * being routed through the browser-restart path.
 */
function withSiteBudget(promise) {
  return raceTimeout(promise, SITE_BUDGET_MS, 'budget del sito');
}

function loadRuleset() {
  const rules = JSON.parse(readFileSync(join(root, 'src/rules/rules.json'), 'utf8'));
  const labels = JSON.parse(readFileSync(join(root, 'src/rules/labels.json'), 'utf8'));
  return resolveTextMatchRefs(rules, labels);
}

/**
 * Turns a --sites value into an actual path the same tolerant way regardless
 * of how it was spelled: a full path, something relative to wherever this
 * was launched from, or - the case this flag exists for - the bare name of a
 * tier plan sweep-plan.mjs already wrote under verification/ (e.g.
 * "plan-sentinel.json"), so that plan can be pointed at directly instead of
 * ever having to be copied over verify-sites.json by hand.
 */
function resolveSitesPath(name) {
  if (isAbsolute(name)) {
    if (existsSync(name)) return name;
  } else {
    const relativeToCwd = join(process.cwd(), name);
    if (existsSync(relativeToCwd)) return relativeToCwd;
  }
  const insideVerification = join(OUT_DIR, name);
  if (existsSync(insideVerification)) return insideVerification;
  console.error(`! file dei siti non trovato: "${name}" (provato come percorso assoluto, relativo alla cartella corrente, e dentro verification/)`);
  process.exit(1);
}

function loadSites() {
  const sitesPath = SITES_NAME ? resolveSitesPath(SITES_NAME) : join(here, 'verify-sites.json');
  const sites = JSON.parse(readFileSync(sitesPath, 'utf8'));
  if (!Array.isArray(sites) || sites.some((s) => !s || typeof s.slug !== 'string' || typeof s.url !== 'string')) {
    console.error(`! ${sitesPath} non e' un elenco valido di siti: serve un array di oggetti con almeno "slug" e "url" (lo stesso formato di verify-sites.json)`);
    process.exit(1);
  }
  return ONLY ? sites.filter((s) => s.url.includes(ONLY)) : sites;
}

/**
 * Loads the report named by --resume, keyed by url, so main() can tell which
 * sites already have a verdict worth keeping. Resolved under verification/
 * exactly like OUT_NAME - a resume always reads and writes reports from the
 * same place. Returns an empty map when --resume was not passed at all,
 * which keeps the caller from needing a separate "was this even requested"
 * branch.
 */
function loadResume() {
  if (!RESUME_NAME) return new Map();
  const resumePath = join(OUT_DIR, RESUME_NAME);
  let records;
  try {
    records = JSON.parse(readFileSync(resumePath, 'utf8'));
  } catch (error) {
    console.error(`! impossibile leggere il report da riprendere verification/${RESUME_NAME}: ${error.message}`);
    process.exit(1);
  }
  if (!Array.isArray(records)) {
    console.error(`! verification/${RESUME_NAME} non contiene un array di record; impossibile riprenderlo.`);
    process.exit(1);
  }
  const byUrl = new Map();
  for (const record of records) {
    if (record && record.url) byUrl.set(record.url, record);
  }
  return byUrl;
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

/**
 * Probes every frame, not just the top one.
 *
 * The extension runs its content script in all frames because some consent
 * platforms render their UI inside a cross-origin iframe. A verifier that only
 * looked at the top document would report "no banner" for exactly those cases -
 * a false all-clear, which is worse than a reported failure because nobody
 * investigates it.
 */
/**
 * Signals that say whether a page is still usable.
 *
 * "Do not break the page" is the blocking requirement, so it has to be
 * measurable rather than eyeballed. The one that matters most is scroll
 * locking: consent platforms set overflow:hidden on body or html to hold the
 * page while their banner is up, and clear it when the banner is dismissed. If
 * a refusal closes the banner without triggering that cleanup, the page stays
 * frozen forever - banner gone, site unusable. That is precisely how the
 * incumbent extension earned its 3.11 rating.
 */
async function usability(page) {
  return page.evaluate(() => {
    const overflowOf = (el) => {
      const s = getComputedStyle(el);
      return { overflow: s.overflow, overflowY: s.overflowY, position: s.position };
    };
    const blockingOverlays = [...document.querySelectorAll('div,aside,section,dialog')].filter((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (s.position === 'fixed' || s.position === 'sticky')
        && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0
        && (Number.parseInt(s.zIndex, 10) || 0) > 500
        && r.width > innerWidth * 0.5 && r.height > innerHeight * 0.5;
    }).length;
    return {
      body: overflowOf(document.body),
      html: overflowOf(document.documentElement),
      scrollLocked: /hidden|clip/.test(getComputedStyle(document.body).overflowY)
        || /hidden|clip/.test(getComputedStyle(document.documentElement).overflowY),
      blockingOverlays,
      textLength: (document.body.innerText || '').length,
      linkCount: document.querySelectorAll('a[href]').length,
    };
  });
}

async function probeAllFrames(page, probeSource, ruleset) {
  // null, not a pre-filled object: the first frame that actually answers -
  // even with suspected: 0 - should become the fallback, rather than being
  // measured against a synthetic zero it can never beat and losing its real
  // fingerprint/frameUrl to a default that has neither.
  let fallback = null;
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((src) => {
        if (!window.__crProbe) {
          const s = document.createElement('script');
          s.textContent = src;
          document.documentElement.appendChild(s);
          s.remove();
        }
      }, probeSource);
      const result = await frame.evaluate((rs) => (window.__crProbe ? window.__crProbe.run(rs) : null), ruleset);
      if (!result) continue;
      if (result.cmpId) return { ...result, frameUrl: frame.url() };
      if (!fallback || result.suspected > fallback.suspected) fallback = { ...result, frameUrl: frame.url() };
    } catch {
      // Cross-origin frames can refuse injection; skip rather than fail the site.
    }
  }
  return fallback || { cmpId: null, steps: [], suspected: 0 };
}

/**
 * Recognises the one failure mode that is never about the site or the rule:
 * the browser or its context is gone. Playwright surfaces this identically
 * from newPage, goto, evaluate or waitForTimeout alike, always with one of
 * these two messages, so a single check here is enough to catch it wherever
 * it happens to fire.
 */
function isBrowserDeadError(error) {
  const message = String((error && error.message) || error);
  return /Target page, context or browser has been closed/.test(message)
    || /Target closed/.test(message);
}

/**
 * The sibling check to isBrowserDeadError(): recognises a browser that never
 * throws anything because it has gone quiet while still technically alive -
 * the actual failure mode the 2026-08 stall diagnosis found (21
 * chrome-headless-shell.exe processes still running, CPU flat, no error ever
 * raised). raceTimeout() tags its own timeout errors with browserHung when the
 * operation being timed is page/context/browser-lifecycle plumbing rather
 * than site content, so this is the single place both signals - the browser
 * throwing, and the browser silently hanging - get treated as the same event
 * everywhere a worker decides whether to trigger a restart.
 */
function isBrowserUnresponsive(error) {
  return isBrowserDeadError(error) || Boolean(error && error.browserHung);
}

/**
 * Navigates once, and once more if the first attempt fails.
 *
 * A chunk of the failures a broad sweep turns up are not about the rule or the
 * site at all - a dropped connection, a mid-handshake reset, a slow TLS
 * negotiation that just missed the deadline. Those are exactly the kind of
 * thing that clears up on a second try, and re-running the whole sweep for a
 * handful of such sites is wasteful. This is deliberately a single retry, not
 * a loop: a site that fails twice in a row is telling us something real, and
 * masking that behind more attempts would make the report dishonest. The
 * attempt count always ends up on the record precisely so nothing is hidden.
 */
async function gotoWithRetry(page, url) {
  let attempts = 0;
  let lastError;
  for (let i = 0; i < 2; i += 1) {
    attempts += 1;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      return attempts;
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(lastError, { attempts });
}

async function probeSite(context, site, ruleset, probeSource) {
  const record = { url: site.url, expect: site.expect || null };
  // Not opened yet: if context.newPage() itself times out below, there is no
  // page for the finally block to close, and this stays null so it knows to
  // skip that step instead of calling close() on undefined.
  let page = null;

  try {
    // Opening the page is deliberately kept out of the runSite() budget raced
    // below: a page that never finishes opening has nothing for the finally
    // block to close, so it gets its own explicit ceiling instead (see
    // HANDLE_OPEN_TIMEOUT_MS), tagged browserHung because a hang here - unlike
    // a slow site - is a property of the browser, not of site.url.
    page = await raceTimeout(context.newPage(), HANDLE_OPEN_TIMEOUT_MS, 'apertura pagina', { browserHung: true });

    // The whole per-site pipeline below - navigation, detection, and (with
    // --execute) the click flow, its waits and the screenshots - runs inside
    // this one async function so it can be raced against SITE_BUDGET_MS as a
    // single unit. Nothing in here can be trusted to time out on its own: see
    // SITE_BUDGET_MS's comment for the frame.evaluate() that proved it.
    async function runSite() {
      record.attempts = await gotoWithRetry(page, site.url);

      const startedAt = Date.now();
      let before = null;
      while (Date.now() - startedAt < DETECT_MAX_MS) {
        before = await probeAllFrames(page, probeSource, ruleset);
        if (before.cmpId) break;
        await page.waitForTimeout(DETECT_POLL_MS);
      }
      if (!before || !before.cmpId) {
        before = await probeAllFrames(page, probeSource, ruleset);
      }
      record.detectMs = before.cmpId ? Date.now() - startedAt : null;
      record.frame = before.frameUrl || null;
      record.before = before;
      record.verdict = verdict(site, before);

      if (EXECUTE && before.cmpId) {
        record.usabilityBefore = await usability(page);
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 120)));
        if (!NO_SHOTS) await page.screenshot({ path: join(OUT_DIR, `${site.slug}-prima.png`) }).catch(() => {});
        // Execute the real flow through the engine, in the page, exactly as the
        // extension would - including the click simulation and waits.
        await page.evaluate(async ({ rs, id }) => {
          const cmp = rs.cmps.find((c) => c.id === id);
          if (cmp && window.__crRunFlow) await window.__crRunFlow(cmp.flow);
        }, { rs: ruleset, id: before.cmpId });
        await page.waitForTimeout(2500);
        record.after = await probeAllFrames(page, probeSource, ruleset);
        record.usabilityAfter = await usability(page);
        record.pageErrors = pageErrors;
        if (!NO_SHOTS) await page.screenshot({ path: join(OUT_DIR, `${site.slug}-dopo.png`) }).catch(() => {});

        const b = record.usabilityBefore;
        const a = record.usabilityAfter;
        const broke = [];
        // Scroll left locked after we acted, when it was not locked before, or
        // still locked when the banner that justified it is gone.
        if (a.scrollLocked && !record.after.cmpId) broke.push('scroll bloccato');
        if (a.blockingOverlays > 0 && !record.after.cmpId) broke.push('overlay residuo');
        if (a.textLength < b.textLength * 0.5) broke.push('contenuto sparito');
        if (a.linkCount < b.linkCount * 0.5) broke.push('navigazione persa');
        if (pageErrors.length) broke.push(`${pageErrors.length} errori JS`);
        record.broke = broke;
      }
    }

    await withSiteBudget(runSite());
  } catch (error) {
    if (isBrowserUnresponsive(error)) {
      // Either the browser/context actually died mid-flight (isBrowserDeadError),
      // or context.newPage() above hung long enough to be tagged browserHung -
      // either way this is not the site's fault. Recording ERRORE here would
      // claim the site was tested and failed, when it never really got a fair
      // shot, so this is rethrown for the worker to catch, recover the
      // browser, and put the site back on the queue for a real attempt.
      throw error;
    }
    // This also catches SITE_BUDGET_MS expiring: withSiteBudget rejects with a
    // plain Error whose message is "budget del sito scaduto dopo Ns", and
    // String(error) on a plain Error already renders as "Error: <message>",
    // so it lands on the record verbatim through the same path as any other
    // failure - unlike a dead browser, this site genuinely was attempted, so
    // ERRORE (not NON PROVATO) is the honest verdict for it.
    record.verdict = 'ERRORE';
    record.error = String(error).split('\n')[0].slice(0, 120);
    // gotoWithRetry tags its own failures with how many attempts it made;
    // anything that fails elsewhere (detection, execution, or a budget
    // timeout) got there after a single successful navigation, so it
    // defaults to 1 rather than being left undefined.
    if (record.attempts === undefined) record.attempts = error.attempts || 1;
  } finally {
    // Runs whether the page never opened, runSite() finished, threw, or was
    // abandoned by a timed-out race - so a site that wedges the page (e.g.
    // stuck behind an anti-bot challenge, see SITE_BUDGET_MS) still gets its
    // page closed instead of piling up as an orphaned tab for the rest of the
    // sweep. `page` can be null here if context.newPage() itself never
    // finished, in which case there is nothing to close. The close itself is
    // raced too (see HANDLE_CLOSE_TIMEOUT_MS): it used to have no ceiling at
    // all, and a hang here - the browser going quiet mid-close instead of
    // throwing - was the actual mechanism behind the 2026-08 stall, since it
    // left this very finally block hanging forever with the page still open.
    // Its outcome, timeout included, is always swallowed: by now `record`
    // already holds its real verdict (or ERRORE), and a close that will never
    // succeed must not be allowed to throw that away. Closing the page also
    // causes whatever runSite() call is still hanging underneath to reject
    // shortly after, which is exactly the late failure withSiteBudget is
    // built to swallow rather than leaving it unhandled.
    if (page) {
      await raceTimeout(page.close(), HANDLE_CLOSE_TIMEOUT_MS, 'chiusura pagina').catch(() => {});
    }
  }
  return record;
}

/**
 * Strips the parenthetical detail off verdicts like "CMP DIVERSO (klaro)" or
 * "SELETTORI MANCANTI (2/5)" so the summary can group by the fixed set of
 * verdict kinds instead of fragmenting into one bucket per site. The stored
 * record.verdict itself is left untouched - other code compares it verbatim.
 */
function verdictCategory(v) {
  const i = v.indexOf('(');
  return i === -1 ? v : v.trim().slice(0, i).trim();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ruleset = loadRuleset();
  const sites = loadSites();
  const resumeByUrl = loadResume();
  const probeSource = await buildProbe();
  const total = sites.length;
  const outPath = join(OUT_DIR, OUT_NAME);
  const counterWidth = String(total).length;

  // Headless Chromium has a documented history of mishandling HTTP/2 with some
  // servers (net::ERR_HTTP2_PROTOCOL_ERROR against sites - italotreno.com,
  // yoox.com, adobe.com and others in this sweep - that load fine in a headed
  // browser). The textbook mitigation is `--disable-http2`, but it was tested
  // here against all eleven sites that showed the error and made every single
  // one *worse*: instead of failing in well under a second with a clear error,
  // the navigation hung for the entire NAV_TIMEOUT with nothing ever coming
  // back (no response, no partial load), most likely because whatever is
  // rejecting the HTTP/2 connection here (bot mitigation on the CDN edge is
  // the most consistent explanation - headed Chrome, whose HTTP/2 fingerprint
  // differs from headless, loads the same sites without issue) drops the
  // fallback HTTP/1.1 attempt on the floor rather than answering it. So the
  // flag is deliberately NOT set. What actually helps these sites is the
  // realistic user agent above (some of the mitigation is UA-based) plus the
  // retry and longer timeout below, which at least give a flaky connection a
  // second chance without pretending there is a clean fix for the rest.
  //
  // These launch args are all about surviving a long headless run rather than
  // any particular site's behaviour:
  const CHROMIUM_LAUNCH_ARGS = [
    // /dev/shm is often tiny in containers and CI; Chromium's default use of
    // it as a shared-memory backing store for tab data is a well-known crash
    // source once enough pages have been through it. This makes it fall back
    // to regular temp files instead.
    '--disable-dev-shm-usage',
    // There is no screen to composite to in headless mode, so the GPU process
    // is pure overhead here - one less process to keep alive, one less thing
    // that can crash and take the browser down with it.
    '--disable-gpu',
    // Chromium normally throttles timers and deprioritises work in tabs it
    // considers backgrounded/occluded, which does not make sense for a
    // headless page that is never actually shown, and would skew the
    // detection timing this script deliberately measures.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // The built-in crash reporter adds its own overhead across the many
    // short-lived renderer processes a sweep like this creates, and this
    // script already catches and logs failures itself, so it is redundant.
    '--disable-crash-reporter',
  ];

  async function launchBrowser() {
    return chromium.launch({ headless: !HEADED, args: CHROMIUM_LAUNCH_ARGS });
  }

  let browser = await launchBrowser();
  const contextOptions = {
    userAgent: USER_AGENT,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    viewport: { width: 1366, height: 900 },
  };

  // Pre-sized and left sparse: a worker writes into its own index and never
  // touches another's, so there is no coordination needed between them, and
  // slots for sites that have not finished yet stay as genuine holes rather
  // than placeholders that would need to be filtered out by value.
  const results = new Array(total);
  let completed = 0;

  // A queue of pending indices rather than a simple incrementing counter,
  // specifically so a site whose attempt was cut short by a dead browser can
  // be pushed back onto it and actually get tried again, instead of the
  // sweep either losing it or - worse - reporting it as a real failure.
  //
  // With --resume, a site only skips the queue - and gets its prior record
  // carried over untouched - when that record already holds a real verdict.
  // NON PROVATO means the previous sweep never actually got to try it, and
  // ERRORE means it was tried and abandoned (a timeout, a dead browser); both
  // are exactly the sites resuming exists to give another shot, so neither is
  // treated as "already resolved" here.
  const queue = [];
  let inheritedCount = 0;
  for (let i = 0; i < total; i += 1) {
    const prior = resumeByUrl.get(sites[i].url);
    if (prior && prior.verdict && prior.verdict !== 'NON PROVATO' && prior.verdict !== 'ERRORE') {
      results[i] = prior;
      completed += 1;
      inheritedCount += 1;
    } else {
      queue.push(i);
    }
  }
  if (RESUME_NAME) {
    console.log(`--resume ${RESUME_NAME}: ${inheritedCount} siti ereditati con esito gia' reale, ${queue.length} da (ri)provare.`);
  }

  // browserGeneration marks which launchBrowser() call is currently live. A
  // worker records the generation its context came from; if that number has
  // moved on by the time the worker's own operation fails, some other worker
  // already noticed the same dead browser and relaunched it, so this one just
  // adopts the new browser instead of triggering a redundant second restart.
  let browserGeneration = 0;
  let browserRestarts = 0;
  let giveUp = false;
  // Multiple workers can hit the same dead browser at nearly the same time;
  // restartInFlight makes sure only the first one actually relaunches while
  // the rest await that same relaunch instead of racing each other.
  let restartInFlight = null;
  // Wall-clock time any site last finished, anywhere in the pool. Tracked
  // independently of browserRestarts/giveUp so the watchdog below has a
  // signal that does not depend on anything having thrown - see its own
  // comment for what it is actually guarding against.
  let lastProgressAt = Date.now();

  async function doRestart() {
    browserRestarts += 1;
    if (browserRestarts > MAX_BROWSER_RESTARTS) {
      giveUp = true;
      console.log(`\n! il browser e' morto ${browserRestarts} volte: superato il tetto di ${MAX_BROWSER_RESTARTS} riavvii, interrompo lo sweep in modo ordinato.`);
      return false;
    }
    console.log(`\n! il browser si e' chiuso inaspettatamente, riavvio ${browserRestarts}/${MAX_BROWSER_RESTARTS}...`);
    // A mute-but-alive browser is exactly what doRestart() exists to recover
    // from, which makes this close() the single worst place in the file to
    // trust without a ceiling: if the old browser will not even cooperate on
    // the way out, launchBrowser() below still has to be reached regardless.
    // The .catch() is kept for the same reason as everywhere else - a close
    // that will never succeed must not stop the restart it is blocking.
    await raceTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'chiusura browser (riavvio)').catch(() => {});
    browser = await launchBrowser();
    browserGeneration += 1;
    return true;
  }

  function recoverFromBrowserDeath() {
    if (giveUp) return Promise.resolve(false);
    if (!restartInFlight) {
      restartInFlight = doRestart().finally(() => {
        restartInFlight = null;
      });
    }
    return restartInFlight;
  }

  function persistResults() {
    // Array.prototype.filter skips holes on its own, so this naturally omits
    // whatever has not finished yet without needing an explicit undefined check.
    writeFileSync(outPath, JSON.stringify(results.filter(Boolean), null, 2));
  }

  // The 2026-08 stall this file was rewritten for never threw - every
  // page/context/browser operation above now has its own ceiling, but that
  // only bounds one hang at a time, and does nothing if the whole pool
  // happens to be waiting on one of those ceilings at once because the
  // browser underneath all of them has gone quiet. This is the independent
  // check for exactly that: if no worker has finished a single site in
  // WATCHDOG_STALL_MS, it is no longer plausible that one difficult site is
  // to blame, so the watchdog forces the same restart a thrown "browser is
  // dead" error would have. That either gets the sweep moving again on a
  // fresh browser, or - once MAX_BROWSER_RESTARTS is exhausted - sets giveUp
  // and lets the pool wind down through the same ordered path a real crash
  // does: workers exit their loop as their current operation's own ceiling
  // expires, every slot still empty afterwards becomes NON PROVATO, and the
  // partial report is written, instead of the process just sitting there.
  const watchdogTimer = setInterval(() => {
    if (giveUp) return;
    if (Date.now() - lastProgressAt <= WATCHDOG_STALL_MS) return;
    console.log(`\n! nessun sito completato da oltre ${Math.round(WATCHDOG_STALL_MS / 1000)}s: il browser sembra vivo ma muto, forzo lo stesso riavvio che scatterebbe su un errore.`);
    // Whatever comes next - a fresh browser, or the ordered shutdown
    // doRestart() falls back to once restarts run out - deserves its own
    // full window before being judged too, rather than this firing again on
    // the very next poll.
    lastProgressAt = Date.now();
    recoverFromBrowserDeath().catch(() => {});
  }, WATCHDOG_POLL_MS);

  async function worker() {
    // The startup open is racy the same way the recycle and post-restart
    // ones already are: if the browser is mute right as the pool spins up,
    // an unguarded newContext() here has no default timeout of its own and
    // would leave this worker's promise pending forever, tied to a browser
    // instance the watchdog can relaunch but can never make this specific
    // call return - which is exactly the silent stall the rest of this file
    // exists to prevent.
    let context;
    let generation = browserGeneration;
    try {
      context = await raceTimeout(browser.newContext(contextOptions), HANDLE_OPEN_TIMEOUT_MS, 'apertura contesto (avvio worker)', { browserHung: true });
    } catch (error) {
      if (isBrowserUnresponsive(error) && generation === browserGeneration) {
        const recovered = await recoverFromBrowserDeath();
        if (!recovered) return; // restart budget exhausted; nothing was ever dequeued, so this worker simply never starting loses no site
      }
      try {
        context = await raceTimeout(browser.newContext(contextOptions), HANDLE_OPEN_TIMEOUT_MS, 'apertura contesto (avvio worker)', { browserHung: true });
        generation = browserGeneration;
      } catch {
        // Still no usable context after a restart attempt (or the failure
        // was never a browser death to begin with); ending this worker here
        // costs only its own concurrency slot - no site has been taken off
        // the queue yet for the other workers to lose.
        return;
      }
    }
    // Sites handled by this context since it was last opened; recycled every
    // CONTEXT_RECYCLE_SITES, see the constant's own comment for why.
    let sinceRecycle = 0;
    try {
      while (true) {
        if (giveUp) break;
        const index = queue.shift();
        if (index === undefined) break;
        const site = sites[index];

        let record;
        try {
          record = await probeSite(context, site, ruleset, probeSource);
        } catch (error) {
          // probeSite() only ever rethrows (rather than swallowing into an
          // ERRORE record) when it already decided the failure was not the
          // site's fault - see isBrowserUnresponsive() at its own throw site.
          // Checking the narrower isBrowserDeadError() here missed exactly
          // the case that check was added for: a raceTimeout() that expired
          // on browser/context/page-lifecycle plumbing (tagged browserHung)
          // rather than on an actual "Target closed" - such an error has
          // nothing to do with site.url, so recognising only the literal
          // thrown message and falling through to the ERRORE backstop below
          // would silently misfile a dead-browser stall as a bad site.
          if (isBrowserUnresponsive(error)) {
            if (generation === browserGeneration) {
              const recovered = await recoverFromBrowserDeath();
              if (!recovered) {
                // Restart budget exhausted. Leave this site's slot empty
                // rather than guessing at a record for it - the hole-filling
                // pass after the pool winds down turns every slot still
                // empty at that point into a NON PROVATO record, which
                // covers this site along with whatever else was still
                // queued or in flight.
                break;
              }
            }
            // Either this worker triggered the restart, or another one beat
            // it to it while this one was still awaiting its own failure -
            // either way there is a live browser now to get a context from,
            // but that hand-off is raced too: a browser that comes back up
            // just to immediately go quiet again is indistinguishable from
            // one that never came back at all, and must not be allowed to
            // hang this worker either.
            try {
              context = await raceTimeout(
                browser.newContext(contextOptions),
                HANDLE_OPEN_TIMEOUT_MS,
                'apertura contesto (dopo riavvio)',
                { browserHung: true },
              );
            } catch {
              queue.push(index); // still give the site a real attempt later
              break; // nothing left to retry with here; end this worker cleanly
            }
            generation = browserGeneration;
            sinceRecycle = 0;
            queue.push(index); // give the site a real attempt instead of losing it
            continue;
          }

          // probeSite already guards navigation and page-level failures; this
          // is the backstop for anything that escapes it regardless (e.g. the
          // context itself going bad), so one broken site cannot take its
          // worker, and the slice of the sweep still queued behind it, down.
          record = {
            url: site.url,
            expect: site.expect || null,
            verdict: 'ERRORE',
            error: String(error).split('\n')[0].slice(0, 120),
          };
        }

        results[index] = record;
        completed += 1;
        sinceRecycle += 1;
        lastProgressAt = Date.now(); // fed to the watchdog below

        const found = record.before && record.before.cmpId ? record.before.cmpId : '-';
        const ms = record.detectMs !== null && record.detectMs !== undefined ? `${(record.detectMs / 1000).toFixed(1)}s` : '';
        const dmg = record.broke && record.broke.length ? `  ROTTO: ${record.broke.join(', ')}` : (EXECUTE && record.usabilityAfter ? '  pagina integra' : '');
        const counter = `[${String(completed).padStart(counterWidth)}/${total}]`;
        console.log(`${counter} ${record.verdict.padEnd(26)} ${String(found).padEnd(22)} ${ms.padStart(5)}  ${site.url}${dmg}`);

        // Written after every site, not just at the end, so a crash partway
        // through a long sweep still leaves a usable partial report behind.
        persistResults();

        if (sinceRecycle >= CONTEXT_RECYCLE_SITES) {
          // The periodic recycle this constant is named for - both closing
          // the old context and opening its replacement used to be awaited
          // with no ceiling at all, which is precisely the scenario this
          // whole file defends against: a mute-but-alive browser would hang
          // this forever, and unlike a single site wedging on SITE_BUDGET_MS,
          // there is no per-site budget racing a context recycle to catch it.
          try {
            await raceTimeout(context.close(), HANDLE_CLOSE_TIMEOUT_MS, 'chiusura contesto (riciclo)', { browserHung: true }).catch(() => {});
            context = await raceTimeout(browser.newContext(contextOptions), HANDLE_OPEN_TIMEOUT_MS, 'apertura contesto (riciclo)', { browserHung: true });
            generation = browserGeneration;
          } catch (error) {
            if (isBrowserUnresponsive(error) && generation === browserGeneration) {
              const recovered = await recoverFromBrowserDeath();
              if (!recovered) break;
            }
            try {
              context = await raceTimeout(browser.newContext(contextOptions), HANDLE_OPEN_TIMEOUT_MS, 'apertura contesto (riciclo)', { browserHung: true });
              generation = browserGeneration;
            } catch {
              // Recycling never recovered even after a restart attempt;
              // ending this worker cleanly beats looping on a browser that
              // keeps refusing to hand out a usable context.
              break;
            }
          }
          sinceRecycle = 0;
        }
      }
    } finally {
      // Same reasoning as the recycle above: closing the final context on the
      // way out must not be trusted to resolve on its own.
      await raceTimeout(context.close(), HANDLE_CLOSE_TIMEOUT_MS, 'chiusura contesto (fine worker)').catch(() => {});
    }
  }

  const workerCount = Math.min(CONCURRENCY, total) || 1;
  // Wrapped in try/finally rather than just awaited: a worker is meant to
  // absorb its own failures into an ERRORE record or a clean return, but if
  // one still propagates an exception (persistResults()'s writeFileSync
  // failing is the realistic case, since nothing shields that one), letting
  // it reject Promise.all unguarded would skip everything below - the
  // watchdog's timer, the NON PROVATO hole-filling, and the final report
  // write - throwing away an hours-long sweep's results over the very last
  // site instead of just the one that actually failed. main().catch() below
  // still reports the error and exits non-zero either way; what this exists
  // to save is the report that would otherwise vanish with it.
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    // The sweep is over, one way or another; nothing left for the watchdog to
    // guard, and an uncleared setInterval is exactly the kind of thing that
    // keeps a Node process alive forever after everything else is done.
    clearInterval(watchdogTimer);

    // Anything still without a record at this point was queued (or in flight)
    // when the restart budget ran out - the sweep genuinely never tested it,
    // so it gets its own honest verdict instead of a false ERRORE or a silent
    // gap.
    for (let i = 0; i < total; i += 1) {
      if (!results[i]) {
        results[i] = {
          url: sites[i].url,
          expect: sites[i].expect || null,
          verdict: 'NON PROVATO',
          error: `sweep interrotto dopo ${browserRestarts} riavvii del browser`,
        };
      }
    }

    // Raced for the same reason doRestart()'s own browser.close() is: this
    // finally block is exactly where an unresponsive browser is likeliest to
    // still be sitting, and it must not be allowed to block the
    // persistResults() call right after it - the one write this whole
    // try/finally exists to guarantee.
    await raceTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'chiusura browser (fine sweep)').catch(() => {});
    persistResults();
  }

  const ok = results.filter((r) => r.verdict === 'ok').length;
  console.log(`\n${ok}/${results.length} regole confermate sul campo`);

  const verdictCounts = new Map();
  for (const r of results) {
    const category = verdictCategory(r.verdict);
    verdictCounts.set(category, (verdictCounts.get(category) || 0) + 1);
  }
  const sortedVerdicts = [...verdictCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('per verdetto:');
  for (const [category, count] of sortedVerdicts) {
    console.log(`  ${String(count).padStart(4)}  ${category}`);
  }

  if (EXECUTE) {
    const broken = results.filter((r) => r.broke && r.broke.length > 0).length;
    console.log(`${broken}/${results.length} siti con pagina rotta dopo il rifiuto`);
  }

  // Reported unconditionally, not only when non-zero, so a clean sweep is
  // visibly confirmed clean rather than leaving the reader to wonder whether
  // this line was simply omitted.
  console.log(`riavvii del browser durante lo sweep: ${browserRestarts}${giveUp ? ' (tetto superato, sweep interrotto in anticipo)' : ''}`);

  console.log(`dettaglio completo: verification/${OUT_NAME}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
