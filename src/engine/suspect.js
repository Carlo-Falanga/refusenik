/**
 * Shared "suspected banner" heuristic.
 *
 * Used in two places that must never disagree: the content script
 * (src/engine/content.js), which surfaces the popup's report button when a
 * page has an unrecognised consent banner, and the sweep verifier
 * (tools/probe-entry.js), which measures how well that same heuristic is
 * doing against real sites. If those two carried separate implementations,
 * a fix made to one would silently stop applying to the other - which is
 * exactly how this heuristic went stale enough to miss spiegel.de, bild.de,
 * usercentrics.com and dozens of other real banners. There is exactly one
 * implementation, imported by both.
 *
 * NEVER AN ACTION SOURCE. Every export here is read-only inspection of the
 * page: nothing in this module clicks, hides, or otherwise mutates any
 * element it looks at, and nothing here may be wired into a code path that
 * does. Its only consumer-facing effect is turning the popup's report
 * button on or off. A false positive here costs a wrongly-shown button; a
 * false positive that caused a click would cost user consent on a page the
 * engine does not actually understand, which is unacceptable. See
 * src/engine/content.js's module doc (point 3) and README.md ("Never break
 * a page").
 *
 * Shadow DOM. Several modern CMPs (Usercentrics among them) render their
 * banner inside a web component with an *open* shadow root, which
 * `document.querySelectorAll` and `.children` never enter. `
 * collectShadowAwareElements` below walks the light DOM and recurses into
 * `el.shadowRoot` wherever one is attached. Closed shadow roots are opaque
 * to script by design (that's the whole point of "closed") - `el.shadowRoot`
 * is simply `null`/absent for them, so they are skipped the same way a real
 * page visitor's browser would skip them: no error, no special case.
 *
 * Bounded traversal. Walking the *entire* DOM of an arbitrary third-party
 * page on every load is both slow and unnecessary - this runs in every
 * frame of every page the user visits, and any perceptible lag here is a
 * regression in its own right. The walk is bounded on two axes:
 *   - HEURISTIC_MAX_TRAVERSAL_DEPTH: real pages built with component
 *     frameworks (React/Vue/etc.) commonly wrap markup in 10-20 nested
 *     layout `div`s before reaching anything meaningful; 25 gives headroom
 *     for that without allowing unbounded/pathological nesting to run away.
 *   - HEURISTIC_MAX_TRAVERSAL_NODES: published DOM-size measurements put a
 *     typical page in the low thousands of elements, with larger app-shell
 *     pages reaching several thousand; 6000 covers that comfortably while
 *     still capping the worst case (a page with tens of thousands of
 *     nodes) to a fixed, small amount of work. The walk is breadth-first
 *     (a FIFO queue, not a stack) precisely so that this budget is spent on
 *     shallow, whole-page siblings - where a portal-style banner `div`
 *     appended after the main content typically lives - before it can be
 *     exhausted by recursing deep into one large unrelated subtree (e.g. a
 *     long article body).
 *   - `getComputedStyle` is never called during this walk. It is only ever
 *     called afterwards, on the small set of elements that already passed
 *     the tag-name prefilter (`isCandidateContainerTag`) - a handful of
 *     elements per page, not thousands.
 *
 * Scoring, not a strict AND chain. The previous heuristic required
 * `position: fixed|sticky` AND a numeric `z-index >= 999` AND matching
 * text, all at once - which real banners routinely fail on just one axis
 * (an `absolute`-positioned banner, a `z-index: auto` fixed container, a
 * z-index the site sets low because it doesn't stack against much). Each
 * signal below instead contributes points, and an element crosses
 * `HEURISTIC_SUSPICION_THRESHOLD` by accumulating "enough" of them rather
 * than needing all of them:
 *
 *   fixed/sticky position ......... +2      (POSITION_FIXED_STICKY)
 *   absolute position ............. +1      (POSITION_ABSOLUTE)
 *   z-index >= HEURISTIC_MIN_Z_INDEX +2     (ZINDEX_HIGH)
 *   z-index positive but lower .... +1      (ZINDEX_POSITIVE)
 *   size/placement typical of a
 *     banner - all 3 of: wide,
 *     banner-height, on-screen .... +2      (SIZE_ALL)
 *   size/placement - 2 of 3 ....... +1      (SIZE_MOSTLY)
 *   >= 2 interactive elements
 *     inside (buttons/links) ...... +1      (INTERACTIVE)
 *   text contains a consent term .. +4      (CONSENT_TERMS_SCORE)
 *   text is banner-length, not
 *     an entire page/article ...... +1      (TEXT_LENGTH_OK)
 *
 * Maximum score reachable WITHOUT any consent wording in the text is 2 + 2
 * + 2 + 1 + 1 = 8, one short of the threshold of 9. That is deliberate: no
 * combination of styling/size/interactivity alone - e.g. an ordinary sticky
 * site header with a couple of nav buttons - can ever cross the threshold.
 * Only an element that *also* talks about cookies/consent/privacy can, which
 * matches what a cookie banner actually is: something defined by what it
 * says, not just how it's positioned. This is expressed as an ordinary
 * summed score (per the brief: reason in points, not in a mandatory AND
 * chain) rather than a hard-coded special case, but the arithmetic is
 * intentionally tuned so consent wording is, in practice, load-bearing.
 * A hidden/closed banner (`display: none`, `visibility: hidden`, `opacity:
 * 0`) is excluded before scoring even starts - that is a basic visibility
 * gate, not a banner-identifying signal, and does not change any of the
 * above.
 */

export const HEURISTIC_MIN_Z_INDEX = 999;
export const HEURISTIC_MAX_TRAVERSAL_DEPTH = 25;
export const HEURISTIC_MAX_TRAVERSAL_NODES = 6000;
export const HEURISTIC_MAX_TEXT_LENGTH = 4000;
export const HEURISTIC_SUSPICION_THRESHOLD = 9;

const SCORE = {
  POSITION_FIXED_STICKY: 2,
  POSITION_ABSOLUTE: 1,
  ZINDEX_HIGH: 2,
  ZINDEX_POSITIVE: 1,
  SIZE_ALL: 2,
  SIZE_MOSTLY: 1,
  INTERACTIVE: 1,
  CONSENT_TERMS: 4,
  TEXT_LENGTH_OK: 1,
};

// Best-effort, multi-language cue words for the "suspected banner" heuristic.
// This does not drive any action - only the report-button state (see the
// module doc above). Extended from src/rules/labels.json's real button-label
// translations (rejectAll/necessaryOnly concepts) plus the generic
// cookie/consent/privacy nouns for each language.
export const CONSENT_TERMS = [
  'cookie', 'cookies', 'consent', 'privacy choices',
  'rifiuta', 'accetta', 'consenso', 'cookie policy',
  'ablehnen', 'zustimmen', 'einwilligung',
  'accepter', 'refuser', 'consentement',
  'rechazar', 'aceptar', 'consentimiento',
  // Dutch
  'toestemming', 'cookiebeleid', 'privacybeleid', 'alles weigeren', 'alleen noodzakelijke',
  // Polish
  'ciasteczka', 'pliki cookie', 'zgoda', 'polityka prywatności', 'odrzuć wszystkie', 'tylko niezbędne',
  // Portuguese
  'consentimento', 'política de cookies', 'política de privacidade', 'rejeitar tudo', 'apenas necessários',
  // Danish
  'samtykke', 'cookiepolitik', 'privatlivspolitik', 'afvis alle', 'kun nødvendige',
  // Swedish
  'samtycke', 'cookiepolicy', 'integritetspolicy', 'avvisa alla', 'endast nödvändiga',
  // Norwegian (Bokmål)
  'informasjonskapsler', 'personvern', 'personvernerklæring', 'avvis alle', 'kun nødvendige',
  // Finnish
  'evästeet', 'suostumus', 'evästekäytäntö', 'tietosuojakäytäntö', 'hylkää kaikki', 'vain välttämättömät',
  // Czech
  'soubory cookie', 'souhlas', 'zásady používání souborů cookie', 'zásady ochrany osobních údajů', 'odmítnout vše', 'pouze nezbytné',
  // Hungarian
  'sütik', 'hozzájárulás', 'adatvédelmi', 'süti szabályzat', 'összes elutasítása', 'csak a szükséges',
  // Romanian
  'cookie-uri', 'consimțământ', 'politica de confidențialitate', 'politica privind cookie-urile', 'respinge tot', 'doar cele necesare',
  // Greek
  'συγκατάθεση', 'πολιτική απορρήτου', 'πολιτική cookie', 'απόρριψη όλων', 'μόνο τα απαραίτητα',
  // Turkish
  'çerezler', 'onay', 'gizlilik politikası', 'çerez politikası', 'tümünü reddet', 'yalnızca gerekli',
];

// Plausible banner container tags. Kept intentionally short so that
// getComputedStyle (called only on these) never runs on more than a
// handful of elements per page. Custom elements (tag name containing a
// hyphen, e.g. Usercentrics' own root element) are included because some
// CMPs host their banner directly on a web component rather than a `div`.
const CANDIDATE_TAG_NAMES = new Set(['DIV', 'ASIDE', 'SECTION', 'DIALOG', 'FOOTER', 'FORM']);

function isCandidateContainerTag(el) {
  const tag = el && el.tagName;
  if (!tag) return false;
  if (CANDIDATE_TAG_NAMES.has(tag)) return true;
  return tag.includes('-');
}

/**
 * Breadth-first walk of `root`'s descendants, recursing into any *open*
 * shadow root encountered along the way. Bounded by
 * `HEURISTIC_MAX_TRAVERSAL_DEPTH` / `HEURISTIC_MAX_TRAVERSAL_NODES` (see the
 * module doc for why). Returns every visited element (not filtered), so
 * callers can cheaply derive whatever subset they need (candidate banner
 * containers, `[id]`/`[class]`/`script[src]` for fingerprinting, ...)
 * without a second DOM traversal. Never throws: a root with no `.children`,
 * or an inaccessible `.shadowRoot`, is treated as having none.
 */
export function collectShadowAwareElements(root, {
  maxDepth = HEURISTIC_MAX_TRAVERSAL_DEPTH,
  maxNodes = HEURISTIC_MAX_TRAVERSAL_NODES,
} = {}) {
  const visited = [];
  if (!root) return visited;

  let queue;
  try {
    queue = root.children ? Array.from(root.children).map((el) => ({ el, depth: 0 })) : [];
  } catch {
    return visited;
  }

  let head = 0;
  while (head < queue.length && visited.length < maxNodes) {
    const { el, depth } = queue[head];
    head += 1;
    visited.push(el);

    if (depth >= maxDepth) continue;

    try {
      const children = el.children ? Array.from(el.children) : [];
      for (const child of children) queue.push({ el: child, depth: depth + 1 });
    } catch {
      /* A malformed/detached node here just contributes no children. */
    }

    let shadow = null;
    try {
      // Only ever populated for *open* shadow roots - closed ones leave
      // `shadowRoot` null/absent, which is indistinguishable here from "no
      // shadow root at all". That is intentional: this must never throw or
      // otherwise try to defeat a closed root's opacity.
      shadow = el.shadowRoot || null;
    } catch {
      shadow = null;
    }
    if (shadow) {
      try {
        const shadowChildren = shadow.children ? Array.from(shadow.children) : [];
        for (const child of shadowChildren) queue.push({ el: child, depth: depth + 1 });
      } catch {
        /* ignore */
      }
    }
  }

  return visited;
}

function isRenderedVisible(style) {
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  // jsdom (and some engines) report an unset opacity as '' rather than the
  // CSS-initial '1' - only treat it as hidden when a zero opacity was
  // actually resolved.
  if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  return true;
}

function positionScore(style) {
  if (style.position === 'fixed' || style.position === 'sticky') return SCORE.POSITION_FIXED_STICKY;
  if (style.position === 'absolute') return SCORE.POSITION_ABSOLUTE;
  return 0;
}

function zIndexScore(style) {
  const z = Number.parseInt(style.zIndex, 10);
  if (Number.isNaN(z)) return 0; // covers 'auto' and an unset/empty value
  if (z >= HEURISTIC_MIN_Z_INDEX) return SCORE.ZINDEX_HIGH;
  if (z > 0) return SCORE.ZINDEX_POSITIVE;
  return 0;
}

/**
 * Size and on-screen placement typical of a consent banner: wide enough to
 * read as a bar/modal rather than a widget, tall enough to hold real
 * content but not the entire page, and actually intersecting the viewport
 * right now (not translated off-screen). Graded rather than all-or-nothing:
 * all three -> SIZE_ALL, exactly two -> SIZE_MOSTLY, otherwise 0.
 */
function sizePlacementScore(el, view) {
  let rect;
  try {
    rect = el.getBoundingClientRect();
  } catch {
    return 0;
  }
  const viewportWidth = view.innerWidth || 0;
  const viewportHeight = view.innerHeight || 0;
  if (!viewportWidth || !viewportHeight) return 0;

  const widthOk = rect.width >= viewportWidth * 0.3;
  const heightOk = rect.height >= 40 && rect.height <= viewportHeight * 0.95;
  const inViewportOk = rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;

  const trueCount = [widthOk, heightOk, inViewportOk].filter(Boolean).length;
  if (trueCount === 3) return SCORE.SIZE_ALL;
  if (trueCount === 2) return SCORE.SIZE_MOSTLY;
  return 0;
}

function interactiveScore(el) {
  try {
    const count = el.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a').length;
    return count >= 2 ? SCORE.INTERACTIVE : 0;
  } catch {
    return 0;
  }
}

function textScores(el) {
  const text = (el.textContent || '').toLowerCase();
  const hasTerm = CONSENT_TERMS.some((term) => text.includes(term));
  const trimmedLength = text.trim().length;
  const lengthOk = trimmedLength > 0 && trimmedLength <= HEURISTIC_MAX_TEXT_LENGTH;
  return {
    term: hasTerm ? SCORE.CONSENT_TERMS : 0,
    length: lengthOk ? SCORE.TEXT_LENGTH_OK : 0,
  };
}

/** Full point total for a single candidate element. Exported for tests; never throws. */
export function scoreBannerCandidate(el) {
  try {
    const view = el && el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return 0;

    const style = view.getComputedStyle(el);
    if (!isRenderedVisible(style)) return 0;

    const { term, length } = textScores(el);
    return positionScore(style)
      + zIndexScore(style)
      + sizePlacementScore(el, view)
      + interactiveScore(el)
      + term
      + length;
  } catch {
    return 0;
  }
}

/** Whether a single element crosses the suspicion threshold. Never throws. */
export function isSuspiciousBanner(el) {
  return scoreBannerCandidate(el) >= HEURISTIC_SUSPICION_THRESHOLD;
}

/**
 * Every suspected-banner element reachable from `root` (light DOM + open
 * shadow roots, bounded per the module doc). `root` is typically
 * `document.body`, but any element/Document with `.children` works.
 * `getComputedStyle` only runs on elements that first pass the cheap
 * tag-name prefilter. Never throws; yields `[]` on any failure.
 */
export function findSuspiciousBanners(root) {
  try {
    if (!root) return [];
    const all = collectShadowAwareElements(root);
    const candidates = all.filter(isCandidateContainerTag);
    return candidates.filter(isSuspiciousBanner);
  } catch {
    return [];
  }
}
