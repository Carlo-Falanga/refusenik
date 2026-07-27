/**
 * Selector resolution engine.
 *
 * Resolves the declarative `Selector` objects defined in the rule schema
 * (see docs/ARCHITETTURA.md) against the live DOM of an arbitrary,
 * untrusted third-party page. Every exported function is defensive by
 * contract: it must NEVER throw, and must NEVER break the host page.
 * Failure to resolve always yields `null` / an empty array, never an
 * exception.
 *
 * Selector shape:
 * {
 *   css: string,                          // required target selector
 *   shadowPath?: string[],                // host selectors to traverse via .shadowRoot, in order
 *   frame?: string,                       // selector of an iframe to search inside
 *   textMatch?: string,                   // text the matched element(s) must contain/equal
 *   textMatchMode?: 'contains' | 'exact',  // comparison mode for textMatch (default: 'contains')
 * }
 */

/** Collapses whitespace and lower-cases text for tolerant, locale-agnostic comparison. */
function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Walks `frame` and `shadowPath` (in that order) starting from `root`,
 * returning the deepest reachable search context plus every intermediate
 * root that was actually reached. Any failure along the way (missing
 * iframe, inaccessible cross-origin iframe, missing shadow host, host
 * without an attached shadow root) stops the walk cleanly: `finalRoot` is
 * `null` but `chain` still lists whatever was reached, which callers (e.g.
 * a MutationObserver-based waiter) can use to watch for the rest of the
 * path appearing later.
 */
export function resolveSelectorChain(selector, root) {
  const chain = [root];
  if (!selector || !root) return { finalRoot: null, chain };

  let current = root;

  if (selector.frame) {
    let iframeEl = null;
    try {
      iframeEl = current.querySelector(selector.frame);
    } catch {
      return { finalRoot: null, chain };
    }
    if (!iframeEl) return { finalRoot: null, chain };

    let frameDocument = null;
    try {
      // Cross-origin iframes: browsers either return null or throw a
      // SecurityError depending on engine/timing. Both are treated the
      // same way - a clean, silent failure to resolve.
      frameDocument = iframeEl.contentDocument
        || (iframeEl.contentWindow && iframeEl.contentWindow.document)
        || null;
    } catch {
      frameDocument = null;
    }
    if (!frameDocument) return { finalRoot: null, chain };

    current = frameDocument;
    chain.push(current);
  }

  if (Array.isArray(selector.shadowPath)) {
    for (const hostSelector of selector.shadowPath) {
      let hostEl = null;
      try {
        hostEl = current.querySelector(hostSelector);
      } catch {
        return { finalRoot: null, chain };
      }
      if (!hostEl || !hostEl.shadowRoot) return { finalRoot: null, chain };

      current = hostEl.shadowRoot;
      chain.push(current);
    }
  }

  return { finalRoot: current, chain };
}

function matchesText(el, selector) {
  if (!selector.textMatch) return true;

  const mode = selector.textMatchMode || 'contains';
  const normalizedContent = normalizeText(el.textContent);
  const normalizedPattern = normalizeText(selector.textMatch);

  if (mode === 'contains') return normalizedContent.includes(normalizedPattern);
  if (mode === 'exact') return normalizedContent === normalizedPattern;

  // Unknown/unsupported mode: fail closed rather than guessing at semantics
  // that aren't defined by the schema (see report to orchestrator).
  return false;
}

/**
 * Resolves every element matching `selector` under `root` (default:
 * document). Returns an empty array on any failure - invalid selector,
 * unreachable shadow/frame path, invalid CSS - never throws.
 */
export function resolveAllSelector(selector, root = (typeof document !== 'undefined' ? document : null)) {
  try {
    if (!selector || typeof selector !== 'object') return [];
    if (typeof selector.css !== 'string' || selector.css.length === 0) return [];
    if (!root) return [];

    const { finalRoot } = resolveSelectorChain(selector, root);
    if (!finalRoot) return [];

    let nodeList;
    try {
      nodeList = finalRoot.querySelectorAll(selector.css);
    } catch {
      // Malformed CSS in a remote ruleset must not crash the engine.
      return [];
    }

    const candidates = Array.from(nodeList);
    if (!selector.textMatch) return candidates;
    return candidates.filter((el) => matchesText(el, selector));
  } catch {
    return [];
  }
}

/**
 * Resolves the first element matching `selector` under `root`, or `null`.
 * Never throws.
 */
export function resolveSelector(selector, root) {
  try {
    const matches = resolveAllSelector(selector, root);
    return matches.length > 0 ? matches[0] : null;
  } catch {
    return null;
  }
}

/** Convenience boolean check, used for `ifExists` guards and `detect`. */
export function selectorExists(selector, root) {
  return resolveSelector(selector, root) !== null;
}
