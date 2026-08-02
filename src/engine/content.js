/**
 * Content script orchestration.
 *
 * Registered with `all_frames: true` (manifest.json), because some CMPs
 * (e.g. legacy TrustArc) render their UI inside a cross-origin iframe that a
 * main-frame-only content script could never reach. Runs at document_idle in
 * every frame, then:
 *  1. Tries to detect and handle a known CMP immediately. A matched CMP is
 *     only actually refused if its `kind` authorizes it (see
 *     isActionableKind() in detect.js) - a "consentOrPay" wall is recognised
 *     and reported, never acted on, and any `kind` this engine version does
 *     not understand fails closed the same way (see NOTE.md, "consent-or-pay
 *     walls").
 *  2. If none matched, observes the DOM for late-loading CMPs (many surface
 *     1-3s after load) via MutationObserver, bounded by a time window.
 *  3. If nothing ever matches AND this is the top-level frame, runs a
 *     conservative heuristic to flag a *suspected* (but unhandled) consent
 *     banner - purely informational, used by the popup's "report" button.
 *     The engine never acts on a heuristic match: uncertainty means we
 *     don't touch the page. This step is deliberately skipped inside
 *     sub-frames: an ad/tracking iframe full of consent-sounding text would
 *     otherwise be flagged as a phantom banner on every such frame.
 *     Right after it, in that same top-frame-only branch, the generic
 *     rejection engine (src/engine/generic.js) gets one attempt at the same
 *     unhandled banner - see that module's doc for its own, much stricter,
 *     abstain-by-default pipeline. Its runtime mode (propose-only vs. act)
 *     is resolved inside generic.js itself, not here.
 *  4. Reports the local outcome to the extension's background/runtime
 *     (in-browser only - this is not telemetry to any server; see the
 *     privacy constraints in docs/ARCHITETTURA.md, which govern the actual
 *     opt-in reporting feature owned by the UI).
 *
 * The ruleset itself is never fetched here: the background script owns it
 * (src/engine/background.js, src/engine/ruleset.js) and this content script
 * only ever asks for the currently active one over `runtime.sendMessage`.
 */

import { detectCMP, isActionableKind } from './detect.js';
import { runFlow } from './steps.js';
import { sendRuntimeMessage } from './browser-api.js';
import { MESSAGE_GET_RULESET, MESSAGE_OUTCOME, OUTCOME_STATUS, CMP_KIND } from './messages.js';
import { findSuspiciousBanners } from './suspect.js';
import { runGenericEngine } from './generic.js';

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

// This frame's own hostname - in a sub-frame (a CMP rendered in a
// cross-origin iframe: Sourcepoint/TrustArc/BigID all do this in the wild),
// that is the CMP's host, not the page the user is visiting. It is sent as
// `domain` in every outcome below purely as a fallback: the background
// (src/engine/background.js's domainFromSenderTab()) resolves the actual
// top-level page from `sender.tab.url` whenever it can, and only falls back
// to this value if that lookup fails (e.g. the `<all_urls>` host permission
// was revoked for this tab). Deliberately not `window.top.location.hostname`
// - that throws in a cross-origin sub-frame, and even when it doesn't throw
// it would still be wrong in the one context (background) that actually
// needs to be told, since `window`/`top` don't exist there at all.
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

  if (!isActionableKind(cmp.kind)) {
    if (cmp.kind === CMP_KIND.CONSENT_OR_PAY) {
      // Recognition only (docs/ARCHITETTURA.md, src/rules/NOTE.md "consent-or
      // -pay walls"): this site offers no refusal, only tracking consent or a
      // paid subscription. Clicking the only available control would mean
      // consenting - the opposite of this extension's purpose - so the only
      // correct action is to say so and stop. No flow is ever run.
      await reportOutcome({
        domain: currentDomain(),
        cmpId: cmp.id,
        cmpName: cmp.name,
        status: OUTCOME_STATUS.CONSENT_OR_PAY,
      });
      return true;
    }

    // Fail-closed: a `kind` this engine version does not recognise (a
    // ruleset newer than the engine) never authorizes running a flow, and is
    // never treated as "refuse". Reported the same as no match at all, so a
    // later heuristic pass can still flag the page as an unhandled banner.
    return false;
  }

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

// The actual heuristic (shadow-DOM-aware, bounded, scored) lives in
// suspect.js and is shared with tools/probe-entry.js so the two can never
// diverge - see that module's doc comment for the full rationale.
function findSuspiciousBanner() {
  try {
    const [first] = findSuspiciousBanners(document.body || document);
    return first || null;
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

/**
 * One attempt at the generic rejection engine (src/engine/generic.js), right
 * after the suspected-banner report above and under the exact same gates
 * (top frame only, only once the late-CMP window has fully elapsed). Its
 * result is not yet wired into the outcome-reporting message above - see
 * generic.js's own doc, step 7, for how its (currently propose-by-default)
 * output is meant to be inspected instead. Never throws into the host page.
 *
 * KNOWN OPEN POINT, left deliberately unaddressed for now: even on a run
 * where `runGenericEngine` resolves to `mode: 'act'` and actually clicks
 * (and verifies) a refusal, the call above to `reportOutcome()` a few lines
 * up still reports `OUTCOME_STATUS.SUSPECTED_UNHANDLED` for this same page
 * load - the two calls do not currently talk to each other, so the popup
 * would show "unhandled" on a page this module just successfully refused.
 * Left as-is because: (1) the runtime default is `'propose'`, under which
 * nothing is ever clicked, so this cannot yet misreport a real outcome to a
 * real user; (2) fixing it (a new/adjusted OUTCOME_STATUS, threaded through
 * messages.js/background.js/the popup) is exactly the kind of surface this
 * module's own validation work (step 7) needs to inform first - reporting
 * "handled" before that validation is trusted would be worse than
 * reporting "unhandled" too conservatively. Revisit together with that
 * validation pass, not before.
 */
async function runGenericRejectionIfAny() {
  try {
    await runGenericEngine(document.body || document);
  } catch {
    /* Must never break the host page. */
  }
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
      await runGenericRejectionIfAny();
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
