/**
 * CMP detection: given a ruleset, finds which CMP (if any) matches the
 * current page. All `detect` selectors of a CMP must resolve for that CMP
 * to be considered matched; among matched CMPs, the one with the highest
 * `priority` wins.
 */

import { resolveSelector } from './selector.js';

function cmpMatches(cmp, root) {
  if (!cmp || !Array.isArray(cmp.detect) || cmp.detect.length === 0) {
    // A CMP with no detect selectors would vacuously "match" every page
    // under strict boolean logic. That is unsafe (a malformed/empty entry
    // could hijack every site), so it is treated defensively as no match.
    return false;
  }

  return cmp.detect.every((selector) => {
    try {
      return resolveSelector(selector, root) !== null;
    } catch {
      return false;
    }
  });
}

/**
 * Returns the matched CMP entry with the highest priority, or `null` if no
 * CMP in the ruleset matches the current DOM. Never throws.
 */
export function detectCMP(ruleset, root = (typeof document !== 'undefined' ? document : null)) {
  try {
    if (!ruleset || !Array.isArray(ruleset.cmps) || !root) return null;

    const matched = ruleset.cmps.filter((cmp) => cmpMatches(cmp, root));
    if (matched.length === 0) return null;

    matched.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
    return matched[0];
  } catch {
    return null;
  }
}
