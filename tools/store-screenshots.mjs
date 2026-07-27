#!/usr/bin/env node
/**
 * Produces the three 1280x800 screenshots used on the addons.mozilla.org
 * listing (verification/store/01-refused.png, 02-unhandled.png,
 * 03-report-preview.png).
 *
 * Every screenshot is a composite of two REAL Playwright captures:
 *  - a full 1280x800 screenshot of a real, live page, and
 *  - a screenshot of the real popup (dist/ui/popup.html + the real
 *    dist/ui/popup.js bundle), rendered at its real CSS width.
 *
 * The popup is never re-typed or mocked: this script stubs only the global
 * `browser` object (WebExtension API surface) that src/engine/browser-api.js
 * talks to, via Playwright's addInitScript, so the unmodified popup.js bundle
 * runs exactly as it would inside the extension and paints itself from that
 * stub. The stub's own data (localized strings, extension version, tab
 * outcome) is either read straight off disk (manifest.json, _locales/en) or
 * measured live from the real detection/refusal engine (src/engine/detect.js,
 * src/engine/steps.js) against the real site in the same run - never invented.
 *
 * The two images are then composited by loading them into a third, plain
 * Playwright page (two absolutely positioned <img> tags, popup on top of the
 * background) and screenshotting THAT page - so no image-processing
 * dependency is needed beyond Chromium's own compositor.
 *
 * Re-run any time with: node tools/store-screenshots.mjs
 */

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

import { MESSAGE_GET_TAB_STATE, OUTCOME_STATUS } from '../src/engine/messages.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT_DIR = join(root, 'verification', 'store');
const DIST_UI_DIR = join(root, 'dist', 'ui');

const WIDTH = 1280;
const HEIGHT = 800;
// A bit more than the brief's "~24px" floor: at 1280x800, 24px alone read as
// the popup touching the frame edge once actually screenshotted (see
// verifyMargins() below, which now checks this on the real pixels of every
// run instead of trusting this constant). Sized to comfortably clear
// SHADOW_MAX_REACH_PX (below) on every side, so the shadow itself never
// bleeds all the way out to the frame edge - a human glancing at the image
// must see clean background, not just shadow-tinted edge-to-edge coverage.
const POPUP_MARGIN = 40;
// Upper bound on how far composite()'s box-shadow visibly extends past the
// popup card (its largest offset plus blur radius - see the box-shadow rule
// in composite(), kept in sync with this number). verifyMargins() samples
// within a few px of the frame edge, comfortably inside the (POPUP_MARGIN -
// SHADOW_MAX_REACH_PX) buffer, so it is certain to read clean background
// rather than shadow falloff.
const SHADOW_MAX_REACH_PX = 26;

const DETECT_POLL_MS = 500;
const DETECT_MAX_MS = 20_000;

// ---------------------------------------------------------------------------
// Setup: build the real extension, load its real static data.
// ---------------------------------------------------------------------------

function ensureFreshBuild() {
  const result = spawnSync('node', ['build.mjs'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('npm run build (node build.mjs) failed - fix the build before generating store screenshots');
  }
}

function loadManifest() {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
}

function loadLocaleMessages() {
  return JSON.parse(readFileSync(join(root, '_locales', 'en', 'messages.json'), 'utf8'));
}

function loadShippedRuleset() {
  // Exactly what the built extension itself loads at runtime (bundled
  // fallback path) - see src/engine/ruleset.js and build.mjs.
  return JSON.parse(readFileSync(join(root, 'dist', 'rules', 'ruleset.json'), 'utf8'));
}

function readPopupWidthPx() {
  const css = readFileSync(join(root, 'src', 'ui', 'popup.css'), 'utf8');
  const match = css.match(/\bbody\s*\{[^}]*\bwidth:\s*(\d+)px/);
  if (!match) throw new Error('Could not read the popup width from src/ui/popup.css - is the `body { width: ... }` rule still there?');
  return Number(match[1]);
}

/**
 * Bundles a small measurement entry point straight from the real engine
 * modules (src/engine/detect.js, src/engine/steps.js) - same technique as
 * tools/verify-rules.mjs's probe, so nothing about detection or refusal is
 * reimplemented here. Exposes on `window.__crMeasure`:
 *  - detect(ruleset): which CMP (if any) currently matches the page, no click.
 *  - run(ruleset): detects AND runs the real refusal flow, timed exactly the
 *    way src/engine/content.js does it, returning the same shape it would
 *    send as a MESSAGE_OUTCOME.
 *  - suspected(): the same "unhandled suspicious banner" heuristic
 *    content.js uses (its detection-only half - duplicated here only because
 *    content.js keeps it module-private; the logic itself is copied
 *    verbatim, not reinterpreted).
 */
async function buildMeasureBundle() {
  const entrySource = `
    import { detectCMP, isActionableKind } from '../src/engine/detect.js';
    import { runFlow } from '../src/engine/steps.js';
    import { OUTCOME_STATUS } from '../src/engine/messages.js';

    const HEURISTIC_MIN_Z_INDEX = 999;
    const CONSENT_TERMS = [
      'cookie', 'cookies', 'consent', 'privacy choices',
      'rifiuta', 'accetta', 'consenso', 'cookie policy',
      'ablehnen', 'zustimmen', 'einwilligung',
      'accepter', 'refuser', 'consentement',
      'rechazar', 'aceptar', 'consentimiento',
    ];

    function isSuspiciousBanner(el) {
      try {
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        const zIndex = parseInt(style.zIndex, 10);
        if (Number.isNaN(zIndex) || zIndex < HEURISTIC_MIN_Z_INDEX) return false;
        const text = (el.textContent || '').toLowerCase();
        return CONSENT_TERMS.some((term) => text.includes(term));
      } catch {
        return false;
      }
    }

    function findSuspiciousBanner() {
      try {
        const candidates = document.body ? Array.from(document.body.children) : [];
        return candidates.find(isSuspiciousBanner) || null;
      } catch {
        return null;
      }
    }

    window.__crMeasure = {
      detect(ruleset) {
        const cmp = detectCMP(ruleset, document);
        return cmp ? { cmpId: cmp.id, cmpName: cmp.name, kind: cmp.kind } : null;
      },
      suspected() {
        return Boolean(findSuspiciousBanner());
      },
      async run(ruleset) {
        const cmp = detectCMP(ruleset, document);
        if (!cmp) return { matched: false };
        if (!isActionableKind(cmp.kind)) {
          return { matched: true, actionable: false, cmpId: cmp.id, cmpName: cmp.name, kind: cmp.kind };
        }
        // Timed exactly like src/engine/content.js's tryHandleCMP().
        const startedAt = Date.now();
        const results = await runFlow(cmp.flow, document);
        const durationMs = Date.now() - startedAt;
        const failedStepCount = results.filter((r) => !r.ok && !r.skipped && !r.ignored).length;
        return {
          matched: true,
          actionable: true,
          cmpId: cmp.id,
          cmpName: cmp.name,
          stepCount: results.length,
          failedStepCount,
          durationMs,
          status: failedStepCount > 0 ? OUTCOME_STATUS.FAILED : OUTCOME_STATUS.HANDLED,
        };
      },
    };
  `;

  const result = await build({
    stdin: { contents: entrySource, resolveDir: here, sourcefile: 'store-screenshots-measure-entry.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
  });
  return result.outputFiles[0].text;
}

// ---------------------------------------------------------------------------
// `browser` global stub, injected before popup.js runs.
// ---------------------------------------------------------------------------

/**
 * Runs INSIDE the page via addInitScript. Re-implements just enough of
 * `browser.i18n.getMessage`'s substitution algorithm (MDN: placeholder tokens
 * -> their `content`, then $1/$2/... -> the caller's substitutions, then
 * `$$` -> `$`) to read the real strings from _locales/en/messages.json
 * exactly as Firefox would.
 */
function installBrowserStub({ messages, manifestVersion, tabState, getTabStateMessageType }) {
  function getMessage(key, substitutions) {
    const entry = messages[key];
    if (!entry) return key;
    let text = entry.message;
    if (entry.placeholders) {
      for (const name of Object.keys(entry.placeholders)) {
        const content = entry.placeholders[name].content;
        text = text.replace(new RegExp('\\$' + name + '\\$', 'gi'), content);
      }
    }
    if (substitutions !== undefined && substitutions !== null) {
      const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
      text = text.replace(/\$(\d+)/g, (whole, n) => {
        const index = Number(n) - 1;
        return index < subs.length ? String(subs[index]) : whole;
      });
    }
    return text.replace(/\$\$/g, '$');
  }

  window.browser = {
    i18n: { getMessage },
    runtime: {
      getManifest: () => ({ version: manifestVersion }),
      sendMessage: async (message) => {
        if (message && message.type === getTabStateMessageType) return tabState || null;
        return undefined;
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
    },
    permissions: {
      contains: async () => true,
    },
  };
}

// ---------------------------------------------------------------------------
// Live measurement against real sites.
// ---------------------------------------------------------------------------

async function pollUntil(fn, { intervalMs = DETECT_POLL_MS, timeoutMs = DETECT_MAX_MS } = {}) {
  const startedAt = Date.now();
  let last = await fn();
  while (!last && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await fn();
  }
  return last;
}

/**
 * Navigates to a live OneTrust site (accenture.com, per the brief - confirmed
 * by tools/verify-rules.mjs), waits for the real banner, runs the real
 * refusal flow timed the same way src/engine/content.js does, then screenshots
 * the now-clean page. Every number in the returned outcome comes straight out
 * of this run - see the console log this function prints for the source of
 * each field.
 *
 * Site choice: the brief's original pick (accenture.com) genuinely refuses,
 * but its OneTrust flow completes in ~1-2ms (OneTrust preloads the whole
 * preference-center markup hidden in the DOM there, so nothing in the flow
 * actually waits on anything) - accurate, but reads as broken/faked on a
 * store listing. Measured, in the verifier's own candidate order
 * (booking.com, lidl.de, otto.de, ikea, atlassian, cloudflare), for the
 * first one that both genuinely succeeds AND clears MIN_REPRESENTATIVE_MS:
 *   booking.com -> handled, ~47-52ms (below threshold)
 *   lidl.de     -> handled, ~2ms (below threshold)
 *   otto.de     -> handled, ~114-122ms across repeated runs (clears it)
 * otto.de is therefore used here. It has no English version at all (a
 * German-market-only retailer, confirmed via document.documentElement.lang
 * === 'de' and no locale switcher) - declared rather than forced; see the
 * mismatch this leaves in the final report.
 */
const MIN_REPRESENTATIVE_MS = 100;

async function measureRefusedSite(browser, measureSource, ruleset) {
  const url = 'https://www.otto.de';
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    locale: 'de-DE',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await injectMeasureBundle(page, measureSource);

  const detected = await pollUntil(() => page.evaluate((rs) => window.__crMeasure.detect(rs), ruleset));
  if (!detected || !detected.cmpId) {
    throw new Error(`No known CMP detected on ${url} within ${DETECT_MAX_MS}ms - cannot build the "refused" screenshot honestly.`);
  }

  const domain = await page.evaluate(() => location.hostname);
  const measured = await page.evaluate((rs) => window.__crMeasure.run(rs), ruleset);
  if (!measured.matched || !measured.actionable) {
    throw new Error(`CMP "${detected.cmpId}" on ${url} was detected but not actionable (kind=${measured.kind}) - cannot build the "refused" screenshot.`);
  }
  if (measured.status !== OUTCOME_STATUS.HANDLED) {
    throw new Error(`CMP "${detected.cmpId}" on ${url} did not fully succeed (status=${measured.status}) - cannot build the "refused" screenshot honestly.`);
  }
  if (measured.durationMs < MIN_REPRESENTATIVE_MS) {
    throw new Error(`${url} refused in ${measured.durationMs}ms, below the ${MIN_REPRESENTATIVE_MS}ms representativeness floor - pick a different site.`);
  }

  // Let the page settle after the real click/checkbox/save sequence, same
  // margin tools/verify-rules.mjs gives it before re-probing.
  await page.waitForTimeout(2500);

  const bgPath = join(OUT_DIR, '_tmp-otto-bg.png');
  await page.screenshot({ path: bgPath });

  console.log(`[measure] otto.de -> cmp=${measured.cmpId} (${measured.cmpName}), status=${measured.status}, ` +
    `stepCount=${measured.stepCount}, failedStepCount=${measured.failedStepCount}, durationMs=${measured.durationMs} ` +
    `(all measured live just now by running the real src/engine/steps.js flow on the real page)`);

  await context.close();

  return {
    bgPath,
    outcome: {
      status: measured.status,
      domain,
      cmpId: measured.cmpId,
      cmpName: measured.cmpName,
      stepCount: measured.stepCount,
      failedStepCount: measured.failedStepCount,
      durationMs: measured.durationMs,
    },
  };
}

/**
 * Navigates to a live site whose banner is not covered by any rule.
 *
 * mediaworld.it (suggested by the brief) DOES show a home-grown banner, but
 * its markup wraps the dialog in a `position: static` container that is the
 * direct child of `<body>` (`#mms-consent-portal-container`) - and the real
 * "suspected unhandled banner" heuristic in src/engine/content.js only scans
 * *direct* children of `<body>` for `position: fixed`/`sticky`. So on
 * mediaworld.it that heuristic genuinely never fires; the popup would show
 * "Nothing to do", not "suspected". Verified live with the actual heuristic
 * code (not simulated) before switching sites, per the brief's own
 * instruction to pick a different site and declare it when one doesn't
 * collaborate.
 *
 * ryanair.com's cookie banner (`#cookie-popup-with-overlay`, a genuine
 * `position: fixed` direct child of `<body>`) does trigger it for real, and
 * is not covered by any shipped rule - confirmed the same way.
 *
 * Uses the English site (/gb/en) rather than /it/it: the store listing is
 * English, so an Italian background behind an English popup would read as a
 * mistake. Confirmed live that /gb/en does NOT redirect to a local-language
 * URL (final page.url() stays /gb/en, document.documentElement.lang === 'en')
 * and the real suspected-banner heuristic still fires there.
 */
async function measureUnhandledSite(browser, measureSource, ruleset) {
  const url = 'https://www.ryanair.com/gb/en';
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    locale: 'en-GB',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await injectMeasureBundle(page, measureSource);

  const state = await pollUntil(async () => {
    const detected = await page.evaluate((rs) => window.__crMeasure.detect(rs), ruleset);
    if (detected) return { covered: true };
    const suspected = await page.evaluate(() => window.__crMeasure.suspected());
    return suspected ? { covered: false, suspected: true } : null;
  });

  if (!state || state.covered) {
    throw new Error(`${url} did not show an unhandled-suspicious banner within ${DETECT_MAX_MS}ms - pick a different site and update the brief.`);
  }

  const domain = await page.evaluate(() => location.hostname);

  const bgPath = join(OUT_DIR, '_tmp-ryanair-bg.png');
  await page.screenshot({ path: bgPath });

  console.log(`[measure] ${url} -> no known CMP matched, real "suspected unhandled banner" heuristic (src/engine/content.js's) fired. domain=${domain}`);

  await context.close();

  return {
    bgPath,
    outcome: {
      status: OUTCOME_STATUS.SUSPECTED_UNHANDLED,
      domain,
      cmpId: null,
    },
  };
}

async function injectMeasureBundle(page, measureSource) {
  await page.evaluate((src) => {
    if (window.__crMeasure) return;
    const script = document.createElement('script');
    script.textContent = src;
    document.documentElement.appendChild(script);
    script.remove();
  }, measureSource);
}

// ---------------------------------------------------------------------------
// Real popup rendering.
// ---------------------------------------------------------------------------

/**
 * Loads the real, unmodified dist/ui/popup.html + popup.js against a stubbed
 * `browser` global carrying `outcome` as the tab's recorded state, waits for
 * the popup to reach the expected data-state, optionally opens the report
 * panel, then screenshots exactly the popup element (its real rendered size,
 * no page chrome).
 */
async function capturePopup(browser, { outcome, expectedState, openReport, popupWidth, manifestVersion, messages, outPath }) {
  const context = await browser.newContext({
    viewport: { width: popupWidth, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const page = await context.newPage();

  await page.addInitScript(installBrowserStub, {
    messages,
    manifestVersion,
    tabState: outcome,
    getTabStateMessageType: MESSAGE_GET_TAB_STATE,
  });

  const popupUrl = pathToFileURL(join(DIST_UI_DIR, 'popup.html')).href;
  await page.goto(popupUrl);

  await page.waitForFunction((state) => {
    const root = document.querySelector('[data-root]');
    return root && root.getAttribute('data-state') === state;
  }, expectedState, { timeout: 10_000 });

  let reportPayloadText = null;
  if (openReport) {
    await page.locator('[data-action="open-report"]').click();
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-field="reportPanel"]');
      return panel && !panel.hidden;
    }, undefined, { timeout: 10_000 });
    reportPayloadText = await page.locator('[data-field="reportPayload"]').innerText();
  }

  // Let the final paint settle (webfonts/system fonts, layout) before capture.
  await page.waitForTimeout(150);

  await page.locator('[data-root]').screenshot({ path: outPath });
  await context.close();

  return { reportPayloadText };
}

// ---------------------------------------------------------------------------
// Compositing: popup image over background image, no external image libs.
// ---------------------------------------------------------------------------

async function composite(browser, { bgPath, popupPath, popupWidth, outPath }) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const page = await context.newPage();

  // Data URIs rather than file:// URLs: a page loaded via setContent() has an
  // opaque `about:blank` origin, and Chromium blocks that origin from loading
  // local file:// resources (broken-image icons instead of the actual PNGs) -
  // embedding the bytes directly sidesteps that origin check entirely.
  const bgUrl = `data:image/png;base64,${readFileSync(bgPath).toString('base64')}`;
  const popupUrl = `data:image/png;base64,${readFileSync(popupPath).toString('base64')}`;

  // A `filter: drop-shadow()` on the <img> itself rendered as essentially
  // invisible once actually screenshotted (checked on the real pixels, not
  // assumed). A separate wrapper element with a plain `box-shadow` - the
  // fallback the brief itself calls out - renders reliably instead: a wide,
  // soft shadow plus a thin low-opacity border to read as "floating" above
  // both light and dark backgrounds. Its farthest-reaching layer is offset
  // 6px + blurred 20px = 26px past the card edge, matching
  // SHADOW_MAX_REACH_PX above, so it stays inside POPUP_MARGIN with room to
  // spare instead of bleeding out to the frame edge.
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  .bg { position: absolute; top: 0; left: 0; width: ${WIDTH}px; height: ${HEIGHT}px; object-fit: cover; }
  .popup-frame {
    position: absolute;
    top: ${POPUP_MARGIN}px;
    right: ${POPUP_MARGIN}px;
    width: ${popupWidth}px;
    line-height: 0;
    border: 1px solid rgba(0, 0, 0, 0.14);
    box-shadow:
      0 2px 6px rgba(0, 0, 0, 0.20),
      0 6px 20px rgba(0, 0, 0, 0.32);
  }
  .popup-frame img { display: block; width: 100%; }
</style>
</head>
<body>
  <img class="bg" src="${bgUrl}">
  <div class="popup-frame"><img src="${popupUrl}"></div>
</body>
</html>`;

  await page.setContent(html);
  // Ensure both images fully decoded before capturing.
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  await page.waitForTimeout(100);

  await page.screenshot({ path: outPath });
  await context.close();
}

// ---------------------------------------------------------------------------
// Margin verification: reads the ACTUAL composited PNG pixels back (not the
// CSS that produced them) and confirms real background shows on all four
// sides of the popup card, by comparing sampled points against the very same
// coordinates in the original background screenshot - if a point in the
// final image still matches the untouched background exactly, nothing is
// covering it there, regardless of what color that background happens to be.
// ---------------------------------------------------------------------------

async function verifyMargins(browser, { label, finalPath, bgPath, popupWidth, popupHeight }) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const finalB64 = readFileSync(finalPath).toString('base64');
  const bgB64 = readFileSync(bgPath).toString('base64');

  const result = await page.evaluate(async ({ finalB64, bgB64, WIDTH, HEIGHT, POPUP_MARGIN, SHADOW_MAX_REACH_PX, popupWidth, popupHeight }) => {
    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }
    const finalImg = await loadImage(`data:image/png;base64,${finalB64}`);
    const bgImg = await loadImage(`data:image/png;base64,${bgB64}`);

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = WIDTH;
    finalCanvas.height = HEIGHT;
    finalCanvas.getContext('2d').drawImage(finalImg, 0, 0);
    const finalCtx = finalCanvas.getContext('2d');

    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = WIDTH;
    bgCanvas.height = HEIGHT;
    bgCanvas.getContext('2d').drawImage(bgImg, 0, 0);
    const bgCtx = bgCanvas.getContext('2d');

    const colorAt = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    const closeEnough = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

    const popupLeft = WIDTH - POPUP_MARGIN - popupWidth;
    const popupTop = POPUP_MARGIN;
    const centerX = popupLeft + Math.floor(popupWidth / 2);
    const centerY = popupTop + Math.floor(popupHeight / 2);

    // Top/right: sample close to the FRAME edge, not the card edge - close
    // to the card edge is legitimately inside the shadow's soft falloff
    // (SHADOW_MAX_REACH_PX), which is the point of adding a visible shadow
    // at all. POPUP_MARGIN was sized so this offset is still comfortably
    // outside that falloff.
    const edgeOffset = Math.min(6, Math.max(1, POPUP_MARGIN - SHADOW_MAX_REACH_PX - 4));
    // Left/bottom: no shadow-falloff concern near the frame (the card isn't
    // anchored to those edges), so instead confirm real open background well
    // past the shadow's reach off the card itself.
    const clearOfShadow = SHADOW_MAX_REACH_PX + 24;

    const samples = {
      top: { x: centerX, y: edgeOffset },
      right: { x: WIDTH - edgeOffset, y: centerY },
      left: { x: Math.max(1, popupLeft - clearOfShadow), y: centerY },
      bottom: { x: centerX, y: Math.min(HEIGHT - 1, popupTop + popupHeight + clearOfShadow) },
    };

    const checks = {};
    for (const [side, point] of Object.entries(samples)) {
      const finalColor = colorAt(finalCtx, point.x, point.y);
      const bgColor = colorAt(bgCtx, point.x, point.y);
      checks[side] = { point, finalColor, bgColor, showsBackground: closeEnough(finalColor, bgColor, 8) };
    }

    // Sanity: a point just inside the card's top edge (before any text/icon)
    // must be the popup's flat white background, proving the popup is really
    // drawn there and this isn't a false pass from an all-white page.
    const insidePoint = { x: centerX, y: popupTop + 4 };
    const insideColor = colorAt(finalCtx, insidePoint.x, insidePoint.y);
    const insideIsPopupWhite = insideColor.every((v) => v >= 245);

    return { checks, insidePoint, insideColor, insideIsPopupWhite };
  }, { finalB64, bgB64, WIDTH, HEIGHT, POPUP_MARGIN, SHADOW_MAX_REACH_PX, popupWidth, popupHeight });

  await context.close();

  console.log(`[margins] ${label}:`);
  for (const [side, check] of Object.entries(result.checks)) {
    console.log(`  ${side.padEnd(6)} @ (${check.point.x},${check.point.y}) final=${JSON.stringify(check.finalColor)} bg=${JSON.stringify(check.bgColor)} -> ${check.showsBackground ? 'background visible (OK)' : 'MISMATCH - something is covering this point'}`);
  }
  console.log(`  inside @ (${result.insidePoint.x},${result.insidePoint.y}) color=${JSON.stringify(result.insideColor)} -> ${result.insideIsPopupWhite ? 'popup card confirmed present (OK)' : 'NOT the popup\'s white - card missing/misplaced'}`);

  const failed = Object.entries(result.checks).filter(([, c]) => !c.showsBackground).map(([side]) => side);
  if (failed.length > 0) {
    throw new Error(`${label}: background is not visible on side(s) [${failed.join(', ')}] of the popup - margin is not actually there in the produced PNG.`);
  }
  if (!result.insideIsPopupWhite) {
    throw new Error(`${label}: the popup card was not found where expected in the produced PNG.`);
  }
}

// ---------------------------------------------------------------------------
// PNG dimension check (reads the IHDR chunk directly - no dependency needed).
// ---------------------------------------------------------------------------

function readPngDimensions(path) {
  const fd = readFileSync(path);
  // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) => width/height at offset 16.
  const width = fd.readUInt32BE(16);
  const height = fd.readUInt32BE(20);
  return { width, height };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('Building the extension (node build.mjs) so dist/ reflects the current source...');
  ensureFreshBuild();

  const manifest = loadManifest();
  const messages = loadLocaleMessages();
  const ruleset = loadShippedRuleset();
  const popupWidth = readPopupWidthPx();
  const measureSource = await buildMeasureBundle();

  console.log(`Popup width read from src/ui/popup.css: ${popupWidth}px.`);
  console.log(`Extension version read from manifest.json: ${manifest.version}.`);

  const browser = await chromium.launch({ headless: true });
  const tempPaths = [];

  try {
    console.log('\n== Screenshot 1: refused (otto.de, OneTrust - see measureRefusedSite() for why accenture.com, the brief\'s original pick, was dropped) ==');
    const refused = await measureRefusedSite(browser, measureSource, ruleset);
    tempPaths.push(refused.bgPath);
    console.log('[language] otto.de has no English version (German-market-only retailer, lang="de", no locale switcher) - declared here rather than forced into an English URL that does not exist.');

    console.log('\n== Screenshot 2/3: unhandled (ryanair.com/gb/en - see measureUnhandledSite() for why mediaworld.it, suggested by the brief, was not usable) ==');
    const unhandled = await measureUnhandledSite(browser, measureSource, ruleset);
    tempPaths.push(unhandled.bgPath);

    const refusedPopupPath = join(OUT_DIR, '_tmp-popup-refused.png');
    const unhandledPopupPath = join(OUT_DIR, '_tmp-popup-unhandled.png');
    const reportPopupPath = join(OUT_DIR, '_tmp-popup-report.png');
    tempPaths.push(refusedPopupPath, unhandledPopupPath, reportPopupPath);

    await capturePopup(browser, {
      outcome: refused.outcome,
      expectedState: 'refused',
      openReport: false,
      popupWidth,
      manifestVersion: manifest.version,
      messages,
      outPath: refusedPopupPath,
    });

    await capturePopup(browser, {
      outcome: unhandled.outcome,
      expectedState: 'suspected',
      openReport: false,
      popupWidth,
      manifestVersion: manifest.version,
      messages,
      outPath: unhandledPopupPath,
    });

    const { reportPayloadText } = await capturePopup(browser, {
      outcome: unhandled.outcome,
      expectedState: 'suspected',
      openReport: true,
      popupWidth,
      manifestVersion: manifest.version,
      messages,
      outPath: reportPopupPath,
    });

    console.log(`\n[report preview] exact text rendered by the real src/ui/report.js:\n${reportPayloadText}`);

    const out1 = join(OUT_DIR, '01-refused.png');
    const out2 = join(OUT_DIR, '02-unhandled.png');
    const out3 = join(OUT_DIR, '03-report-preview.png');

    await composite(browser, { bgPath: refused.bgPath, popupPath: refusedPopupPath, popupWidth, outPath: out1 });
    await composite(browser, { bgPath: unhandled.bgPath, popupPath: unhandledPopupPath, popupWidth, outPath: out2 });
    await composite(browser, { bgPath: unhandled.bgPath, popupPath: reportPopupPath, popupWidth, outPath: out3 });

    console.log('\n== Verifying final dimensions ==');
    for (const path of [out1, out2, out3]) {
      const { width, height } = readPngDimensions(path);
      const ok = width === WIDTH && height === HEIGHT;
      console.log(`${path}: ${width}x${height} ${ok ? 'OK' : 'MISMATCH'}`);
      if (!ok) throw new Error(`${path} is ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
    }

    console.log('\n== Verifying popup margins on the actual pixels (not the CSS) ==');
    await verifyMargins(browser, {
      label: '01-refused.png',
      finalPath: out1,
      bgPath: refused.bgPath,
      popupWidth,
      popupHeight: readPngDimensions(refusedPopupPath).height,
    });
    await verifyMargins(browser, {
      label: '02-unhandled.png',
      finalPath: out2,
      bgPath: unhandled.bgPath,
      popupWidth,
      popupHeight: readPngDimensions(unhandledPopupPath).height,
    });
    await verifyMargins(browser, {
      label: '03-report-preview.png',
      finalPath: out3,
      bgPath: unhandled.bgPath,
      popupWidth,
      popupHeight: readPngDimensions(reportPopupPath).height,
    });

    console.log('\nDone. Store screenshots written to verification/store/.');
  } finally {
    await browser.close();
    for (const path of tempPaths) {
      rmSync(path, { force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
