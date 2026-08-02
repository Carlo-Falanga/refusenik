/**
 * The generic rejection engine (src/engine/generic.js) - see that module's
 * doc comment for the full pipeline. This suite is built around adversarial
 * cases: every case where a naive heuristic would click "Accept" while
 * believing it clicked "Reject", or would click at all when it should not
 * have, must instead abstain. A banner left standing is an acceptable
 * outcome here; a wrong click is not.
 *
 * Stubbing approach for the storage-driven mode override: browser-api.js
 * reads `globalThis.browser` once, at import time, into a module-level const
 * (see test/background.test.js for the same pattern) - so the stub below
 * must be installed, and generic.js dynamically imported, before any test
 * runs. `node --test` runs each test file in its own process, so this stub
 * never leaks into any other test file. The backing store starts empty in
 * every test (default: no override -> `'propose'`), exactly like a freshly
 * installed extension; only the one test that exercises the override
 * mutates it, and cleans up after itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const fakeLocalStorageBackingStore = new Map();

globalThis.browser = {
  storage: {
    local: {
      get: async (keys) => {
        const key = keys; // generic.js only ever reads one key at a time
        return fakeLocalStorageBackingStore.has(key) ? { [key]: fakeLocalStorageBackingStore.get(key) } : {};
      },
      set: async (items) => {
        for (const [key, value] of Object.entries(items)) fakeLocalStorageBackingStore.set(key, value);
      },
    },
  },
};

const {
  proposeGenericRejection,
  runGenericEngine,
  GENERIC_ENGINE_MODE,
  GENERIC_ENGINE_MODE_STORAGE_KEY,
  ABSTAIN_REASON,
  ACTION_FAILURE_REASON,
  REJECT_ALL_PHRASES,
  NECESSARY_ONLY_PHRASES,
  ACCEPT_ALL_PHRASES,
} = await import('../src/engine/generic.js');

const here = dirname(fileURLToPath(import.meta.url));
const labels = JSON.parse(readFileSync(join(here, '..', 'src', 'rules', 'labels.json'), 'utf8'));

function makeDom(html = '<!doctype html><html><body></body></html>', options = {}) {
  return new JSDOM(html, { runScripts: undefined, ...options });
}

/** jsdom never computes real layout - every element that must be "visible" for this module needs a stubbed rect. */
function stubRect(el, { width = 0, height = 0, top = 0, left = 0 } = {}) {
  el.getBoundingClientRect = () => ({
    width, height, top, left, right: left + width, bottom: top + height,
  });
}

/**
 * A container that clears both suspect.js's report threshold (9) and
 * generic.js's own stricter threshold (11) with consent wording present -
 * the same fixed/high-z-index/on-screen shape test/suspect.test.js uses,
 * known to reach that score.
 */
function makeQualifyingContainer(document, { extraText = '' } = {}) {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.zIndex = '999999';
  container.append(document.createTextNode(`We use cookies and ask for your consent. ${extraText}`));
  stubRect(container, { width: 1024, height: 200, top: 568, left: 0 });
  return container;
}

function addControl(document, container, { tag = 'button', text, id, ariaLabel, href, disabled, ariaHidden, hidden } = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (tag === 'a' && href !== undefined) el.setAttribute('href', href);
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
  if (text !== undefined) el.textContent = text;
  if (disabled) el.disabled = true;
  if (ariaHidden) el.setAttribute('aria-hidden', 'true');
  stubRect(el, hidden ? { width: 0, height: 0 } : { width: 120, height: 40, top: 600, left: 10 });
  container.appendChild(el);
  return el;
}

describe('generic.js - happy path', () => {
  test('1. Accetta tutto + Rifiuta tutto: picks Rifiuta tutto, never Accetta tutto', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto' });
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, false);
    assert.equal(proposal.concept, 'rejectAll');
    assert.equal(proposal.candidateText, 'Rifiuta tutto');
    assert.equal(proposal.element, reject);
  });

  test('act mode: a successful click is verified and reported (container removed)', async () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto' });
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    reject.addEventListener('click', () => container.remove());
    document.body.appendChild(container);

    const outcome = await runGenericEngine(document.body, { mode: GENERIC_ENGINE_MODE.ACT });
    assert.equal(outcome.abstain, false);
    assert.equal(outcome.concept, 'rejectAll');
    assert.equal(outcome.clicked, true);
    assert.equal(outcome.verified, true);
    assert.equal(outcome.reason, null);
    assert.equal(container.isConnected, false);
  });
});

describe('generic.js - adversarial cases (must abstain, or must not abstain, exactly as specified)', () => {
  test('2. only Accetta tutto + Impostazioni: abstains (no reject/necessary candidate)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto' });
    addControl(document, container, { text: 'Impostazioni' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.NO_MATCHING_CONCEPT);
  });

  test('3. skroutz.gr case: id="accept-essential" but text "Δε συμφωνώ" - clicks the correct one, ignores the misleading id', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, { extraText: 'Χρησιμοποιούμε cookies. Ζητάμε τη συγκατάθεσή σας.' });
    addControl(document, container, { text: 'Αποδοχή όλων' });
    const reject = addControl(document, container, { id: 'accept-essential', text: 'Δε συμφωνώ' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, false);
    assert.equal(proposal.concept, 'rejectAll');
    assert.equal(proposal.candidateText, 'Δε συμφωνώ');
    assert.equal(proposal.element, reject);
  });

  test('4. intesasanpaolo.com case: id="cookie-denied" whose text is actually "Più opzioni" - abstains, never clicked', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta' });
    addControl(document, container, { id: 'cookie-denied', text: 'Più opzioni' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.NO_MATCHING_CONCEPT);
  });

  test('5. "Abbonati a 2,99 €/mese" wall: abstains outright (paywall veto)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'Abbonati a 2,99 €/mese per continuare senza pubblicità.',
    });
    addControl(document, container, { text: 'Abbonati' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.PAYWALL_OR_SUBSCRIPTION_WALL);
  });

  test('6. two suspicious containers on the page: abstains (page not understood)', () => {
    const { document } = makeDom().window;
    const first = makeQualifyingContainer(document);
    addControl(document, first, { text: 'Rifiuta tutto' });
    const second = makeQualifyingContainer(document);
    addControl(document, second, { text: 'Rifiuta tutto' });
    document.body.appendChild(first);
    document.body.appendChild(second);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.MULTIPLE_CONTAINERS);
  });

  test('7. <a href="/privacy">Rifiuta</a> navigates away: excluded as a candidate, abstains', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto' });
    addControl(document, container, { tag: 'a', href: '/privacy', text: 'Rifiuta' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.notEqual(proposal.concept, 'rejectAll');
  });

  test('8. a long paragraph containing "rifiuta tutto" is text, not a control: abstains', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'Questo banner spiega a lungo perché usiamo i cookie e come puoi rifiuta tutto ciò che non è essenziale tramite le impostazioni del tuo browser, se lo desideri, in qualsiasi momento.',
    });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.NO_CLICKABLE_CANDIDATES);
  });

  test('9. two buttons both "Rifiuta": ambiguous, abstains', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Rifiuta' });
    addControl(document, container, { text: 'Rifiuta' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.AMBIGUOUS_WINNER);
  });

  test('10. a label matching both rejectAll and acceptAll is discarded, never a winner', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto e rifiuta tutto' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.NO_MATCHING_CONCEPT);
  });

  test('11. a button with the exact reject phrase but a formaction pointing elsewhere: excluded as a candidate, abstains', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    // Perfectly legitimate HTML: a submit button whose `formaction`
    // overrides its form's own destination - here, to an acceptance
    // endpoint - regardless of what its label says.
    reject.setAttribute('formaction', '/consent/accept-all');
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.NO_CLICKABLE_CANDIDATES);
    assert.notEqual(proposal.concept, 'rejectAll');
  });

  test('11b. a plain submit button (no explicit type) inside a <form> with a real action: excluded as a candidate, abstains', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    const form = document.createElement('form');
    form.setAttribute('action', '/consent/save');
    container.appendChild(form);
    const reject = document.createElement('button'); // no `type` -> defaults to "submit"
    reject.textContent = 'Rifiuta tutto';
    stubRect(reject, { width: 120, height: 40, top: 600, left: 10 });
    form.appendChild(reject);
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.notEqual(proposal.concept, 'rejectAll');
  });

  test('11c. an explicit type="button" inside a <form> is not a submit control, and remains eligible', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    const form = document.createElement('form');
    form.setAttribute('action', '/consent/save');
    container.appendChild(form);
    const reject = document.createElement('button');
    reject.setAttribute('type', 'button'); // explicit non-submit type: a click here cannot submit the form
    reject.textContent = 'Rifiuta tutto';
    stubRect(reject, { width: 120, height: 40, top: 600, left: 10 });
    form.appendChild(reject);
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, false);
    assert.equal(proposal.concept, 'rejectAll');
    assert.equal(proposal.element, reject);
  });
});

describe('generic.js - currency/paywall coverage beyond €/$/£', () => {
  test('Norwegian/Danish/Swedish kroner ("Betal 49 kr..."): abstains outright (paywall veto)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'Betal 49 kr for å lese uten annonser, eller fortsett gratis.',
    });
    addControl(document, container, { text: 'Betal' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.PAYWALL_OR_SUBSCRIPTION_WALL);
  });

  test('Polish złoty ("Subskrybuj za 19,99 zł miesięcznie"): abstains outright (paywall veto)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'Subskrybuj za 19,99 zł miesięcznie, aby czytać bez reklam.',
    });
    addControl(document, container, { text: 'Subskrybuj' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.PAYWALL_OR_SUBSCRIPTION_WALL);
  });

  test('a textual currency code after the amount ("2,99 EUR per month"): abstains outright (paywall veto)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'Pay 2,99 EUR per month to continue reading without ads.',
    });
    addControl(document, container, { text: 'Subscribe' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.PAYWALL_OR_SUBSCRIPTION_WALL);
  });

  test('a textual currency code before the amount ("USD 5"): abstains outright (paywall veto)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'One-time payment of USD 5 removes all ads for a year.',
    });
    addControl(document, container, { text: 'Pay' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.PAYWALL_OR_SUBSCRIPTION_WALL);
  });

  test('ordinary text containing "lei"/"ft"-like fragments with no adjacent digit is NOT treated as a price (no false positive)', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document, {
      extraText: 'We value your leisure time and want you to enjoy the site without a lengthy consent form.',
    });
    addControl(document, container, { text: 'Rifiuta tutto' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, false);
    assert.equal(proposal.concept, 'rejectAll');
  });
});

describe('generic.js - other required cases', () => {
  test('a banner rendered inside an open shadow root is still found and correctly clicked', async () => {
    const { document } = makeDom().window;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto' });
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    // Full removal, not a `display: none` toggle: jsdom does not
    // recompute `getComputedStyle` for a shadow-DOM element after an inline
    // style mutation (a jsdom limitation, verified in isolation - it is not
    // present for light-DOM elements, and real browsers do not have it
    // either), so `isConnected` is the only reliable removal signal jsdom
    // can give this test for a node living in a shadow tree.
    reject.addEventListener('click', () => container.remove());
    shadow.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, false);
    assert.equal(proposal.concept, 'rejectAll');
    assert.equal(proposal.candidateText, 'Rifiuta tutto');

    const outcome = await runGenericEngine(document.body, { mode: GENERIC_ENGINE_MODE.ACT });
    assert.equal(outcome.clicked, true);
    assert.equal(outcome.verified, true);
  });

  test('necessaryOnly is used only when there is no rejectAll candidate', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Accetta tutto' });
    const necessary = addControl(document, container, { text: 'Solo necessari' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, false);
    assert.equal(proposal.concept, 'necessaryOnly');
    assert.equal(proposal.candidateText, 'Solo necessari');
    assert.equal(proposal.element, necessary);
  });

  test('a failed post-click verification is reported as failed, with exactly one click attempt and no fallback', async () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    let clickCount = 0;
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    reject.addEventListener('click', () => { clickCount += 1; }); // deliberately never removes/hides the container
    document.body.appendChild(container);

    const outcome = await runGenericEngine(document.body, { mode: GENERIC_ENGINE_MODE.ACT });
    assert.equal(outcome.clicked, true);
    assert.equal(outcome.verified, false);
    assert.equal(outcome.reason, ACTION_FAILURE_REASON);
    assert.equal(clickCount, 1);
  });

  test('propose mode never clicks anything, even when a winning candidate exists', async () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    let clicked = false;
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    reject.addEventListener('click', () => { clicked = true; });
    document.body.appendChild(container);

    const outcome = await runGenericEngine(document.body, { mode: GENERIC_ENGINE_MODE.PROPOSE });
    assert.equal(outcome.clicked, false);
    assert.equal(outcome.verified, null);
    assert.equal(clicked, false, 'propose mode must never actually click');
  });

  test('the runtime default (no mode override in storage) is propose-only, never act', async () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    let clicked = false;
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    reject.addEventListener('click', () => { clicked = true; });
    document.body.appendChild(container);

    const outcome = await runGenericEngine(document.body); // no explicit mode
    assert.equal(outcome.mode, GENERIC_ENGINE_MODE.PROPOSE);
    assert.equal(outcome.clicked, false);
    assert.equal(clicked, false);
  });

  test('the mode can be switched externally via storage.local, without any code change here', async () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    const reject = addControl(document, container, { text: 'Rifiuta tutto' });
    reject.addEventListener('click', () => container.remove());
    document.body.appendChild(container);

    fakeLocalStorageBackingStore.set(GENERIC_ENGINE_MODE_STORAGE_KEY, GENERIC_ENGINE_MODE.ACT);
    try {
      const outcome = await runGenericEngine(document.body); // no explicit mode - resolved from storage
      assert.equal(outcome.mode, GENERIC_ENGINE_MODE.ACT);
      assert.equal(outcome.clicked, true);
      assert.equal(outcome.verified, true);
    } finally {
      fakeLocalStorageBackingStore.delete(GENERIC_ENGINE_MODE_STORAGE_KEY);
    }
  });

  test('a password field inside the container vetoes any action', () => {
    const { document } = makeDom().window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Rifiuta tutto' });
    const password = document.createElement('input');
    password.setAttribute('type', 'password');
    container.appendChild(password);
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.PASSWORD_OR_PAYMENT_FORM);
  });

  test('below the stricter generic threshold (score >= 9 but < 11): abstains even though the report heuristic would flag it', () => {
    const { document } = makeDom().window;
    // Absolute position (not fixed/sticky) + no z-index -> lands at exactly
    // suspect.js's report threshold (9) but under generic.js's own (11):
    // 1 (absolute) + 0 (no z-index) + 2 (size) + 1 (interactive) + 4 (term) + 1 (length) = 9.
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.append(document.createTextNode('We use cookies and ask for your consent.'));
    stubRect(container, { width: 1024, height: 200, top: 568, left: 0 });
    document.body.appendChild(container);
    addControl(document, container, { text: 'Accetta tutto' });
    addControl(document, container, { text: 'Rifiuta tutto' });

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.abstain, true);
    assert.equal(proposal.reason, ABSTAIN_REASON.BELOW_GENERIC_THRESHOLD);
  });

  test('host is read from the page location', () => {
    const { document } = makeDom('<!doctype html><html><body></body></html>', { url: 'https://example.test/page' }).window;
    const container = makeQualifyingContainer(document);
    addControl(document, container, { text: 'Rifiuta tutto' });
    document.body.appendChild(container);

    const proposal = proposeGenericRejection(document.body);
    assert.equal(proposal.host, 'example.test');
  });
});

describe('generic.js - labels.json parity (defense against the two lists silently drifting apart)', () => {
  function flattenConcept(concept) {
    return Object.values(concept).flat().map((s) => String(s).normalize('NFKC').toLowerCase().trim());
  }

  function normalizedSet(list) {
    return new Set(list.map((s) => String(s).normalize('NFKC').toLowerCase().trim()));
  }

  /**
   * Checked in both directions, deliberately: labels.json ⊆ mirror (nothing
   * authored there is missing from generic.js - a coverage gap) AND mirror ⊆
   * labels.json (nothing exists in generic.js's array that isn't authored in
   * labels.json - an unreviewed phrase that would let this module match more
   * aggressively than the source of truth ever authorized). Checking only
   * the first direction would leave that second failure mode - the more
   * dangerous one, since it is generic.js granting itself extra matching
   * power - completely uncovered.
   */
  function assertConceptParity(mirroredList, labelsConcept, label) {
    const mirrored = normalizedSet(mirroredList);
    const authored = new Set(flattenConcept(labelsConcept));

    const missingFromMirror = [...authored].filter((phrase) => !mirrored.has(phrase));
    assert.deepEqual(missingFromMirror, [], `labels.json ${label} phrase(s) missing from generic.js's mirrored list`);

    const extraInMirror = [...mirrored].filter((phrase) => !authored.has(phrase));
    assert.deepEqual(extraInMirror, [], `generic.js's ${label} list has phrase(s) not authored in labels.json`);
  }

  test('rejectAll: generic.js\'s mirrored list matches labels.json exactly, in both directions', () => {
    assertConceptParity(REJECT_ALL_PHRASES, labels.concepts.rejectAll, 'rejectAll');
  });

  test('necessaryOnly: generic.js\'s mirrored list matches labels.json exactly, in both directions', () => {
    assertConceptParity(NECESSARY_ONLY_PHRASES, labels.concepts.necessaryOnly, 'necessaryOnly');
  });

  test('acceptAll: generic.js\'s mirrored list matches labels.json exactly, in both directions', () => {
    assert.ok(labels.concepts.acceptAll, 'labels.json must define the acceptAll concept');
    assertConceptParity(ACCEPT_ALL_PHRASES, labels.concepts.acceptAll, 'acceptAll');
  });
});
