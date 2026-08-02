/**
 * Generic rejection engine.
 *
 * Runs only when nothing else has handled the page: no known-CMP rule
 * matched (src/engine/detect.js), and the late-CMP observation window in
 * content.js has already elapsed. It is the last thing that ever runs on a
 * page load, wired in at exactly the point content.js already calls
 * `reportSuspiciousBannerIfAny()` - same top-frame-only gate, same "only
 * after the 20s window" gate. A `consentOrPay` wall is never reached here at
 * all: `tryHandleCMP()` recognises and reports it before this module's
 * caller ever runs (see content.js's module doc, point 1).
 *
 * THE GOVERNING RULE, restated because it constrains every design choice
 * below: when in doubt, do nothing. A banner left standing is an acceptable
 * outcome. A wrong click that lands on "Accept" while believing it refused
 * is the single worst failure mode this product has - worse than doing
 * nothing, because it hands over the user's consent while they believe
 * they're protected. Every step below is written to fail closed (abstain)
 * rather than fail open (guess and click).
 *
 * Pipeline (each step can only narrow down to "abstain" or "keep going",
 * never loosen a previous step's decision):
 *
 *  1. Container - src/engine/suspect.js's `findSuspiciousBanners()` must
 *     find EXACTLY ONE candidate container. Zero: nothing to do. More than
 *     one: we don't understand the page well enough to pick the right one.
 *     That single container is then re-scored against a threshold stricter
 *     than the popup's report-button threshold
 *     (`GENERIC_ENGINE_MIN_SCORE` > `HEURISTIC_SUSPICION_THRESHOLD`), with an
 *     explicit, separate requirement that consent wording
 *     (src/engine/suspect.js's `CONSENT_TERMS`) is actually present - not
 *     merely implied by the score. (In practice `HEURISTIC_SUSPICION_THRESHOLD`
 *     already can't be reached without consent wording contributing to the
 *     score - see suspect.js's module doc - so this check is redundant with
 *     today's arithmetic. It is kept as an explicit, independent condition
 *     anyway: this module must never rely on an invariant it does not itself
 *     enforce, in case suspect.js's scoring is ever retuned.)
 *
 *  2. Vetoes - either one alone is enough to abstain outright, before any
 *     candidate button is even looked at:
 *       - a consent-or-pay / paywall wall: the container's text mentions a
 *         subscription/paywall in any supported language (`PAYWALL_MARKERS`)
 *         or contains a currency amount (`hasCurrencyAmount` - a symbol or a
 *         textual currency code/abbreviation - kr, zł, Kč, Ft, lei, EUR, USD,
 *         ... - immediately touching a digit, in either order). This is the
 *         catch-all for consent-or-pay walls that src/rules/rules.json has
 *         not (yet) catalogued by name - the single most common trap for a
 *         heuristic like this one, because "the only decline-shaped control
 *         actually enrols you in a subscription" is exactly the shape of
 *         mistake this module exists to never make, and it is routinely
 *         priced in a local currency, not just €/$/£.
 *       - a password field or anything payment-shaped inside the container
 *         (see `hasPasswordOrPaymentForm`).
 *
 *  3. Candidates - only genuinely clickable controls inside the container:
 *     `button`, `[role="button"]`, `input[type=submit|button]`, and `a` only
 *     when it does not navigate away (no `href`, or `#`, or `javascript:`).
 *     An `a href="/privacy">Reject</a>` is a link to the privacy policy, not
 *     a refusal control, no matter what it says. Invisible (zero-size,
 *     `display:none`, `visibility:hidden`, `opacity:0`), disabled or
 *     `aria-hidden="true"` elements are dropped. Traversal is shadow-DOM
 *     aware via suspect.js's `collectShadowAwareElements`, for the same
 *     reason suspect.js itself needs it (see that module's doc).
 *
 *     Also dropped here, unconditionally: any control that would actually
 *     submit an HTML form rather than just toggle client-side state (see
 *     `hasRiskyFormSubmission`). A `<button>` defaults to `type="submit"`
 *     when unspecified, and a `formaction` attribute lets a single button
 *     override its form's own destination outright - so perfectly legitimate
 *     markup can carry the exact reject wording while actually being wired,
 *     via `formaction` or the enclosing `<form>`'s `action`, to POST to an
 *     acceptance endpoint. There is no way to read a URL and know its intent
 *     is safe, so any submit-type control associated with a form is treated
 *     as unsafe unconditionally, whatever the label says - the wrong-click
 *     failure mode this whole module exists to prevent, wearing perfectly
 *     ordinary HTML.
 *
 *  4. Text match - each candidate's label (aria-label, else textContent, else
 *     `value` for `input`s - in that order, since that mirrors what a real
 *     user actually reads) is Unicode-normalized (NFKC; diacritics are never
 *     stripped, since several supported languages - Greek among them -
 *     depend on them) and capped at `MAX_CANDIDATE_LABEL_LENGTH` characters:
 *     a genuine button label is short, and a long paragraph that happens to
 *     contain a reject phrase is text, not a control. A label matches a
 *     concept only if it equals one of that concept's known phrases, or
 *     contains one as a whole word/phrase (never as a substring of a longer
 *     word). `rejectAll` and `necessaryOnly` come from
 *     src/rules/labels.json (mirrored here as plain arrays - see the note by
 *     `REJECT_ALL_PHRASES` below for why this module does not import the
 *     JSON file directly). `acceptAll` is new (also added to labels.json,
 *     schemaVersion bumped) and is used EXCLUSIVELY AS A VETO: any candidate
 *     whose label matches `acceptAll` is discarded outright, permanently,
 *     even if the same label also happens to match `rejectAll` - being
 *     offered as the reject option is not what saves a button that also
 *     reads as an accept option.
 *
 *     Deliberately NOT implemented: opening a "manage settings" / preference
 *     panel and operating it. That path is multi-step, and every extra step
 *     is another chance to end up clicking "Save and exit" with every
 *     category still enabled - a failure mode this module cannot verify with
 *     the same confidence as a single, immediately-verified click. Left out
 *     on purpose, not an oversight.
 *
 *  5. Golden rule - of the candidates left after step 4, `rejectAll` is
 *     preferred over `necessaryOnly` (only considered if there is no
 *     `rejectAll` candidate at all - not merely if `rejectAll` was
 *     ambiguous: an ambiguous `rejectAll` still means "we don't understand
 *     this banner", not "fall back to necessaryOnly"). Whichever concept
 *     ends up "in play" must then have EXACTLY ONE matching candidate. Two
 *     buttons that both read as a rejection mean the banner isn't understood
 *     well enough to know which one actually does it.
 *
 *  6. Action - exactly one click, executed through steps.js's own `click`
 *     action (never a bespoke click mechanism - see `clickAndVerify`),
 *     followed by a single verification: the container must be gone or
 *     hidden, and the page's scroll must not be locked. A failed
 *     verification is reported as a failure and nothing else is attempted -
 *     no retry, no falling back to a different candidate.
 *
 *  7. Propose-only mode - `runGenericEngine()`'s `mode` can force
 *     `'propose'`, which runs the entire pipeline above and stops right
 *     before step 6, returning an inspectable report: the host, the exact
 *     candidate text that *would* have been clicked, the matched concept,
 *     the container's score, and - on abstention - the precise reason. This
 *     is the only way to validate this module before trusting it in `'act'`
 *     mode: a sweep that only checks "did the banner disappear" cannot tell
 *     a correct refusal apart from an accidental "Accept" click, since both
 *     make the banner go away. When `mode` is omitted, it is resolved from
 *     `storage.local` (see `resolveMode`) so it can be switched from outside
 *     this module - a validation harness, or later a settings UI - without
 *     changing any code here. Absent any stored override, the runtime
 *     default is `'propose'`: this module ships inert until something
 *     explicitly turns it on.
 */

import {
  collectShadowAwareElements,
  findSuspiciousBanners,
  scoreBannerCandidate,
  CONSENT_TERMS,
} from './suspect.js';
import { runFlow } from './steps.js';
import { storageLocalGet } from './browser-api.js';

/**
 * Stricter than suspect.js's `HEURISTIC_SUSPICION_THRESHOLD` (9, used only to
 * decide whether to show the popup's report button). Acting on a page - even
 * just picking which container to inspect for a rejection control - demands
 * more confidence than merely flagging it for a human, hence the higher bar.
 */
export const GENERIC_ENGINE_MIN_SCORE = 11;

/**
 * A genuine button/link label is short. Capping the normalized label length
 * is what keeps a long paragraph that happens to contain "reject all"
 * somewhere inside it from ever being treated as a match - see step 4 in the
 * module doc above.
 */
export const MAX_CANDIDATE_LABEL_LENGTH = 40;

export const GENERIC_ENGINE_MODE = Object.freeze({
  PROPOSE: 'propose',
  ACT: 'act',
});

/** storage.local key an external caller can set to override the resolved mode (see `resolveMode`). */
export const GENERIC_ENGINE_MODE_STORAGE_KEY = 'refusenikGenericEngineMode';

/** Every reason this module can abstain, or fail an action, for. Used verbatim in the report returned by `proposeGenericRejection`/`runGenericEngine`. */
export const ABSTAIN_REASON = Object.freeze({
  NO_CONTAINER: 'no-suspicious-container',
  MULTIPLE_CONTAINERS: 'multiple-suspicious-containers',
  BELOW_GENERIC_THRESHOLD: 'below-generic-threshold',
  PAYWALL_OR_SUBSCRIPTION_WALL: 'paywall-or-subscription-wall',
  PASSWORD_OR_PAYMENT_FORM: 'password-or-payment-form',
  NO_CLICKABLE_CANDIDATES: 'no-clickable-candidates',
  NO_MATCHING_CONCEPT: 'no-reject-or-necessary-candidate',
  AMBIGUOUS_WINNER: 'ambiguous-winning-candidate-count',
  ENGINE_ERROR: 'engine-error',
});

/** Only ever set on a successfully-clicked, non-abstained outcome whose post-click verification failed (step 6). Distinct from `ABSTAIN_REASON`: this is an action that was attempted and failed, not a pre-click abstention. */
export const ACTION_FAILURE_REASON = 'post-click-verification-failed';

// Mirrored from src/rules/labels.json's `rejectAll`/`necessaryOnly` concepts,
// flattened across every language, plus the new `acceptAll` concept (also
// added to labels.json itself - see that file and its schemaVersion bump).
// Not imported from the JSON file directly: src/engine/ is bundled by
// esbuild into a browser-loaded content script (build.mjs), and every other
// module in this directory that needs labels.json's wording keeps its own
// plain-array copy for the same reason (see suspect.js's CONSENT_TERMS and
// its module doc). The two must be kept in sync by hand; a cross-check
// against labels.json lives in test/generic.test.js.
export const REJECT_ALL_PHRASES = [
  'reject all', 'decline all', 'deny', 'deny all',
  'rifiuta tutto', 'rifiuta tutti', 'rifiuta', 'rifiuta i cookie non tecnici',
  'alle ablehnen', 'ablehnen',
  'tout refuser', 'refuser tout', 'refuser tous les cookies',
  'rechazar todo', 'rechazar todos', 'rechazar todas',
  'alles weigeren', 'alles afwijzen', 'alle cookies weigeren', 'weiger alle cookies',
  'odrzuć wszystkie', 'odrzuć wszystko', 'odrzuć wszystkie pliki cookie', 'nie zgadzam się', 'nie wyrażam zgody',
  'rejeitar tudo', 'recusar tudo', 'rejeitar todos os cookies',
  'afvis alle', 'afvis alle cookies', 'afslå alle',
  'avvisa alla', 'neka alla', 'avvisa alla cookies',
  'avvis alle', 'avvis alle informasjonskapsler', 'avslå alle',
  'hylkää kaikki', 'hylkää kaikki evästeet', 'kiellä kaikki',
  'odmítnout vše', 'odmítnout všechny', 'odmítnout všechny soubory cookie',
  'összes elutasítása', 'az összes elutasítása', 'minden elutasítása',
  'respinge tot', 'respinge toate', 'refuz toate cookie-urile', 'refuză toate',
  'απόρριψη όλων', 'απόρριψη όλων των cookies', 'απόρριψη όλων των αρχείων cookie', 'δε συμφωνώ', 'δεν συμφωνώ',
  'tümünü reddet', 'tüm çerezleri reddet', 'çerezleri reddet',
];

export const NECESSARY_ONLY_PHRASES = [
  'necessary only', 'only necessary', 'accept essentials only', 'use necessary cookies only', 'continue without accepting', 'do not accept', 'do not consent',
  'solo necessari', 'solo cookie necessari', 'continua senza accettare', 'non accettare', 'non acconsentire',
  'nur notwendige', 'nur erforderliche cookies', 'ohne zustimmung fortfahren',
  'uniquement nécessaires', 'cookies nécessaires uniquement', 'continuer sans accepter',
  'solo necesarias', 'solo cookies necesarias', 'continuar sin aceptar',
  'alleen noodzakelijke', 'alleen essentiële cookies', 'doorgaan zonder accepteren', 'alleen noodzakelijke cookies toestaan',
  'tylko niezbędne', 'tylko niezbędne pliki cookie', 'kontynuuj bez akceptacji',
  'apenas necessários', 'apenas cookies necessários', 'continuar sem aceitar',
  'kun nødvendige', 'kun nødvendige cookies', 'fortsæt uden at acceptere',
  'endast nödvändiga', 'endast nödvändiga cookies', 'fortsätt utan att acceptera',
  'kun nødvendige informasjonskapsler', 'fortsett uten å godta',
  'vain välttämättömät', 'vain välttämättömät evästeet', 'jatka hyväksymättä',
  'pouze nezbytné', 'pouze nezbytné soubory cookie', 'pokračovat bez souhlasu',
  'csak a szükséges', 'csak a szükséges sütik', 'folytatás elfogadás nélkül',
  'doar cele necesare', 'doar cookie-urile necesare', 'continuă fără a accepta',
  'μόνο τα απαραίτητα', 'μόνο απαραίτητα cookies', 'συνέχεια χωρίς αποδοχή',
  'yalnızca gerekli', 'sadece gerekli çerezler', 'kabul etmeden devam et',
];

// New concept (src/rules/labels.json's `acceptAll`), used only as a veto -
// see the module doc, step 4.
export const ACCEPT_ALL_PHRASES = [
  'accept all', 'allow all', 'agree', 'i agree', 'accept',
  'accetta tutto', 'accetta tutti', 'accetto', 'accetta',
  'alle akzeptieren', 'akzeptieren', 'ich stimme zu',
  'tout accepter', 'accepter tout', 'accepter tous les cookies', "j'accepte",
  'aceptar todo', 'aceptar todos', 'aceptar todas', 'acepto',
  'alles accepteren', 'alle cookies accepteren', 'accepteren',
  'zaakceptuj wszystkie', 'akceptuję wszystkie', 'akceptuj wszystko', 'zgadzam się',
  'aceitar tudo', 'aceitar todos os cookies', 'aceito',
  'accepter alle', 'tillad alle', 'accepter alle cookies',
  'acceptera alla', 'tillåt alla', 'acceptera alla cookies',
  'godta alle', 'godta alle informasjonskapsler', 'tillat alle',
  'hyväksy kaikki', 'hyväksy kaikki evästeet', 'salli kaikki',
  'přijmout vše', 'přijmout všechny', 'přijmout všechny soubory cookie',
  'összes elfogadása', 'az összes elfogadása', 'elfogadom',
  'acceptă tot', 'acceptă toate', 'accept toate cookie-urile', 'sunt de acord',
  'αποδοχή όλων', 'αποδοχή όλων των cookies', 'συμφωνώ',
  'tümünü kabul et', 'tüm çerezleri kabul et', 'kabul ediyorum',
];

// Multi-language cues for a consent-or-pay / subscription wall (step 2's
// first veto). Extra/borderline entries here only ever make this module
// MORE likely to abstain, never more likely to click - so, unlike
// suspect.js's CONSENT_TERMS (which gates a UI affordance, not an action),
// erring toward more entries here is strictly safe.
const PAYWALL_MARKERS = [
  'abbonati', 'abbonamento', 'abbonarsi', 'senza pubblicità', 'senza pubblicita',
  'subscribe', 'subscription', 'ad-free', 'ad free', 'go premium',
  'abonnieren', 'abonnement', 'werbefrei', 'kostenpflichtig',
  "s'abonner", 'abonnez-vous', 'abonnement', 'sans publicité',
  'suscríbete', 'suscribete', 'suscripción', 'suscripcion', 'sin publicidad',
  'abonneren', 'abonnement', 'advertentievrij',
  'subskrybuj', 'subskrypcja', 'bez reklam',
  'assinar', 'assinatura', 'sem anúncios', 'sem anuncios',
  'abonnere', 'abonnement', 'uden reklamer',
  'prenumerera', 'prenumeration', 'annonsfri',
  'abonner', 'abonnement', 'reklamefri',
  'tilaa', 'tilaus', 'mainokseton',
  'předplatit', 'předplatné', 'bez reklam',
  'előfizet', 'előfizetés', 'reklámmentes',
  'abonează-te', 'abonament', 'fără reclame',
  'εγγραφείτε', 'συνδρομή', 'χωρίς διαφημίσεις',
  'abone ol', 'abonelik', 'reklamsız',
  'premium', '/mese', '/month', '/mo', 'al mese', 'per month', 'pro monat', 'par mois',
];

// Currency symbols checked for direct digit-adjacency by `hasCurrencyAmount`
// below (e.g. "€2,99", "$5", "5€"). Purely symbolic, so no word-boundary
// concern - a symbol is never a fragment of an unrelated word.
const CURRENCY_SYMBOLS = ['€', '$', '£', '¥', '₤', '₺', '₽'];

// Currency abbreviations/ISO-ish codes checked for digit-adjacency only
// (never as a bare substring, unlike PAYWALL_MARKERS above): several of
// these (kr, ft, lei) are too short/common as fragments of ordinary words in
// several supported languages ("leisure" contains "lei", "ft" appears inside
// many English words) to ever be trusted as a standalone marker. Adjacent to
// a digit, in either order, they stop being ambiguous.
const CURRENCY_WORDS_NEEDING_DIGIT = [
  'kr', 'zł', 'kč', 'ft', 'lei', 'leu',
  'eur', 'usd', 'gbp', 'chf', 'sek', 'nok', 'dkk', 'pln', 'czk', 'huf', 'ron', 'try', 'rub',
];

/**
 * True if `text` (already normalized - see `normalizeForMatch`) contains a
 * currency symbol or textual currency code immediately touching a digit, in
 * either order ("€2,99" and "2,99€" both count; "49 kr" and "kr 49" both
 * count). A single optional space/punctuation between the two is tolerated,
 * matching how prices are actually typeset ("€ 2,99", "49 kr").
 */
function hasCurrencyAmount(text) {
  for (const symbol of CURRENCY_SYMBOLS) {
    const escaped = escapeRegExp(symbol);
    if (new RegExp(`${escaped}\\s?\\d`, 'u').test(text)) return true;
    if (new RegExp(`\\d\\s?${escaped}`, 'u').test(text)) return true;
  }
  for (const word of CURRENCY_WORDS_NEEDING_DIGIT) {
    const escaped = escapeRegExp(word);
    // digit ... word, word ending at a non-letter/non-digit boundary (or end of string)
    if (new RegExp(`\\d[\\d.,]*\\s?${escaped}(?=[^\\p{L}\\p{N}]|$)`, 'u').test(text)) return true;
    // word ... digit, word starting at a non-letter/non-digit boundary (or start of string)
    if (new RegExp(`(?<=^|[^\\p{L}\\p{N}])${escaped}\\s?\\d`, 'u').test(text)) return true;
  }
  return false;
}

/** Collapses whitespace and trims, without touching case - used for the "exact text" reported back on a proposal. */
function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Unicode-normalizes (NFKC - diacritics are never stripped, several
 * supported languages depend on them), collapses whitespace and lower-cases.
 * Used for every text comparison in this module (concept matching, paywall
 * markers), never for the "exact text" reported back to a caller.
 */
function normalizeForMatch(text) {
  return collapseWhitespace(text).normalize('NFKC').toLowerCase();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `normalizedPhrase` appears in `normalizedLabel` as the whole label or a whole word/phrase - never as a fragment of a longer word. */
function containsWholePhrase(normalizedLabel, normalizedPhrase) {
  if (!normalizedPhrase) return false;
  if (normalizedLabel === normalizedPhrase) return true;
  try {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedPhrase)}($|[^\\p{L}\\p{N}])`, 'u');
    return pattern.test(normalizedLabel);
  } catch {
    return false;
  }
}

function matchesAnyPhrase(normalizedLabel, phrases) {
  return phrases.some((phrase) => containsWholePhrase(normalizedLabel, normalizeForMatch(phrase)));
}

function exactlyMatchesAnyPhrase(normalizedLabel, phrases) {
  return phrases.some((phrase) => normalizeForMatch(phrase) === normalizedLabel);
}

/** True if `root`'s (normalized) text mentions a paywall/subscription wall in any supported language, or a currency amount. */
function hasPaywallMarker(root) {
  let text;
  try {
    text = normalizeForMatch(root.textContent);
  } catch {
    return false;
  }
  if (hasCurrencyAmount(text)) return true;
  return PAYWALL_MARKERS.some((marker) => text.includes(normalizeForMatch(marker)));
}

// Known payment-processor hosts, checked as a substring of an `<iframe>`'s
// `src` (see `hasPasswordOrPaymentForm`). Not exhaustive by design - an
// unlisted processor simply falls back to the password-field/card-field
// checks above, or (per the module's governing rule) to a container that
// scores below the threshold or lacks a clean single candidate; there is no
// list this module could ever treat as complete, so this is a best-effort
// addition to the other checks, not the only line of defense.
const PAYMENT_PROCESSOR_HOSTS = [
  'stripe', 'paypal', 'braintree', 'adyen', 'checkout.com',
  'klarna', 'mollie', 'worldpay', 'squareup', 'square.com', 'gocardless',
];

/** True if any element in `descendants` is a password field or looks payment-related (card fields, known payment-processor iframes). */
function hasPasswordOrPaymentForm(descendants) {
  return descendants.some((el) => {
    try {
      const tag = el.tagName;
      if (tag === 'INPUT') {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'password') return true;
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (autocomplete.startsWith('cc-')) return true;
        const name = (el.getAttribute('name') || '').toLowerCase();
        const id = (el.getAttribute('id') || '').toLowerCase();
        if (/card.?number|cvv|cvc/.test(name) || /card.?number|cvv|cvc/.test(id)) return true;
      }
      if (tag === 'IFRAME') {
        const src = (el.getAttribute('src') || '').toLowerCase();
        if (PAYMENT_PROCESSOR_HOSTS.some((p) => src.includes(p))) return true;
      }
    } catch {
      /* One malformed element must not abort the scan of the rest. */
    }
    return false;
  });
}

/** Whether `el` is an anchor that does not actually navigate anywhere (no `href`, or `#`, or a `javascript:` pseudo-URL) - see module doc, step 3. */
function isNonNavigatingAnchor(el) {
  const href = el.getAttribute('href');
  if (href === null) return true;
  const trimmed = href.trim();
  if (trimmed === '' || trimmed === '#') return true;
  if (/^javascript:/i.test(trimmed)) return true;
  return false;
}

function isEligibleTag(el) {
  const tag = el.tagName;
  if (tag === 'BUTTON') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'submit' || type === 'button';
  }
  if (tag === 'A') return isNonNavigatingAnchor(el);
  const role = el.getAttribute && el.getAttribute('role');
  return Boolean(role && role.toLowerCase() === 'button');
}

/**
 * The nearest `<form>` `el` would submit into, or `null`. Prefers the native
 * `.form` IDL property (correct both for a `<button>`/`<input>` nested
 * inside a `<form>` and for one associated at a distance via a `form="id"`
 * attribute); falls back to a plain ancestor walk (bounded to the same tree
 * - never crosses a shadow boundary, since `parentNode` does not) for
 * environments where `.form` is unavailable.
 */
function findAssociatedForm(el) {
  try {
    if (el.form) return el.form;
  } catch {
    /* fall through to the manual walk below */
  }
  let node = el.parentNode;
  while (node && node.nodeType === 1) {
    if (node.tagName === 'FORM') return node;
    node = node.parentNode;
  }
  return null;
}

/**
 * True for any `button`/`input` that would actually submit an HTML form
 * (rather than just run a client-side handler) - see module doc, step 3.
 * Two independent triggers, either one enough:
 *   - a `formaction` attribute, which lets a single submit control override
 *     its form's own destination outright, regardless of what the form's
 *     own `action` says;
 *   - being an (explicit-or-defaulted) `type="submit"` control associated
 *     with ANY `<form>` at all, whatever that form's `action` is - a real
 *     submission can carry hidden fields or a destination this module has no
 *     way to inspect for intent, so it is never treated as safe, full stop.
 * `a`/`[role="button"]` candidates can never trigger a form submission and
 * always return `false` here. Any failure to determine this is treated as
 * risky (`true`), never as safe, consistent with every other check in this
 * module.
 */
function hasRiskyFormSubmission(el) {
  try {
    if (el.hasAttribute('formaction')) return true;

    const tag = el.tagName;
    let effectiveType;
    if (tag === 'BUTTON') {
      // A <button> with no (or an invalid) `type` attribute defaults to
      // "submit" per the HTML spec - the single most common way this trap
      // shows up in otherwise ordinary markup.
      const explicit = (el.getAttribute('type') || '').toLowerCase();
      effectiveType = (explicit === 'button' || explicit === 'reset') ? explicit : 'submit';
    } else if (tag === 'INPUT') {
      effectiveType = (el.getAttribute('type') || '').toLowerCase();
    } else {
      return false;
    }

    if (effectiveType !== 'submit') return false;
    return Boolean(findAssociatedForm(el));
  } catch {
    return true;
  }
}

/** Visible, enabled, and not hidden from assistive tech - see module doc, step 3. */
function isActionable(el) {
  try {
    const ariaHidden = el.getAttribute('aria-hidden');
    if (ariaHidden && ariaHidden.toLowerCase() === 'true') return false;
    if (el.disabled) return false;
    const ariaDisabled = el.getAttribute('aria-disabled');
    if (ariaDisabled && ariaDisabled.toLowerCase() === 'true') return false;

    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    const style = view.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;

    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;

    return true;
  } catch {
    return false;
  }
}

/** The visible label a user would read: aria-label, else textContent, else `value` (for `input`s, which have no textContent). */
function rawCandidateLabel(el) {
  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel;
  if (el.textContent && el.textContent.trim()) return el.textContent;
  if (el.value !== undefined && el.value !== null && String(el.value).trim()) return String(el.value);
  return '';
}

/**
 * Classifies one clickable candidate against the three concepts, in two
 * phases:
 *
 * Phase 1 - an EXACT whole-label match against one concept's own authored
 * phrase always wins over a looser "contains" match against a different
 * concept. This matters for negated formulas: Greek "Δε συμφωνώ" ("I do NOT
 * agree") is its own dedicated `rejectAll` phrase, but it also CONTAINS the
 * shorter `acceptAll` word "συμφωνώ" ("I agree") as a complete word once
 * "Δε " is stripped away. Without this phase, phase 2's veto would discard
 * it for "containing an accept word", which is exactly backwards - the
 * skroutz.gr case in test/generic.test.js is the real-world example this
 * guards against. `acceptAll` is still checked first within this phase (an
 * exact accept match wins over an exact reject match, consistent with the
 * veto's priority everywhere else).
 *
 * Phase 2 - only reached when no concept's phrase exactly equals the whole
 * label. Falls back to "label contains the phrase as a whole word/phrase"
 * (e.g. "Rifiuta tutto i cookie non necessari" contains "rifiuta tutto").
 * `acceptAll` is checked first here too and, on a match, wins outright - see
 * module doc, step 4: a label that reads as both an accept and a reject
 * phrase is discarded, not given the benefit of the doubt.
 */
function classifyCandidate(el) {
  const raw = rawCandidateLabel(el);
  const label = collapseWhitespace(raw);
  const normalized = normalizeForMatch(raw);

  if (!normalized || normalized.length > MAX_CANDIDATE_LABEL_LENGTH) {
    return { el, label, concept: null };
  }

  if (exactlyMatchesAnyPhrase(normalized, ACCEPT_ALL_PHRASES)) {
    return { el, label, concept: null };
  }
  if (exactlyMatchesAnyPhrase(normalized, REJECT_ALL_PHRASES)) {
    return { el, label, concept: 'rejectAll' };
  }
  if (exactlyMatchesAnyPhrase(normalized, NECESSARY_ONLY_PHRASES)) {
    return { el, label, concept: 'necessaryOnly' };
  }

  if (matchesAnyPhrase(normalized, ACCEPT_ALL_PHRASES)) {
    return { el, label, concept: null };
  }
  if (matchesAnyPhrase(normalized, REJECT_ALL_PHRASES)) {
    return { el, label, concept: 'rejectAll' };
  }
  if (matchesAnyPhrase(normalized, NECESSARY_ONLY_PHRASES)) {
    return { el, label, concept: 'necessaryOnly' };
  }
  return { el, label, concept: null };
}

function ownerDocumentOf(node) {
  if (!node) return null;
  if (node.nodeType === 9) return node; // Document itself
  return node.ownerDocument || null;
}

function hostFromRoot(root) {
  try {
    const doc = ownerDocumentOf(root);
    const view = doc && doc.defaultView;
    return (view && view.location && view.location.hostname) || '';
  } catch {
    return '';
  }
}

function containsConsentWording(container) {
  try {
    const text = normalizeForMatch(container.textContent);
    return CONSENT_TERMS.some((term) => text.includes(normalizeForMatch(term)));
  } catch {
    return false;
  }
}

function buildAbstention(host, reason, score = null) {
  return {
    host, score, concept: null, candidateText: null, abstain: true, reason,
    element: null, container: null,
  };
}

/**
 * Step 1: exactly one suspicious container, re-scored against the stricter
 * `GENERIC_ENGINE_MIN_SCORE` with an explicit consent-wording requirement.
 * Returns either `{ container, score }` or `{ abstention }` (a full
 * `buildAbstention()` result, ready to return as-is).
 */
function pickSingleContainer(root, host) {
  const suspects = findSuspiciousBanners(root);
  if (suspects.length === 0) return { abstention: buildAbstention(host, ABSTAIN_REASON.NO_CONTAINER) };
  if (suspects.length > 1) return { abstention: buildAbstention(host, ABSTAIN_REASON.MULTIPLE_CONTAINERS) };

  const [container] = suspects;
  const score = scoreBannerCandidate(container);
  if (score < GENERIC_ENGINE_MIN_SCORE || !containsConsentWording(container)) {
    return { abstention: buildAbstention(host, ABSTAIN_REASON.BELOW_GENERIC_THRESHOLD, score) };
  }

  return { container, score };
}

/**
 * Runs the full read-only pipeline (steps 1-5 of the module doc) and
 * returns a plain, inspectable report. Never clicks anything - see
 * `runGenericEngine` for the only code path that ever does.
 *
 * Shape of the result:
 *   { host, score, concept, candidateText, abstain, reason, element, container }
 * `element`/`container` are live DOM references for `runGenericEngine`'s own
 * use (step 6) - they are not meaningful to serialize and are omitted from
 * every example in this module's doc comment on purpose. Every other field
 * is exactly what step 7 promises: host, the exact candidate text that would
 * be clicked, the matched concept, the container's score, and - on
 * abstention - the precise reason.
 */
export function proposeGenericRejection(root) {
  const host = hostFromRoot(root);

  try {
    const picked = pickSingleContainer(root, host);
    if (picked.abstention) return picked.abstention;
    const { container, score } = picked;

    if (hasPaywallMarker(container)) {
      return buildAbstention(host, ABSTAIN_REASON.PAYWALL_OR_SUBSCRIPTION_WALL, score);
    }

    const descendants = collectShadowAwareElements(container);

    if (hasPasswordOrPaymentForm(descendants)) {
      return buildAbstention(host, ABSTAIN_REASON.PASSWORD_OR_PAYMENT_FORM, score);
    }

    const candidates = descendants.filter((el) => isEligibleTag(el) && isActionable(el) && !hasRiskyFormSubmission(el));
    if (candidates.length === 0) {
      return buildAbstention(host, ABSTAIN_REASON.NO_CLICKABLE_CANDIDATES, score);
    }

    const classified = candidates.map(classifyCandidate);
    const rejectCandidates = classified.filter((c) => c.concept === 'rejectAll');
    const necessaryCandidates = classified.filter((c) => c.concept === 'necessaryOnly');

    let winningConcept = null;
    let winningCandidates = [];
    if (rejectCandidates.length > 0) {
      winningConcept = 'rejectAll';
      winningCandidates = rejectCandidates;
    } else if (necessaryCandidates.length > 0) {
      winningConcept = 'necessaryOnly';
      winningCandidates = necessaryCandidates;
    }

    if (!winningConcept) {
      return buildAbstention(host, ABSTAIN_REASON.NO_MATCHING_CONCEPT, score);
    }
    if (winningCandidates.length !== 1) {
      return buildAbstention(host, ABSTAIN_REASON.AMBIGUOUS_WINNER, score);
    }

    const winner = winningCandidates[0];
    return {
      host, score, concept: winningConcept, candidateText: winner.label,
      abstain: false, reason: null, element: winner.el, container,
    };
  } catch {
    // Never let a malformed/hostile page throw out of this module - fail
    // the same way every other abstention does.
    return buildAbstention(host, ABSTAIN_REASON.ENGINE_ERROR);
  }
}

/** Whether `container` is gone from the DOM, or rendered invisible - the first half of step 6's post-click verification. */
function isContainerGone(container) {
  try {
    if (!container.isConnected) return true;
    const view = container.ownerDocument && container.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    const style = view.getComputedStyle(container);
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (style.opacity !== '' && Number(style.opacity) === 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** Whether page scroll is unlocked (neither `<html>` nor `<body>` has `overflow: hidden`) - the second half of step 6's post-click verification. */
function isScrollUnlocked(doc) {
  try {
    const view = doc.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return true;
    const htmlStyle = view.getComputedStyle(doc.documentElement);
    const htmlLocked = htmlStyle.overflow === 'hidden' || htmlStyle.overflowY === 'hidden';
    let bodyLocked = false;
    if (doc.body) {
      const bodyStyle = view.getComputedStyle(doc.body);
      bodyLocked = bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden';
    }
    return !htmlLocked && !bodyLocked;
  } catch {
    return true;
  }
}

// Attribute used to mark the single chosen candidate so steps.js's own
// `click` action (a CSS-selector-driven executor - see steps.js's module
// doc) can find it by a literal selector, without this module ever
// implementing its own click mechanism. Removed again immediately after the
// click step runs, win or lose.
const CLICK_MARK_ATTRIBUTE = 'data-refusenik-generic-click-target';

function randomToken() {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Step 6: exactly one click, via steps.js's `click` action, then
 * verification. Never retries and never falls back to a different
 * candidate - a failed verification is reported as a failure, full stop.
 */
async function clickAndVerify(element, container) {
  const doc = element.ownerDocument;
  const clickRoot = typeof element.getRootNode === 'function' ? element.getRootNode() : doc;
  const token = randomToken();

  let marked = false;
  try {
    element.setAttribute(CLICK_MARK_ATTRIBUTE, token);
    marked = true;
  } catch {
    return { clicked: false, verified: false };
  }

  let results;
  try {
    results = await runFlow(
      [{ action: 'click', selector: { css: `[${CLICK_MARK_ATTRIBUTE}="${token}"]` } }],
      clickRoot,
    );
  } catch {
    results = [];
  } finally {
    if (marked) {
      try {
        element.removeAttribute(CLICK_MARK_ATTRIBUTE);
      } catch {
        /* ignore */
      }
    }
  }

  const stepOk = Array.isArray(results) && results.length === 1 && results[0].ok === true;
  if (!stepOk) return { clicked: false, verified: false };

  const verified = isContainerGone(container) && isScrollUnlocked(doc);
  return { clicked: true, verified };
}

/**
 * Resolves the effective mode: an explicit `explicitMode` argument always
 * wins (used by direct callers/tests); otherwise reads
 * `GENERIC_ENGINE_MODE_STORAGE_KEY` from `storage.local` so an external
 * caller can flip the runtime default without any code change here. Absent
 * a stored override (or outside an extension context, e.g. under a plain
 * test harness), resolves to `'propose'` - the safe default described in the
 * module doc, step 7.
 */
async function resolveMode(explicitMode) {
  if (explicitMode === GENERIC_ENGINE_MODE.ACT || explicitMode === GENERIC_ENGINE_MODE.PROPOSE) {
    return explicitMode;
  }
  try {
    const stored = await storageLocalGet(GENERIC_ENGINE_MODE_STORAGE_KEY);
    const value = stored && stored[GENERIC_ENGINE_MODE_STORAGE_KEY];
    return value === GENERIC_ENGINE_MODE.ACT ? GENERIC_ENGINE_MODE.ACT : GENERIC_ENGINE_MODE.PROPOSE;
  } catch {
    return GENERIC_ENGINE_MODE.PROPOSE;
  }
}

/**
 * Entry point. Always runs the read-only pipeline first
 * (`proposeGenericRejection`); only clicks anything when the resolved mode
 * is `'act'` AND the pipeline did not abstain. Never throws.
 *
 * Returns a plain, JSON-safe report (no DOM references):
 *   { host, score, concept, candidateText, abstain, reason, mode, clicked, verified }
 * `clicked`/`verified` are `false`/`null` respectively whenever nothing was
 * ever attempted (abstained, or `mode` resolved to `'propose'`).
 */
export async function runGenericEngine(root, { mode } = {}) {
  const proposal = proposeGenericRejection(root);
  const resolvedMode = await resolveMode(mode);

  const { element, container, ...publicProposal } = proposal;
  const base = { ...publicProposal, mode: resolvedMode, clicked: false, verified: null };

  if (proposal.abstain || resolvedMode !== GENERIC_ENGINE_MODE.ACT) {
    return base;
  }

  try {
    const { clicked, verified } = await clickAndVerify(element, container);
    return {
      ...base,
      clicked,
      verified,
      reason: verified ? null : ACTION_FAILURE_REASON,
    };
  } catch {
    return { ...base, clicked: false, verified: false, reason: ACTION_FAILURE_REASON };
  }
}
