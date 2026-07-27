/**
 * Content script orchestration.
 *
 * Runs at document_idle (per manifest configuration - outside this task's
 * scope), then:
 *  1. Tries to detect and handle a known CMP immediately.
 *  2. If none matched, observes the DOM for late-loading CMPs (many surface
 *     1-3s after load) via MutationObserver, bounded by a time window.
 *  3. If nothing ever matches, runs a conservative heuristic to flag a
 *     *suspected* (but unhandled) consent banner - purely informational,
 *     used by the popup's "report" button. The engine never acts on a
 *     heuristic match: uncertainty means we don't touch the page.
 *  4. Reports the local outcome to the extension's background/runtime
 *     (in-browser only - this is not telemetry to any server; see the
 *     privacy constraints in docs/ARCHITETTURA.md, which govern the actual
 *     opt-in reporting feature owned by the UI).
 */

import { getActiveRuleset, maybeRefreshRuleset } from './ruleset.js';
import { detectCMP } from './detect.js';
import { runFlow } from './steps.js';
import { sendRuntimeMessage } from './browser-api.js';

// Most CMPs surface within 1-3s; this window keeps a generous margin while
// still bounding the observer's lifetime on pages where nothing ever appears.
const LATE_CMP_OBSERVE_WINDOW_MS = 20000;

const HEURISTIC_MIN_Z_INDEX = 999;

// Best-effort, multi-language cue words for the "suspected banner" heuristic.
// This does not drive any action - only the report-button state.
const CONSENT_TERMS = [
  'cookie', 'cookies', 'consent', 'privacy choices',
  'rifiuta', 'accetta', 'consenso', 'cookie policy',
  'ablehnen', 'zustimmen', 'einwilligung',
  'accepter', 'refuser', 'consentement',
  'rechazar', 'aceptar', 'consentimiento',
];

function currentDomain() {
  try {
    return window.location.hostname;
  } catch {
    return '';
  }
}

async function reportOutcome(payload) {
  try {
    await sendRuntimeMessage({ type: 'cookieRefuser:outcome', ...payload });
  } catch {
    /* Reporting must never break the host page. */
  }
}

async function tryHandleCMP(ruleset) {
  const cmp = detectCMP(ruleset, document);
  if (!cmp) return false;

  const results = await runFlow(cmp.flow, document);
  const failed = results.some((result) => !result.ok && !result.skipped && !result.ignored);

  await reportOutcome({
    domain: currentDomain(),
    cmpId: cmp.id,
    status: failed ? 'failed' : 'handled',
  });

  return true;
}

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
    // Bounded, shallow scan only - walking the full DOM of an arbitrary
    // third-party page is both slow and unnecessary for this heuristic.
    const candidates = document.body ? Array.from(document.body.children) : [];
    return candidates.find(isSuspiciousBanner) || null;
  } catch {
    return null;
  }
}

async function reportSuspiciousBannerIfAny() {
  const suspect = findSuspiciousBanner();
  if (!suspect) return;

  // Deliberate product decision (docs/ARCHITETTURA.md, point 4): an
  // unrecognised banner is never acted upon. Only state for the popup's
  // report button is surfaced.
  await reportOutcome({ domain: currentDomain(), cmpId: null, status: 'suspected-unhandled' });
}

function observeForLateCMP(ruleset) {
  let settled = false;
  let observer;

  const stop = () => {
    settled = true;
    try {
      observer.disconnect();
    } catch {
      /* ignore */
    }
  };

  observer = new MutationObserver(async () => {
    if (settled) return;
    const handled = await tryHandleCMP(ruleset);
    if (handled) stop();
  });

  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    return;
  }

  setTimeout(async () => {
    if (settled) return;
    stop();
    await reportSuspiciousBannerIfAny();
  }, LATE_CMP_OBSERVE_WINDOW_MS);
}

/** Entry point invoked once per page load. Never throws into the host page. */
export async function runContentScript() {
  try {
    const ruleset = await maybeRefreshRuleset().catch(() => getActiveRuleset());
    const handledImmediately = await tryHandleCMP(ruleset);
    if (!handledImmediately) {
      observeForLateCMP(ruleset);
    }
  } catch {
    /* The content script must never throw into the host page. */
  }
}

// Registered directly as the MV3 content script (document_idle). Guarded so
// importing this module in a non-DOM context (e.g. tooling) is inert.
if (typeof document !== 'undefined') {
  runContentScript();
}
