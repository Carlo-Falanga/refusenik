/**
 * Probe bundle injected into a live page by tools/verify-rules.mjs.
 *
 * It deliberately imports the SHIPPED engine modules rather than
 * reimplementing selector resolution or detection. A verifier that reasons
 * about rules with its own logic would be checking something other than the
 * thing users run, and would happily pass rules the extension cannot execute.
 */

import { detectCMP } from '../src/engine/detect.js';
import { resolveSelector, resolveAllSelector } from '../src/engine/selector.js';
import { runFlow } from '../src/engine/steps.js';
import { findSuspiciousBanners, collectShadowAwareElements } from '../src/engine/suspect.js';

/** Reports which selectors of a CMP's flow currently resolve on this page. */
function probeFlow(cmp) {
  return cmp.flow.map((step, index) => {
    const target = step.selector ? resolveSelector(step.selector) : null;
    const guard = step.ifExists ? resolveSelector(step.ifExists) : null;
    const all = step.selector && step.all ? resolveAllSelector(step.selector).length : undefined;
    return {
      index,
      action: step.action,
      optional: Boolean(step.optional),
      css: step.selector ? step.selector.css : null,
      found: Boolean(target),
      matchCount: all,
      guardDeclared: Boolean(step.ifExists),
      guardFound: step.ifExists ? Boolean(guard) : undefined,
      // For ARIA toggles, the attribute actually present matters more than the
      // element being found: the engine refuses to click when it cannot read
      // state, so "found but unreadable" is a distinct and important outcome.
      ariaAttrs: target && step.action === 'setAriaToggle'
        ? {
          checked: target.getAttribute('aria-checked'),
          pressed: target.getAttribute('aria-pressed'),
          selected: target.getAttribute('aria-selected'),
        }
        : undefined,
    };
  });
}

/**
 * Fingerprints an unrecognised banner: the ids, classes and script hosts that
 * identify which platform rendered it.
 *
 * Coverage is now driven by what actually appears on real sites rather than by
 * a vendor list, so an unknown banner has to arrive already identified. Without
 * this every unknown is a manual investigation, and manual investigations do
 * not scale to the cadence this project competes on.
 */
function fingerprint() {
  const marker = /consent|cookie|cmp|gdpr|privacy|didomi|onetrust|cybot|osano|usercentrics|sourcepoint|sp_message|quantcast|trustarc|truste|dg-consent|bigid/i;
  // Reuses the same shadow-DOM-aware, bounded traversal the "suspected
  // banner" heuristic uses (src/engine/suspect.js) - a fingerprint gathered
  // any other way could see ids/classes/scripts the extension itself never
  // reaches (e.g. inside an open shadow root), which would fingerprint a
  // banner the engine cannot actually detect.
  const elements = collectShadowAwareElements(document);
  const ids = [...new Set(elements
    .filter((e) => e.id)
    .map((e) => e.id).filter((i) => marker.test(i)))].slice(0, 8);
  const classes = [...new Set(elements
    .filter((e) => e.className)
    .flatMap((e) => String(e.className || '').split(/\s+/))
    .filter((c) => marker.test(c)))].slice(0, 8);
  const scripts = [...new Set(elements
    .filter((e) => e.tagName === 'SCRIPT' && e.src)
    .map((s) => { try { return new URL(s.src).hostname; } catch { return ''; } })
    .filter((h) => marker.test(h) || /consent|cmp|privacy/i.test(h)))].slice(0, 6);
  // Does the page offer any refusal at all? Consent-or-pay walls do not, and
  // they are out of scope by decision - see src/rules/NOTE.md.
  const text = (document.body && document.body.innerText || '').slice(0, 6000);
  const offersRefusal = /reject|refuse|decline|rifiut|ablehn|refuser|rechaz|nur notwendige|only necessary|solo necessari/i.test(text);
  const offersPay = /subscribe|abonn|suscrib|abbonat|s'abonner|ad-free|senza pubblicit/i.test(text);
  return { ids, classes, scripts, offersRefusal, offersPay };
}

/**
 * Heuristic used by the extension itself for "there is a banner we don't
 * know" - see src/engine/suspect.js, imported directly rather than
 * reimplemented (this file's own doc comment above).
 */
function suspectedBanner() {
  return findSuspiciousBanners(document).length;
}

// --execute mode drives the real flow executor, not a stand-in for it.
window.__crRunFlow = (flow) => runFlow(flow);

window.__crProbe = {
  run(ruleset) {
    const cmp = detectCMP(ruleset);
    // Per-selector detect results for every CMP. Detection requires ALL of a
    // CMP's detect selectors to match, so a single stale one silently defeats
    // the others - which is exactly how cookiebot and didomi were failing while
    // their real markers were present. Without this breakdown each failure
    // needs a manual investigation to explain.
    const detectDetail = ruleset.cmps.map((c) => ({
      id: c.id,
      selectors: c.detect.map((s) => ({ css: s.css, found: Boolean(resolveSelector(s)) })),
    })).filter((c) => c.selectors.some((s) => s.found));
    return {
      detectDetail,
      cmpId: cmp ? cmp.id : null,
      cmpName: cmp ? cmp.name : null,
      steps: cmp ? probeFlow(cmp) : [],
      suspected: cmp ? 0 : suspectedBanner(),
      fingerprint: cmp ? undefined : fingerprint(),
    };
  },
};
