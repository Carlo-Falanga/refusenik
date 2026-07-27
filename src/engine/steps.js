/**
 * Step executor for the CLOSED action set defined in docs/ARCHITETTURA.md:
 * `waitFor`, `click`, `setCheckbox`, `setAriaToggle`, `hide`.
 *
 * Rules are pure data. This module never evaluates expressions, never
 * builds a Function from rule data, and never runs anything beyond the
 * hard-coded actions below. An action outside this set is simply
 * ignored - it is not interpreted through any other code path. Extending
 * the action set means shipping a new engine version, not making the
 * interpreter generic.
 *
 * Every step result is a plain object: { action, ok, skipped, ignored, reason?, error? }
 * so the caller (content.js) can log the outcome of each step, per the
 * architecture's "ogni step logga esito".
 */

import { resolveSelector, resolveAllSelector, resolveSelectorChain, selectorExists } from './selector.js';

const DEFAULT_WAIT_TIMEOUT_MS = 5000;

/**
 * Resolves the `window` that owns a given DOM node, so DOM constructors
 * (`MutationObserver`, `Event`, `MouseEvent`, `PointerEvent`, ...) are
 * looked up on the correct global realm. In a real extension content
 * script this is always the page's own `window` (same as the bare
 * identifier), but a node reached through an iframe or a test harness like
 * jsdom may belong to a different realm than the ambient global scope, so
 * bare identifiers cannot be relied upon.
 */
function ownerWindowOf(node) {
  try {
    if (!node) return typeof window !== 'undefined' ? window : undefined;
    if (node.defaultView) return node.defaultView; // node is a Document
    if (node.ownerDocument && node.ownerDocument.defaultView) return node.ownerDocument.defaultView; // Element/ShadowRoot
    if (node.host && node.host.ownerDocument && node.host.ownerDocument.defaultView) return node.host.ownerDocument.defaultView;
    return typeof window !== 'undefined' ? window : undefined;
  } catch {
    return typeof window !== 'undefined' ? window : undefined;
  }
}

/** Dispatches a single UI event on `el`, swallowing environments that lack the event constructor. */
function dispatch(el, type, { pointer } = {}) {
  try {
    const win = ownerWindowOf(el);
    if (!win) return;

    let event;
    if (pointer && typeof win.PointerEvent === 'function') {
      event = new win.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 });
    } else if (typeof win.MouseEvent === 'function') {
      event = new win.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 });
    } else {
      return;
    }
    el.dispatchEvent(event);
  } catch {
    /* A single dispatch failing (e.g. unsupported event type in this environment) must not abort the click. */
  }
}

/**
 * Simulates a realistic user click: pointerdown -> mousedown -> pointerup ->
 * mouseup -> click. Many consent buttons listen on pointerdown/mouseup
 * rather than (or in addition to) `click`, so a bare `el.click()` is not
 * always sufficient.
 */
function simulateClick(el) {
  if (!el) return false;
  try {
    if (typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* Focus is a best-effort nicety, not a requirement. */
      }
    }

    dispatch(el, 'pointerdown', { pointer: true });
    dispatch(el, 'mousedown', { pointer: false });
    dispatch(el, 'pointerup', { pointer: true });
    dispatch(el, 'mouseup', { pointer: false });

    if (typeof el.click === 'function') {
      el.click(); // fires the final synthetic `click` event itself
    } else {
      dispatch(el, 'click', { pointer: false });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the current on/off state of a non-native ARIA toggle (a `div`/`span`
 * with `role="checkbox"`/`role="switch"` and `aria-checked`, or a button-like
 * element using `aria-pressed`). `aria-checked` takes precedence when both
 * are present, since it is the attribute the two documented roles use.
 *
 * Returns `null` when neither attribute is present at all - there is nothing
 * to read, so the caller must fail rather than guess a state.
 */
function readAriaToggleState(el) {
  if (el.hasAttribute('aria-checked')) {
    return { attr: 'aria-checked', raw: el.getAttribute('aria-checked') };
  }
  if (el.hasAttribute('aria-pressed')) {
    return { attr: 'aria-pressed', raw: el.getAttribute('aria-pressed') };
  }
  return null;
}

/**
 * Parses an ARIA boolean state string. Only the literal `"true"`/`"false"`
 * values are meaningful. Anything else - missing, `"mixed"` (the valid
 * tri-state value for `aria-checked`), or any other stray value - is
 * unreadable and must be treated as ambiguous, never coerced into a guess.
 */
function parseAriaBooleanState(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/**
 * Waits for `selector` to appear under `root`, using a MutationObserver
 * (never polling). Because the target may live behind an iframe and/or a
 * shadow root that itself appears or is populated asynchronously, this
 * observes every root reached so far in the resolution chain, and adds new
 * observers as deeper roots become reachable. Resolves with the element, or
 * `null` once `timeoutMs` elapses.
 */
function waitForSelector(selector, timeoutMs, root) {
  return new Promise((resolve) => {
    let settled = false;
    const observers = [];
    const observedNodes = new Set();
    let timer = null;

    const cleanup = () => {
      for (const observer of observers) {
        try {
          observer.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (timer) clearTimeout(timer);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const observeNode = (node) => {
      if (!node || observedNodes.has(node)) return;
      try {
        const win = ownerWindowOf(node);
        if (!win || typeof win.MutationObserver !== 'function') return;
        const observer = new win.MutationObserver(check);
        observer.observe(node, { childList: true, subtree: true, attributes: true });
        observers.push(observer);
        observedNodes.add(node);
      } catch {
        /* Some nodes (e.g. certain synthetic roots) cannot be observed; skip. */
      }
    };

    function check() {
      if (settled) return;
      try {
        // Re-walk the chain on every mutation so newly-reached intermediate
        // roots (an iframe that just finished loading, a shadow root that
        // just attached) get their own observer too - mutations inside an
        // already-attached shadow root are invisible to an observer placed
        // only on the light DOM.
        const { chain, finalRoot } = resolveSelectorChain(selector, root);
        for (const node of chain) observeNode(node);
        if (finalRoot) observeNode(finalRoot);

        const found = resolveSelector(selector, root);
        if (found) finish(found);
      } catch {
        /* A single failed check must not abort the wait; the timeout still applies. */
      }
    }

    check();
    if (!settled) {
      const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
      timer = setTimeout(() => finish(null), effectiveTimeout);
    }
  });
}

async function runStep(step, root) {
  const action = step && typeof step === 'object' ? step.action : undefined;
  const base = { action, ok: false, skipped: false, ignored: false };

  try {
    if (!step || typeof step !== 'object' || typeof action !== 'string') {
      return { ...base, ignored: true, reason: 'invalid-step' };
    }

    if (step.ifExists && !selectorExists(step.ifExists, root)) {
      return { ...base, ok: true, skipped: true, reason: 'if-exists-not-met' };
    }

    switch (action) {
      case 'waitFor': {
        const found = await waitForSelector(step.selector, step.timeoutMs, root);
        return found ? { ...base, ok: true } : { ...base, ok: false, reason: 'timeout' };
      }

      case 'click': {
        const el = resolveSelector(step.selector, root);
        if (!el) return { ...base, ok: false, reason: 'not-found' };
        const clicked = simulateClick(el);
        return clicked ? { ...base, ok: true } : { ...base, ok: false, reason: 'click-failed' };
      }

      case 'setCheckbox': {
        const targets = step.all
          ? resolveAllSelector(step.selector, root)
          : (() => {
            const el = resolveSelector(step.selector, root);
            return el ? [el] : [];
          })();

        if (targets.length === 0) return { ...base, ok: false, reason: 'not-found' };

        const desired = Boolean(step.checked);
        let changedAny = false;
        for (const el of targets) {
          try {
            if (!('checked' in el)) continue;
            if (el.checked !== desired) {
              el.checked = desired;
              const win = ownerWindowOf(el);
              if (win && typeof win.Event === 'function') {
                el.dispatchEvent(new win.Event('input', { bubbles: true }));
                el.dispatchEvent(new win.Event('change', { bubbles: true }));
              }
            }
            changedAny = true;
          } catch {
            /* One bad target must not prevent the others from being set. */
          }
        }
        return changedAny ? { ...base, ok: true } : { ...base, ok: false, reason: 'no-checkbox-targets' };
      }

      case 'setAriaToggle': {
        // A native checkbox can be *set*. A non-native ARIA toggle can only
        // be *clicked*, and a click is an inversion: clicking a toggle that
        // is already in the desired state flips it to the opposite one -
        // silently turning a tracking category back on while the extension
        // reports it as refused. So, per element: read the current state,
        // click only if it disagrees with `checked`, then re-read and
        // require the post-click state to match. Never guess, never click
        // "just in case".
        const targets = step.all
          ? resolveAllSelector(step.selector, root)
          : (() => {
            const el = resolveSelector(step.selector, root);
            return el ? [el] : [];
          })();

        if (targets.length === 0) return { ...base, ok: false, reason: 'not-found' };

        const desired = Boolean(step.checked);
        let allTargetsOk = true;
        let failureReason = null;

        for (const el of targets) {
          try {
            const state = readAriaToggleState(el);
            if (!state) {
              allTargetsOk = false;
              failureReason = failureReason || 'aria-state-missing';
              continue;
            }

            const current = parseAriaBooleanState(state.raw);
            if (current === null) {
              // Absent-but-attribute-present-with-junk, or the legitimate
              // tri-state "mixed" value - both are unreadable for our
              // purposes. Fail closed rather than pick a side.
              allTargetsOk = false;
              failureReason = failureReason || 'aria-state-ambiguous';
              continue;
            }

            if (current === desired) {
              // Already correct: touching it would invert it. Leave it alone.
              continue;
            }

            simulateClick(el);

            const after = parseAriaBooleanState(el.getAttribute(state.attr));
            if (after !== desired) {
              allTargetsOk = false;
              failureReason = failureReason || 'aria-toggle-verify-failed';
            }
          } catch {
            // One bad target must not prevent the others from being checked,
            // but it must still count as a failure of the overall step - the
            // popup's "refused" claim must stay true for every target.
            allTargetsOk = false;
            failureReason = failureReason || 'exception';
          }
        }

        return allTargetsOk ? { ...base, ok: true } : { ...base, ok: false, reason: failureReason };
      }

      case 'hide': {
        // Last resort per architecture: only meaningful once refusal is
        // already registered by a preceding click step. The engine executes
        // whatever order the rule declares; enforcing "after refusal" is a
        // ruleset-authoring concern, not something this executor infers.
        const el = resolveSelector(step.selector, root);
        if (!el) return { ...base, ok: false, reason: 'not-found' };
        try {
          el.style.setProperty('display', 'none', 'important');
          return { ...base, ok: true };
        } catch {
          return { ...base, ok: false, reason: 'hide-failed' };
        }
      }

      default:
        // Closed action set: an unrecognised action is data we don't (yet)
        // understand. It is ignored outright - never executed through a
        // fallback/generic path.
        return { ...base, ok: false, ignored: true, reason: 'unknown-action' };
    }
  } catch (error) {
    return { ...base, ok: false, reason: 'exception', error: error && error.message };
  }
}

/**
 * Executes a `flow` (array of Steps) in sequence against `root`.
 *
 * - `optional: true` steps that fail do not stop the flow.
 * - Non-optional steps that fail stop the flow (subsequent steps are not run).
 * - `ifExists` guards are evaluated before the action; when not met the step
 *   is skipped (never counted as a failure, regardless of `optional`).
 * - Unknown actions are ignored and never stop the flow, regardless of
 *   `optional`, since ignoring is itself the safe/expected behaviour.
 *
 * Returns the array of per-step results, always - never throws.
 */
export async function runFlow(steps, root = (typeof document !== 'undefined' ? document : null)) {
  const results = [];
  if (!Array.isArray(steps)) return results;

  for (const step of steps) {
    let result;
    try {
      result = await runStep(step, root);
    } catch (error) {
      result = { action: step && step.action, ok: false, skipped: false, ignored: false, reason: 'exception', error: error && error.message };
    }
    results.push(result);

    const isFailure = !result.ok && !result.skipped && !result.ignored;
    const isOptional = Boolean(step && step.optional);
    if (isFailure && !isOptional) break;
  }

  return results;
}

// Exported for direct unit testing of individual steps.
export { runStep };
