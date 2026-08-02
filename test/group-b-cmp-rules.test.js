/**
 * Behavioural coverage for the six CMP families investigated in this
 * session (src/rules/NOTE.md, "Group B"): coolblue_cookie_banner,
 * skyscanner_consent_banner, techcrunch/axeptio, intesasanpaolo/skroutz,
 * cookiefirst, secureprivacy.
 *
 * For each actionable entry: a detect test against a minimal representative
 * DOM (taken from live inspection, never guessed), a flow test asserting the
 * refusal path is exercised, and - wherever the live markup contained an
 * acceptance control right next to the refusal one - an adversarial test
 * proving the flow never touches it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

import { detectCMP, isActionableKind } from '../src/engine/detect.js';
import { runFlow } from '../src/engine/steps.js';
import { resolveTextMatchRefs } from '../src/rules/expandTextMatchRefs.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(here, '..', 'src', 'rules', 'rules.json');
const labelsPath = join(here, '..', 'src', 'rules', 'labels.json');
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
const resolved = resolveTextMatchRefs(rules, labels);

function domWithBody(html) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: undefined }).window.document;
}

function findCmp(id) {
  const cmp = resolved.cmps.find((c) => c.id === id);
  assert.ok(cmp, `expected a "${id}" entry in the resolved ruleset`);
  return cmp;
}

describe('Coolblue in-house cookie banner (coolblue_cookie_banner)', () => {
  // Live markup (coolblue.nl, nl-NL): a <form id="cookie-banner-2025-form">
  // whose "Standaard" (necessary) category checkboxes are checked+disabled
  // (the site treats them as always-on and they cannot be unchecked through
  // the UI at all), while the "Gepersonaliseerd" category's checkboxes are
  // present, NOT disabled, and unchecked by default. The two action buttons
  // ("Alles accepteren" / "Zelf instellen") live outside the <form> element
  // itself but are wired to it via the HTML5 form="..." attribute, each with
  // a distinct name="accept_cookie" value ("all_categories" vs "selection").
  function domFixture() {
    return domWithBody(`
      <form id="cookie-banner-2025-form" action="/melding-sluiten" method="POST">
        <div id="cookie-explanation">uses cookies</div>
        <input id="cookie-category-standard" type="checkbox" checked disabled>
        <input type="checkbox" value="ga" checked disabled name="cookie_setting[]">
        <input id="cookie-category-personalized" type="checkbox" name="cookie_setting[]">
        <input type="checkbox" value="ma" name="cookie_setting[]">
        <input type="checkbox" value="fb" name="cookie_setting[]">
      </form>
      <div>
        <button form="cookie-banner-2025-form" type="submit" name="accept_cookie" value="all_categories">Alles accepteren</button>
        <button form="cookie-banner-2025-form" type="submit" name="accept_cookie" value="selection">Zelf instellen</button>
      </div>
    `);
  }

  test('detect matches the minimal live-shaped DOM', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'coolblue_cookie_banner');
  });

  test('flow unchecks every non-disabled checkbox and submits via the "selection" button, never the "all_categories" one', async () => {
    const cmp = findCmp('coolblue_cookie_banner');
    const document = domFixture();
    // Simulate a visit where the personalized checkboxes came back pre-checked
    // (e.g. a stale consent cookie) - the flow must still turn them off.
    document.querySelectorAll('#cookie-category-personalized, [name="cookie_setting[]"]:not(:disabled)')
      .forEach((el) => { el.checked = true; });

    let acceptAllClicked = false;
    let selectionClicked = false;
    document.querySelector('[value="all_categories"]').addEventListener('click', () => { acceptAllClicked = true; });
    document.querySelector('[value="selection"]').addEventListener('click', () => { selectionClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(selectionClicked, true, 'expected the "Zelf instellen" (selection) submit button to be clicked');
    assert.equal(acceptAllClicked, false, 'the flow must never click "Alles accepteren" (all_categories)');
    assert.equal(document.querySelector('#cookie-category-personalized').checked, false);
    document.querySelectorAll('[name="cookie_setting[]"]:not(:disabled)').forEach((el) => {
      assert.equal(el.checked, false, `expected ${el.value} to be unchecked`);
    });
    // The disabled, always-on "Standaard" bucket must be left alone (nothing
    // in the flow's selector can reach a :disabled checkbox anyway, but this
    // pins the intent down as a regression guard).
    assert.equal(document.querySelector('#cookie-category-standard').checked, true);
  });
});

describe('Skyscanner in-house consent banner (skyscanner_consent_banner)', () => {
  // Live markup (skyscanner.net, en-GB): container div#consentBannerContent,
  // an "Accept all" button (id="acceptCookieButton", never referenced by
  // this rule) and a second button displayed as "Accept essential only" but
  // carrying a self-describing, build-independent data-testid,
  // "consentBannerRejectAll" - confirmed live via the attribute chain, not
  // the (CSS-module-hashed, per-build) class names sitting alongside it.
  function domFixture() {
    return domWithBody(`
      <div id="consentBannerContent" role="dialog" aria-labelledby="x">
        <button id="acceptCookieButton" data-testid="consentBannerAcceptAll">Accept all</button>
        <button data-testid="consentBannerRejectAll">Accept essential only</button>
      </div>
    `);
  }

  test('detect matches the minimal live-shaped DOM', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'skyscanner_consent_banner');
  });

  test('flow clicks the data-testid=consentBannerRejectAll button, never #acceptCookieButton', async () => {
    const cmp = findCmp('skyscanner_consent_banner');
    const document = domFixture();
    let acceptClicked = false;
    let rejectClicked = false;
    document.querySelector('#acceptCookieButton').addEventListener('click', () => { acceptClicked = true; });
    document.querySelector('[data-testid="consentBannerRejectAll"]').addEventListener('click', () => { rejectClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false, 'the flow must never click the "Accept all" button, even though it renders first in DOM order');
  });
});

describe('Google Funding Choices (google_funding_choices) - techcrunch.com', () => {
  // Live markup (techcrunch.com): light DOM, container class .fc-consent-root,
  // three first-layer buttons distinguished by Google's own stable class
  // naming (fc-cta-consent / fc-cta-do-not-consent / fc-cta-manage-options),
  // never by the numeric id on the loader <script> (id="cookieBanner-242234635"
  // in this session, confirmed to change per instance - never referenced here).
  function domFixture() {
    return domWithBody(`
      <div id="cookieBanner-242234635"></div>
      <div class="fc-consent-root">
        <button class="fc-button fc-cta-consent fc-primary-button">Consent</button>
        <button class="fc-button fc-cta-do-not-consent fc-secondary-button">Do not consent</button>
        <button class="fc-button fc-cta-manage-options">Manage options</button>
      </div>
    `);
  }

  test('detect matches on the stable class names, not the numeric cookieBanner-NNNNNN id', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'google_funding_choices');
  });

  test('flow clicks fc-cta-do-not-consent, never fc-cta-consent', async () => {
    const cmp = findCmp('google_funding_choices');
    const document = domFixture();
    let consentClicked = false;
    let doNotConsentClicked = false;
    document.querySelector('.fc-cta-consent').addEventListener('click', () => { consentClicked = true; });
    document.querySelector('.fc-cta-do-not-consent').addEventListener('click', () => { doNotConsentClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(doNotConsentClicked, true);
    assert.equal(consentClicked, false);
  });
});

describe('Intesa Sanpaolo in-house cookie message (intesasanpaolo_cookie_message) - the cookie-allowed/cookie-denied trap', () => {
  // Live markup (intesasanpaolo.com, it-IT): despite the ids, NEITHER
  // #cookie-allowed ("Acconsento" - accept) NOR #cookie-denied /
  // #cookie-denied-desktop ("Più opzioni" - a mere link to a separate
  // settings page, not a refusal of anything) is the actual refusal
  // control. The page's own hidden disclosure text states the real
  // mechanism explicitly: closing the banner via #cookie-chiudi (the "X"
  // button) is what registers non-consent to profiling cookies. This test
  // fixture reproduces the full trap, not a simplified version of it.
  function domFixture() {
    return domWithBody(`
      <div class="ga-content js-cookie-message cookie-message">
        <button id="cookie-chiudi" class="btn-close"></button>
        <div class="cookie-message-warning">
          Cliccando sulla [x] di chiusura del banner, non acconsenti all'uso dei cookie di profilazione.
        </div>
        <div id="cookie-allowed" class="btn-isp-green btn-isp25">
          <button title="Acconsento" class="cookie-button"><span class="btn-text">Acconsento</span></button>
        </div>
        <div id="cookie-denied" class="btn-isp-white-g btn-isp25">
          <a href="/content/vetrina/it/common/footer/cookies.html" title="Più opzioni"><span class="btn-text">Più opzioni</span></a>
        </div>
        <div id="cookie-denied-desktop" class="btn-isp-green btn-isp25">
          <a href="/content/vetrina/it/common/footer/cookies.html" title="Più opzioni"><span class="btn-text">Più opzioni</span></a>
        </div>
        <div id="cookie-allowed-desktop" class="btn-isp-green btn-isp25">
          <button title="Acconsento" class="cookie-button"><span class="btn-text">Acconsento</span></button>
        </div>
      </div>
    `);
  }

  test('detect matches the minimal live-shaped DOM', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'intesasanpaolo_cookie_message');
  });

  test('flow clicks #cookie-chiudi only - never #cookie-allowed(-desktop), never treats #cookie-denied(-desktop) as a refusal or follows its link', async () => {
    const cmp = findCmp('intesasanpaolo_cookie_message');
    const document = domFixture();
    const clicks = { chiudi: false, allowed: false, allowedDesktop: false, denied: false, deniedDesktop: false };
    document.querySelector('#cookie-chiudi').addEventListener('click', () => { clicks.chiudi = true; });
    document.querySelector('#cookie-allowed').addEventListener('click', () => { clicks.allowed = true; });
    document.querySelector('#cookie-allowed-desktop').addEventListener('click', () => { clicks.allowedDesktop = true; });
    document.querySelector('#cookie-denied').addEventListener('click', () => { clicks.denied = true; });
    document.querySelector('#cookie-denied-desktop').addEventListener('click', () => { clicks.deniedDesktop = true; });

    await runFlow(cmp.flow, document);

    assert.equal(clicks.chiudi, true, 'expected #cookie-chiudi (the actual refusal mechanism per the page\'s own disclosure) to be clicked');
    assert.equal(clicks.allowed, false);
    assert.equal(clicks.allowedDesktop, false);
    assert.equal(clicks.denied, false, 'the flow must never treat #cookie-denied as clickable - it is a "More options" link, not a refusal');
    assert.equal(clicks.deniedDesktop, false);
  });
});

describe('Skroutz in-house cookie message (skroutz_cookie_message) - the accept-all/accept-essential naming trap', () => {
  // Live markup (skroutz.gr, el-GR): the actual first-layer refusal button
  // carries the id "accept-essential" (misleadingly named, as if it meant
  // "accept only essential cookies") but its real, displayed text is
  // "Δε συμφωνώ" ("I do not agree") - an unambiguous refusal. The genuine
  // accept button, confusingly, carries the id "accept-all" AND the text
  // "Συμφωνώ" ("I agree"). The flow is anchored on the confirmed Greek
  // wording via textMatchRef, scoped to the message container, precisely so
  // it keeps working even if a future deploy swaps which id maps to which
  // button - not on the (confusingly named, in-house, changeable) ids.
  function domFixture() {
    return domWithBody(`
      <div class="js-message skrppp">
        <div class="js-global-skrp-messages">
          <button id="accept-all" class="btn-outlined btn-transparent">Συμφωνώ</button>
          <button class="btn-link customize js-more-info-button">Προσαρμογή</button>
          <button id="accept-essential" class="btn-outlined btn-transparent">Δε συμφωνώ</button>
          <button class="icon cookie-group js-cookie-group">Αναγκαία</button>
          <button id="save-selection" class="btn-outlined btn-transparent">Αποθήκευση επιλογών</button>
          <button id="accept-all-cookies" class="btn-white">Αποδοχή όλων</button>
        </div>
      </div>
    `);
  }

  test('detect matches the minimal live-shaped DOM', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'skroutz_cookie_message');
  });

  test('flow clicks the button whose text is "Δε συμφωνώ" (#accept-essential), never #accept-all ("Συμφωνώ") or #accept-all-cookies', async () => {
    const cmp = findCmp('skroutz_cookie_message');
    const document = domFixture();
    const clicks = { acceptAll: false, acceptEssential: false, acceptAllCookies: false, saveSelection: false };
    document.querySelector('#accept-all').addEventListener('click', () => { clicks.acceptAll = true; });
    document.querySelector('#accept-essential').addEventListener('click', () => { clicks.acceptEssential = true; });
    document.querySelector('#accept-all-cookies').addEventListener('click', () => { clicks.acceptAllCookies = true; });
    document.querySelector('#save-selection').addEventListener('click', () => { clicks.saveSelection = true; });

    await runFlow(cmp.flow, document);

    assert.equal(clicks.acceptEssential, true, 'expected the "Δε συμφωνώ" (I do not agree) button to be clicked, despite its misleading id "accept-essential"');
    assert.equal(clicks.acceptAll, false, 'must never click #accept-all ("Συμφωνώ" / I agree), despite its id containing "accept-essential"-like wording nowhere near it');
    assert.equal(clicks.acceptAllCookies, false);
    assert.equal(clicks.saveSelection, false);
  });

  test('adversarial: if the id naming were swapped in a future deploy, the textMatchRef anchor would still find the correct button by wording, not by id', async () => {
    const cmp = findCmp('skroutz_cookie_message');
    const document = domWithBody(`
      <div class="js-global-skrp-messages">
        <button id="accept-essential">Συμφωνώ</button>
        <button id="accept-all">Δε συμφωνώ</button>
      </div>
    `);
    let idAcceptEssentialClicked = false;
    let idAcceptAllClicked = false;
    document.querySelector('#accept-essential').addEventListener('click', () => { idAcceptEssentialClicked = true; });
    document.querySelector('#accept-all').addEventListener('click', () => { idAcceptAllClicked = true; });

    await runFlow(cmp.flow, document);

    // The id named "accept-all" now carries the refusal text - the flow must
    // follow the wording, not the id.
    assert.equal(idAcceptAllClicked, true);
    assert.equal(idAcceptEssentialClicked, false);
  });
});

describe('CookieFirst (cookiefirst)', () => {
  // Live markup (cookiefirst.com): light DOM, class="cookiefirst-root" (a
  // real, stable vendor class - not build-hashed, unlike the surrounding
  // "cf1Fw5"/"cf2Lf6"-style classes on the individual buttons, which ARE
  // per-build hashes and are never referenced here). Every action button
  // carries a stable, self-describing pair of attributes instead:
  // data-testid="actionButton-reject" and data-cookiefirst-action="reject".
  function domFixture() {
    return domWithBody(`
      <div class="cookiefirst-root" data-testid="rootContainer">
        <button data-testid="actionButton-accept" data-cookiefirst-action="accept" class="cf2Lf6 cf8Oal">Accept</button>
        <button data-testid="actionButton-adjust" data-cookiefirst-action="adjust" class="cf2Lf6 cf8Oal">Adjust</button>
        <button data-testid="actionButton-reject" data-cookiefirst-action="reject" class="cf2Lf6 cf8Oal">Deny</button>
      </div>
    `);
  }

  test('detect matches the minimal live-shaped DOM', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'cookiefirst');
  });

  test('flow clicks data-cookiefirst-action="reject", never the accept or adjust buttons', async () => {
    const cmp = findCmp('cookiefirst');
    const document = domFixture();
    const clicks = { accept: false, adjust: false, reject: false };
    document.querySelector('[data-cookiefirst-action="accept"]').addEventListener('click', () => { clicks.accept = true; });
    document.querySelector('[data-cookiefirst-action="adjust"]').addEventListener('click', () => { clicks.adjust = true; });
    document.querySelector('[data-cookiefirst-action="reject"]').addEventListener('click', () => { clicks.reject = true; });

    await runFlow(cmp.flow, document);

    assert.equal(clicks.reject, true);
    assert.equal(clicks.accept, false);
    assert.equal(clicks.adjust, false);
  });
});

describe('Secure Privacy (secureprivacy)', () => {
  // Live markup (secureprivacy.ai): renders inside a same-origin `srcdoc`
  // iframe (not cross-origin - reachable the same way the rest of this
  // project's frame-based rules already are, one independent detect+flow
  // per frame). The first layer carries stable, semantic ids
  // (#sp-accept/#sp-decline/#sp-customize) plus a self-describing
  // data-sp-onclick attribute confirming the exact behaviour
  // ("sp.saveAllConsents('declineAll', 'cb')" for #sp-decline).
  function domFixture() {
    return domWithBody(`
      <button id="sp-accept" class="btn" data-sp-onclick="sp.saveAllConsents('acceptAll', 'cb')">Accept</button>
      <button id="sp-decline" class="btn" data-sp-onclick="sp.saveAllConsents('declineAll', 'cb')">Decline</button>
      <button id="sp-customize" class="btn btn--bg--transparent btn--border ml-auto" data-sp-onclick="sp.openPreferenceCenter()">Customize</button>
    `);
  }

  test('detect matches the minimal live-shaped DOM', () => {
    const document = domFixture();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'secureprivacy');
  });

  test('flow clicks #sp-decline, never #sp-accept', async () => {
    const cmp = findCmp('secureprivacy');
    const document = domFixture();
    let acceptClicked = false;
    let declineClicked = false;
    document.querySelector('#sp-accept').addEventListener('click', () => { acceptClicked = true; });
    document.querySelector('#sp-decline').addEventListener('click', () => { declineClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(declineClicked, true);
    assert.equal(acceptClicked, false);
  });
});
