/**
 * Content script orchestration.
 *
 * Registered with `all_frames: true` (manifest.json), because some CMPs
 * (e.g. legacy TrustArc) render their UI inside a cross-origin iframe that a
 * main-frame-only content script could never reach. Runs at document_idle in
 * every frame, then:
 *  1. Tries to detect and handle a known CMP immediately.
 *  2. If none matched, observes the DOM for late-loading CMPs (many surface
 *     1-3s after load) via MutationObserver, bounded by a time window.
 *  3. If nothing ever matches AND this is the top-level frame, runs a
 *     conservative heuristic to flag a *suspected* (but unhandled) consent
 *     banner - purely informational, used by the popup's "report" button.
 *     The engine never acts on a heuristic match: uncertainty means we
 *     don't touch the page. This step is deliberately skipped inside
 *     sub-frames: an ad/tracking iframe full of consent-sounding text would
 *     otherwise be flagged as a phantom banner on every such frame.
 *  4. Reports the local outcome to the extension's background/runtime
 *     (in-browser only - this is not telemetry to any server; see the
 *     privacy constraints in docs/ARCHITETTURA.md, which govern the actual
 *     opt-in reporting feature owned by the UI).
 *
 * The ruleset itself is never fetched here: the background script owns it
 * (src/engine/background.js, src/engine/ruleset.js) and this content script
 * only ever asks for the currently active one over `runtime.sendMessage`.
 */

import { detectCMP } from './detect.js';
import { runFlow } from './steps.js';
import { sendRuntimeMessage } from './browser-api.js';
import { MESSAGE_GET_RULESET, MESSAGE_OUTCOME, OUTCOME_STATUS } from './messages.js';

// Most CMPs surface within 1-3s; this window keeps a generous margin while
// still bounding the observer's lifetime on pages where nothing ever appears.
const LATE_CMP_OBSERVE_WINDOW_MS = 20000;

// Well-formed, empty fallback used only if the background cannot be reached
// at all (e.g. transient extension reload). Never "no rules" in a way that
// would throw - just nothing to detect for this one page load.
const EMPTY_RULESET = { schemaVersion: 1, generatedAt: new Date(0).toISOString(), rulesetVersion: 0, cmps: [] };

/** True unless this script runs inside a sub-frame; see the module doc comment, point 3. */
function isTopFrame() {
  try {
    return window.top === window;
  } catch {
    // Cross-origin access to `window.top` does not throw in current
    // engines, but fail safe (treat as a sub-frame, i.e. suppress the
    // heuristic) if that were ever to change.
    return false;
  }
}

async function requestActiveRuleset() {
  try {
    const ruleset = await sendRuntimeMessage({ type: MESSAGE_GET_RULESET });
    return ruleset && Array.isArray(ruleset.cmps) ? ruleset : EMPTY_RULESET;
  } catch {
    return EMPTY_RULESET;
  }
}

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
    await sendRuntimeMessage({ type: MESSAGE_OUTCOME, ...payload });
  } catch {
    /* Reporting must never break the host page. */
  }
}

async function tryHandleCMP(ruleset) {
  const cmp = detectCMP(ruleset, document);
  if (!cmp) return false;

  // Timed and counted purely for the popup's own display (docs/ARCHITETTURA.md
  // does not cover the UI). This is separate from - and much more detailed
  // than - the opt-in problem report, which never leaves this browser
  // instance's own local outcome map without an explicit click.
  const startedAt = Date.now();
  const results = await runFlow(cmp.flow, document);
  const durationMs = Date.now() - startedAt;
  const failedStepCount = results.filter((result) => !result.ok && !result.skipped && !result.ignored).length;

  await reportOutcome({
    domain: currentDomain(),
    cmpId: cmp.id,
    cmpName: cmp.name,
    status: failedStepCount > 0 ? OUTCOME_STATUS.FAILED : OUTCOME_STATUS.HANDLED,
    stepCount: results.length,
    failedStepCount,
    durationMs,
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
  await reportOutcome({ domain: currentDomain(), cmpId: null, status: OUTCOME_STATUS.SUSPECTED_UNHANDLED });
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
    if (isTopFrame()) {
      await reportSuspiciousBannerIfAny();
    }
  }, LATE_CMP_OBSERVE_WINDOW_MS);
}

/** Entry point invoked once per page load (in every frame, per `all_frames: true`). Never throws into the host page. */
export async function runContentScript() {
  try {
    const ruleset = await requestActiveRuleset();
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
