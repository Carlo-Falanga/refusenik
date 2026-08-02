/**
 * Behavioural coverage for the seven CMP entries added/repaired in this
 * session (src/rules/NOTE.md, "Quantcast Choice, Sourcepoint, Complianz,
 * CookieYes, Commanders Act, Sirdata, Usercentrics"): quantcast, sourcepoint,
 * complianz, cookieyes, commandersact, sirdata, usercentrics.
 *
 * For each actionable entry: a `detect` test against a minimal representative
 * DOM, and a flow test asserting the expected reject/necessary-only button is
 * clicked. For the two `kind: "consentOrPay"` siblings (quantcast, sourcepoint),
 * a test that the wall is recognised but never acted on.
 *
 * The most important test here is the Sirdata adversarial case (code review
 * fix): the positional, textMatch-less fallback that used to sit at the end
 * of the Sirdata flow has been removed (src/rules/NOTE.md) precisely because
 * nothing guarantees the reject button is first in DOM order on every
 * tenant. This file proves the fixed flow does not fall back to clicking
 * whatever button happens to be first.
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

async function clickTargetWithListener(document, selectorCss) {
  const el = document.querySelector(selectorCss);
  assert.ok(el, `expected an element matching ${selectorCss} in the test DOM`);
  let clicked = false;
  el.addEventListener('click', () => { clicked = true; });
  return () => clicked;
}

describe('Quantcast Choice CMP2 (quantcast)', () => {
  test('detect matches a minimal qc-cmp2 DOM', () => {
    const document = domWithBody(`
      <div class="qc-cmp2-container">
        <div class="qc-cmp2-main">
          <button id="disagree-btn">Rifiuta</button>
        </div>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'quantcast');
  });

  test('flow clicks the direct decline button (#disagree-btn) when the first layer offers it', async () => {
    const cmp = findCmp('quantcast');
    const document = domWithBody(`
      <div class="qc-cmp2-container">
        <div class="qc-cmp2-main">
          <button id="disagree-btn">Rifiuta</button>
        </div>
      </div>
    `);
    const wasClicked = await clickTargetWithListener(document, '#disagree-btn');
    await runFlow(cmp.flow, document);
    assert.equal(wasClicked(), true);
  });

  test('quantcast_consent_or_pay: the pay-to-reject variant is recognised but its flow is never executed', async () => {
    // Same widget, plus the .pp-pay marker Reach plc's deployment adds -
    // priority 20 must win the tie over generic quantcast's priority 10.
    const document = domWithBody(`
      <div class="qc-cmp2-container">
        <div class="qc-cmp2-main">
          <button id="disagree-btn">Reject and Pay</button>
        </div>
        <button class="pp-pay">Reject and Pay</button>
      </div>
    `);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'quantcast_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
    assert.deepEqual(cmp.flow, []);
    assert.equal(isActionableKind(cmp.kind), false);

    let clicked = false;
    document.querySelector('#disagree-btn').addEventListener('click', () => { clicked = true; });

    // Mirrors content.js's own gate: runFlow only ever runs behind isActionableKind().
    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);
    assert.equal(clicked, false, 'a consentOrPay entry must never click anything, even a button that exists in its DOM');
  });
});

describe('Sourcepoint', () => {
  test('detect matches a minimal message-container DOM with a genuine reject choice', () => {
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_13">I do not agree</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'sourcepoint');
  });

  test('flow clicks the sp_choice_type_13 reject button', async () => {
    const cmp = findCmp('sourcepoint');
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_13">I do not agree</button>
      </div>
    `);
    const wasClicked = await clickTargetWithListener(document, '.sp_choice_type_13');
    await runFlow(cmp.flow, document);
    assert.equal(wasClicked(), true);
  });

  test('sourcepoint_consent_or_pay: a Pur-Abo wall (sp_choice_type_9, no sp_choice_type_13 anywhere) is recognised but never acted on', async () => {
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_9">Jetzt abonnieren</button>
      </div>
    `);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'sourcepoint_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
    assert.deepEqual(cmp.flow, []);
    assert.equal(isActionableKind(cmp.kind), false);

    let clicked = false;
    document.querySelector('.sp_choice_type_9').addEventListener('click', () => { clicked = true; });

    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);
    assert.equal(clicked, false);
  });
});

describe('Sourcepoint (sourcepoint_manage_reject: no direct reject in the first layer, real reject behind Options/Personalizza)', () => {
  test('detect matches a first layer with only Options/Personalizza (sp_choice_type_12) and Agree (sp_choice_type_11), no sp_choice_type_13', () => {
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_12">Personalizzare i cookie</button>
        <button class="sp_choice_type_11">Sì, sono soddisfatto</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'sourcepoint_manage_reject');
  });

  test('flow opens Options/Personalizza (sp_choice_type_12) and never clicks Agree/Accept when no direct reject exists yet', async () => {
    const cmp = findCmp('sourcepoint_manage_reject');
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_12">Personalizzare i cookie</button>
        <button class="sp_choice_type_11">Sì, sono soddisfatto</button>
      </div>
    `);
    let manageClicked = false;
    let agreeClicked = false;
    document.querySelector('.sp_choice_type_12').addEventListener('click', () => { manageClicked = true; });
    document.querySelector('.sp_choice_type_11').addEventListener('click', () => { agreeClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(manageClicked, true, 'expected the flow to open Options/Personalizza (sp_choice_type_12)');
    assert.equal(agreeClicked, false, 'the flow must never click the Agree/Accept button (sp_choice_type_11)');
  });

  test('flow clicks the genuine reject-all button directly when this frame already is the privacy-manager second layer (sp_choice_type_REJECT_ALL, no sp_choice_type_12 here)', async () => {
    // Mirrors what tools/verify-rules.mjs actually observed live on calciomercato.com
    // and sourcepoint.com: the privacy-manager panel opened by sp_choice_type_12
    // renders in a SEPARATE iframe with its own document, which - because the
    // extension's content script runs in every frame - gets its own independent
    // detect+flow run against exactly this shape of DOM.
    const cmp = findCmp('sourcepoint_manage_reject');
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_REJECT_ALL">Rifiuta tutto</button>
        <button class="sp_choice_type_SAVE_AND_EXIT">Conferma le mie scelte</button>
        <button class="sp_choice_type_ACCEPT_ALL">Accetta Tutto</button>
      </div>
    `);
    let rejectClicked = false;
    let acceptClicked = false;
    document.querySelector('.sp_choice_type_REJECT_ALL').addEventListener('click', () => { rejectClicked = true; });
    document.querySelector('.sp_choice_type_ACCEPT_ALL').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false, 'the flow must never click Accept All, even though it shares no distinguishing wrapper with Reject All');
  });

  test('adversarial: when a Pur-Abo consent-or-pay marker (sp_choice_type_9) is also present, sourcepoint_consent_or_pay must win the priority tie, not sourcepoint_manage_reject', () => {
    // A hypothetical deployment offering both an Options/Personalizza button
    // AND the Pur-Abo third-choice marker in the same first layer must never
    // let the lower-priority, generically-actionable entry win: doing so would
    // silently reclassify a real consent-or-pay wall as "we tried to refuse
    // it", instead of correctly recognising it and doing nothing.
    const document = domWithBody(`
      <div class="message-container">
        <button class="sp_choice_type_12">Einstellungen</button>
        <button class="sp_choice_type_9">Jetzt abonnieren</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'sourcepoint_consent_or_pay');
    assert.equal(isActionableKind(cmp.kind), false);
  });
});

describe('Complianz', () => {
  test('detect matches a minimal cmplz-cookiebanner DOM', () => {
    const document = domWithBody(`
      <div class="cmplz-cookiebanner">
        <button class="cmplz-btn cmplz-deny">Deny</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'complianz');
  });

  test('flow clicks the direct deny button', async () => {
    const cmp = findCmp('complianz');
    const document = domWithBody(`
      <div class="cmplz-cookiebanner">
        <button class="cmplz-btn cmplz-deny">Deny</button>
      </div>
    `);
    const wasClicked = await clickTargetWithListener(document, '.cmplz-btn.cmplz-deny');
    await runFlow(cmp.flow, document);
    assert.equal(wasClicked(), true);
  });
});

describe('CookieYes', () => {
  test('detect matches a minimal cky-consent-container DOM', () => {
    const document = domWithBody(`
      <div class="cky-consent-container">
        <button class="cky-btn cky-btn-reject">Reject All</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'cookieyes');
  });

  test('flow clicks the direct reject button', async () => {
    const cmp = findCmp('cookieyes');
    const document = domWithBody(`
      <div class="cky-consent-container">
        <button class="cky-btn cky-btn-reject">Reject All</button>
      </div>
    `);
    const wasClicked = await clickTargetWithListener(document, '.cky-btn.cky-btn-reject');
    await runFlow(cmp.flow, document);
    assert.equal(wasClicked(), true);
  });
});

describe('Commanders Act / TagCommander (commandersact)', () => {
  test('detect matches a minimal popin_tc_privacy DOM alongside the confirmed #tc-privacy-wrapper marker', () => {
    const document = domWithBody(`
      <div id="tc-privacy-wrapper">
        <div id="popin_tc_privacy">
          <button id="popin_tc_privacy_button_3">Continuer sans accepter</button>
        </div>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'commandersact');
  });

  test('flow clicks the necessary-only button, matched by wording rather than by its (per-publisher, unstable) numeric id', async () => {
    const cmp = findCmp('commandersact');
    // bouyguestelecom.fr / credit-agricole.fr wording, confirmed live (NOTE.md).
    const document = domWithBody(`
      <div id="tc-privacy-wrapper">
        <div id="popin_tc_privacy">
          <button id="popin_tc_privacy_button_1">Tout accepter</button>
          <button id="popin_tc_privacy_button_3">Continuer sans accepter</button>
        </div>
      </div>
    `);

    let acceptClicked = false;
    let necessaryOnlyClicked = false;
    document.querySelector('#popin_tc_privacy_button_1').addEventListener('click', () => { acceptClicked = true; });
    document.querySelector('#popin_tc_privacy_button_3').addEventListener('click', () => { necessaryOnlyClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(necessaryOnlyClicked, true, 'the "Continuer sans accepter" button must be clicked');
    assert.equal(acceptClicked, false, 'the accept button must never be clicked');
  });
});

describe('Sirdata', () => {
  test('detect matches #sd-cmp together with the confirmed #__abconsent-cmp parent marker', () => {
    const document = domWithBody(`
      <div id="__abconsent-cmp">
        <div id="sd-cmp">
          <button class="sd-cmp-abc123">Continuer sans accepter</button>
        </div>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'sirdata');
  });

  test('flow clicks the necessary-only/reject button when it carries recognised wording', async () => {
    const cmp = findCmp('sirdata');
    const document = domWithBody(`
      <div id="__abconsent-cmp">
        <div id="sd-cmp">
          <button class="sd-cmp-abc123">Continuer sans accepter</button>
        </div>
      </div>
    `);
    const wasClicked = await clickTargetWithListener(document, '#sd-cmp button');
    await runFlow(cmp.flow, document);
    assert.equal(wasClicked(), true);
  });

  test('ADVERSARIAL (code review fix): the first <button> under #sd-cmp is an ACCEPT button; the flow must never click it, and must click the later reject button instead', async () => {
    const cmp = findCmp('sirdata');
    // All three buttons deliberately share the same hashed class, exactly as
    // observed live on sirdata.com/01net.com (src/rules/NOTE.md) - class
    // alone cannot distinguish them, and DOM order here is intentionally
    // accept-first to prove the removed positional fallback would have
    // clicked the wrong one.
    const document = domWithBody(`
      <div id="__abconsent-cmp">
        <div id="sd-cmp">
          <button class="sd-cmp-7Ga7b">Accept and close</button>
          <button class="sd-cmp-7Ga7b">Customise</button>
          <button class="sd-cmp-7Ga7b">Do not accept</button>
        </div>
      </div>
    `);

    const buttons = document.querySelectorAll('#sd-cmp button');
    assert.equal(buttons[0].textContent, 'Accept and close', 'sanity check: the accept button really is first in DOM order');

    let acceptClicked = false;
    let customiseClicked = false;
    let rejectClicked = false;
    buttons[0].addEventListener('click', () => { acceptClicked = true; });
    buttons[1].addEventListener('click', () => { customiseClicked = true; });
    buttons[2].addEventListener('click', () => { rejectClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(acceptClicked, false, 'the flow must never click the first button just because it is first - it must match by wording');
    assert.equal(customiseClicked, false);
    assert.equal(rejectClicked, true, 'the "Do not accept" button must be the one clicked');
  });

  test('Italian wording ("Non accettare") is also matched, without falling back to position', async () => {
    const cmp = findCmp('sirdata');
    const document = domWithBody(`
      <div id="__abconsent-cmp">
        <div id="sd-cmp">
          <button class="sd-cmp-xyz">Accetta tutti i cookie</button>
          <button class="sd-cmp-xyz">Non accettare</button>
        </div>
      </div>
    `);
    const buttons = document.querySelectorAll('#sd-cmp button');
    let acceptClicked = false;
    let rejectClicked = false;
    buttons[0].addEventListener('click', () => { acceptClicked = true; });
    buttons[1].addEventListener('click', () => { rejectClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(acceptClicked, false);
    assert.equal(rejectClicked, true);
  });

  test('no textMatch-less positional fallback step remains in the shipped flow', () => {
    const cmp = rules.cmps.find((c) => c.id === 'sirdata');
    const untextedClickSteps = cmp.flow.filter((step) => (
      step.action === 'click'
      && step.selector
      && !('textMatch' in step.selector)
      && !('textMatchRef' in step.selector)
    ));
    assert.deepEqual(untextedClickSteps, [], 'every click step in the Sirdata flow must be gated by a textMatch/textMatchRef - no blind positional click');
  });

  test('when neither semantic step matches (unrecognised wording), the flow clicks nothing at all - correct behaviour per README\'s design principle', async () => {
    const cmp = findCmp('sirdata');
    const document = domWithBody(`
      <div id="__abconsent-cmp">
        <div id="sd-cmp">
          <button class="sd-cmp-zzz">Some Unrecognised Wording</button>
        </div>
      </div>
    `);
    let clicked = false;
    document.querySelector('#sd-cmp button').addEventListener('click', () => { clicked = true; });

    const results = await runFlow(cmp.flow, document);

    assert.equal(clicked, false);
    assert.ok(results.every((r) => r.ok === false), 'every step should report not-found rather than a fallback succeeding');
  });
});

describe('Usercentrics v3 (shadow DOM)', () => {
  function domWithOpenShadowDenyButton() {
    const document = domWithBody('');
    const host = document.createElement('div');
    host.id = 'usercentrics-root';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const denyButton = document.createElement('button');
    denyButton.setAttribute('data-testid', 'uc-deny-all-button');
    denyButton.textContent = 'Reject All';
    shadow.appendChild(denyButton);
    const acceptButton = document.createElement('button');
    acceptButton.setAttribute('data-testid', 'uc-accept-all-button');
    acceptButton.textContent = 'Accept All';
    shadow.appendChild(acceptButton);
    return { document, denyButton, acceptButton };
  }

  test('detect matches an open shadow root host exposing the deny-all button via shadowPath', () => {
    const { document } = domWithOpenShadowDenyButton();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'usercentrics');
  });

  test('flow clicks the deny-all button inside the open shadow root, never the accept button', async () => {
    const cmp = findCmp('usercentrics');
    const { document, denyButton, acceptButton } = domWithOpenShadowDenyButton();

    let denyClicked = false;
    let acceptClicked = false;
    denyButton.addEventListener('click', () => { denyClicked = true; });
    acceptButton.addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(denyClicked, true);
    assert.equal(acceptClicked, false);
  });
});

/**
 * The four CMP families added in this session (src/rules/NOTE.md, "second
 * sweep of 393 real sites"): ConsentManager (two rendering variants),
 * MediaMarkt/Saturn's in-house PWA consent layer, the two genuinely distinct
 * Polish/Romanian "cookie-consent" implementations, and the Usercentrics
 * class-based button variant that repairs the ten-site gap in the existing
 * `usercentrics` entry.
 */

describe('ConsentManager (consentmanager.net) - shadow-DOM rendering', () => {
  function domWithShadowConsentManager({ withDirectReject = true } = {}) {
    const document = domWithBody('');
    const host = document.createElement('div');
    host.id = 'cmpwrapper';
    host.className = 'cmpwrapper';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <div id="cmpbox" class="cmpbox cmpstyleroot cmpbox3 cmpboxWelcomeGDPR cmpBoxWelcomeOI">
        <div id="cmpboxcontent" class="cmpboxcontent"></div>
        <div class="cmpboxbtns">
          <span id="cmpwelcomebtnyes"><a class="cmpboxbtn cmpboxbtnyes cmptxt_btn_yes">Accept all</a></span>
          ${withDirectReject ? '<span id="cmpwelcomebtnno"><a class="cmpboxbtn cmpboxbtnno cmptxt_btn_no">Reject all</a></span>' : ''}
          <span id="cmpwelcomebtncustom"><a class="cmpboxbtn cmpboxbtncustom cmptxt_btn_settings">Customize</a></span>
        </div>
      </div>
    `;
    return { document, shadow };
  }

  test('detect matches the shadow-DOM #cmpwrapper host via shadowPath', () => {
    const { document } = domWithShadowConsentManager();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'consentmanager');
  });

  test('flow clicks the direct #cmpwelcomebtnno reject button when the first layer offers it (consentmanager.net, vodafone.it, wallapop.com wording)', async () => {
    const cmp = findCmp('consentmanager');
    const { document, shadow } = domWithShadowConsentManager({ withDirectReject: true });

    let rejectClicked = false;
    let acceptClicked = false;
    shadow.querySelector('.cmpboxbtnno').addEventListener('click', () => { rejectClicked = true; });
    shadow.querySelector('.cmpboxbtnyes').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false);
  });

  test('when no direct reject is offered (nzz.ch), the flow opens settings and clicks the second-layer reject button, never the accept button', async () => {
    const cmp = findCmp('consentmanager');
    const { document, shadow } = domWithShadowConsentManager({ withDirectReject: false });

    let acceptClicked = false;
    let rejectClicked = false;

    // Simulate the second layer that "Customize" reveals: clicking the
    // custom-choices link swaps in the reject/accept/save trio observed live
    // (src/rules/NOTE.md), all sharing the *customchoices button family.
    // Listeners are wired up in the same tick the elements are created, so the
    // flow's own subsequent waitFor/click steps (run against this same live
    // DOM, not a re-run) are what gets observed.
    shadow.querySelector('.cmpboxbtncustom').addEventListener('click', () => {
      const btns = shadow.querySelector('.cmpboxbtns');
      btns.innerHTML = `
        <a class="cmpboxbtn cmpboxbtnaccept cmpboxbtnacceptcustomchoices cmptxt_btn_yes">Alle Anbieter akzeptieren</a>
        <a class="cmpboxbtn cmpboxbtnreject cmpboxbtnrejectcustomchoices cmptxt_btn_no">Alle Anbieter ablehnen</a>
        <a class="cmpboxbtn cmpboxbtnyes cmpboxbtnyescustomchoices cmptxt_btn_save">Einstellungen speichern und beenden</a>
      `;
      shadow.querySelector('.cmpboxbtnaccept').addEventListener('click', () => { acceptClicked = true; });
      shadow.querySelector('.cmpboxbtnreject').addEventListener('click', () => { rejectClicked = true; });
    });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true, 'the second-layer "Alle Anbieter ablehnen" reject button must be clicked');
    assert.equal(acceptClicked, false, 'the accept button must never be clicked');
  });
});

describe('ConsentManager (consentmanager.net) - light-DOM rendering (chefkoch.de)', () => {
  function domWithLightConsentManager() {
    return domWithBody(`
      <div id="cmpbox2" class="cmpboxBG cmpstyleroot"></div>
      <div id="cmpbox" class="cmpbox cmpstyleroot cmpbox3 cmpboxWelcomeGDPR cmpBoxWelcomeOI cmpnotransition">
        <div id="cmpboxcontent" class="cmpboxcontent"></div>
        <div class="cmpboxbtns">
          <span id="cmpwelcomebtnyes"><a class="cmpboxbtn cmpboxbtnyes cmptxt_btn_yes">Allen Zwecken zustimmen</a></span>
          <span id="cmpwelcomebtncustom"><a class="cmpboxbtn cmpboxbtncustom cmptxt_btn_settings">Einstellungen</a></span>
        </div>
      </div>
    `);
  }

  test('detect matches the light-DOM #cmpbox without any shadow host present', () => {
    const document = domWithLightConsentManager();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'consentmanager_light_dom');
  });

  test('with no direct reject in the first layer, the flow opens settings ("Einstellungen") and clicks the second-layer "Zustimmung widerrufen" reject button', async () => {
    const cmp = findCmp('consentmanager_light_dom');
    const document = domWithLightConsentManager();

    let acceptClicked = false;
    let rejectClicked = false;

    document.querySelector('.cmpboxbtncustom').addEventListener('click', () => {
      const btns = document.querySelector('.cmpboxbtns');
      btns.innerHTML = `
        <a class="cmpboxbtn cmpboxbtnaccept cmpboxbtnacceptcustomchoices cmptxt_btn_yes">Allen Zwecken zustimmen</a>
        <a class="cmpboxbtn cmpboxbtnreject cmpboxbtnrejectcustomchoices cmptxt_btn_no">Zustimmung widerrufen</a>
        <a class="cmpboxbtn cmpboxbtnyes cmpboxbtnyescustom cmpboxbtnyescustomdisabled">Auswahl speichern</a>
      `;
      document.querySelector('.cmpboxbtnaccept').addEventListener('click', () => { acceptClicked = true; });
      document.querySelector('.cmpboxbtnreject').addEventListener('click', () => { rejectClicked = true; });
    });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true, 'the second-layer "Zustimmung widerrufen" reject button must be clicked');
    assert.equal(acceptClicked, false, 'the accept button must never be clicked by the shipped flow');
  });

  test('does not detect on a page that only has the shadow-DOM #cmpwrapper host (no light-DOM #cmpbox)', () => {
    const document = domWithBody('');
    const host = document.createElement('div');
    host.id = 'cmpwrapper';
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' });
    const cmp = rules.cmps.find((c) => c.id === 'consentmanager_light_dom');
    const detectAllMatch = cmp.detect.every((selector) => {
      try {
        return document.querySelector(selector.css) !== null;
      } catch {
        return false;
      }
    });
    assert.equal(detectAllMatch, false);
  });
});

describe('MediaMarkt/Saturn in-house PWA consent layer (mms_pwa_consent_layer)', () => {
  function domWithMmsConsentLayer() {
    return domWithBody(`
      <div id="mms-consent-portal-container">
        <div class="pwa-consent-modal-wrapper">
          <form id="pwa-consent-layer-form">
            <button id="pwa-consent-layer-deny-all-button">Rifiuta tutti</button>
            <button id="pwa-consent-layer-accept-all-button">Accetta tutti</button>
          </form>
        </div>
      </div>
    `);
  }

  test('detect matches the container together with the confirmed direct deny-all button', () => {
    const document = domWithMmsConsentLayer();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'mms_pwa_consent_layer');
  });

  test('flow clicks the direct deny-all button, confirmed live on mediaworld.it/mediamarkt.de/saturn.de/mediamarkt.es despite the brief\'s automated sweep reporting no refusal offered', async () => {
    const cmp = findCmp('mms_pwa_consent_layer');
    const document = domWithMmsConsentLayer();

    let denyClicked = false;
    let acceptClicked = false;
    document.querySelector('#pwa-consent-layer-deny-all-button').addEventListener('click', () => { denyClicked = true; });
    document.querySelector('#pwa-consent-layer-accept-all-button').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(denyClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('WP Holding in-house cookie consent widget (wp.pl, ceneo.pl) - wpholding_cookie_consent', () => {
  function domWithWpHoldingBanner() {
    return domWithBody(`
      <div id="js_cookie-consent-banner" class="cookie-consent-banner">
        <div id="overlay" class="cookie-consent-banner-overlay"></div>
        <div id="js_cookie-consent-general">
          <button class="cookie-consent__buttons__action js_cookie-consent-agree primary">Ok, zgadzam się</button>
          <button class="cookie-consent__buttons__action js_cookie-consent-show-custom">Dostosuj zgody</button>
          <button class="cookie-consent__buttons__action js_cookie-consent-necessary">Nie zgadzam się</button>
        </div>
        <div id="js_cookie-consent-custom" class="hidden"></div>
        <div id="js_cookie-consent-partners" class="hidden"></div>
      </div>
    `);
  }

  test('detect matches the confirmed ceneo.pl markup: .cookie-consent-banner together with the necessary-only button', () => {
    const document = domWithWpHoldingBanner();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'wpholding_cookie_consent');
  });

  test('flow clicks "Nie zgadzam się" (necessary-only), never "Ok, zgadzam się" (accept)', async () => {
    const cmp = findCmp('wpholding_cookie_consent');
    const document = domWithWpHoldingBanner();

    let necessaryClicked = false;
    let acceptClicked = false;
    document.querySelector('.js_cookie-consent-necessary').addEventListener('click', () => { necessaryClicked = true; });
    document.querySelector('.js_cookie-consent-agree').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(necessaryClicked, true);
    assert.equal(acceptClicked, false);
  });

  test('does not match eMAG\'s unrelated .gdpr-cookie-banner markup - confirmed a different implementation, not the same platform', () => {
    const document = domWithBody(`
      <div class="gdpr-cookie-banner js-gdpr-cookie-banner py-2 px-0 show">
        <button class="js-accept">Accept toate</button>
        <button class="js-refuse">Refuză toate</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(!cmp || cmp.id !== 'wpholding_cookie_consent');
  });
});

describe('eMAG in-house GDPR cookie banner (emag_gdpr_cookie_banner)', () => {
  function domWithEmagBanner() {
    return domWithBody(`
      <div class="gdpr-cookie-banner js-gdpr-cookie-banner py-2 px-0 show" data-theme="light">
        <button class="fs-12 btn btn-primary btn-block js-accept">Accept toate</button>
        <button class="fs-12 btn btn-primary btn-block js-refuse">Refuză toate</button>
        <button class="fs-12 btn btn-link btn-block js-change-settings">Administrează preferințele</button>
      </div>
    `);
  }

  test('detect matches the confirmed emag.ro markup: .gdpr-cookie-banner together with the direct .js-refuse button', () => {
    const document = domWithEmagBanner();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'emag_gdpr_cookie_banner');
  });

  test('flow clicks .js-refuse ("Refuză toate"), never .js-accept', async () => {
    const cmp = findCmp('emag_gdpr_cookie_banner');
    const document = domWithEmagBanner();

    let refuseClicked = false;
    let acceptClicked = false;
    document.querySelector('.js-refuse').addEventListener('click', () => { refuseClicked = true; });
    document.querySelector('.js-accept').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(refuseClicked, true);
    assert.equal(acceptClicked, false);
  });

  test('does not match the WP Holding widget\'s unrelated .cookie-consent-banner markup', () => {
    const document = domWithBody(`
      <div id="js_cookie-consent-banner" class="cookie-consent-banner">
        <button class="js_cookie-consent-necessary">Nie zgadzam się</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(!cmp || cmp.id !== 'emag_gdpr_cookie_banner');
  });

  test('ADVERSARIAL (code review fix): an unrelated .js-refuse elsewhere on the page must never be clicked - the click is scoped to .gdpr-cookie-banner .js-refuse, not the bare class', async () => {
    // detect still fires here (both .gdpr-cookie-banner and .js-refuse exist
    // somewhere on the page - detect.js evaluates each selector independently,
    // out of scope for this fix), but the flow's own click step must only ever
    // resolve a .js-refuse that lives INSIDE the banner. This DOM deliberately
    // has no .js-refuse inside .gdpr-cookie-banner at all - only an unrelated
    // one elsewhere (e.g. a "refuse newsletter" widget sharing the class name
    // for unrelated reasons) - so the flow must click nothing.
    const cmp = findCmp('emag_gdpr_cookie_banner');
    const document = domWithBody(`
      <div class="gdpr-cookie-banner js-gdpr-cookie-banner py-2 px-0 show" data-theme="light">
        <button class="fs-12 btn btn-primary btn-block js-accept">Accept toate</button>
      </div>
      <div class="unrelated-widget">
        <button class="js-refuse">Refuse newsletter signup</button>
      </div>
    `);

    const cmpDetected = detectCMP(resolved, document);
    assert.ok(cmpDetected, 'sanity check: detect still fires on this adversarial DOM (a known, separate gap - detect selectors are independent)');
    assert.equal(cmpDetected.id, 'emag_gdpr_cookie_banner');

    let unrelatedClicked = false;
    let acceptClicked = false;
    document.querySelector('.unrelated-widget .js-refuse').addEventListener('click', () => { unrelatedClicked = true; });
    document.querySelector('.js-accept').addEventListener('click', () => { acceptClicked = true; });

    const results = await runFlow(cmp.flow, document);

    assert.equal(unrelatedClicked, false, 'a .js-refuse living outside .gdpr-cookie-banner must never be clicked');
    assert.equal(acceptClicked, false);
    assert.ok(results.every((r) => r.ok === false), 'the click step must report not-found rather than falling back to an unscoped match');
  });

  test('the click step\'s selector is scoped as a descendant of .gdpr-cookie-banner, not the bare .js-refuse class', () => {
    const cmp = rules.cmps.find((c) => c.id === 'emag_gdpr_cookie_banner');
    const clickStep = cmp.flow.find((step) => step.action === 'click');
    assert.ok(clickStep, 'expected a click step in the emag flow');
    assert.equal(clickStep.selector.css, '.gdpr-cookie-banner .js-refuse');
    assert.equal(clickStep.selector.textMatchRef, 'rejectAll', 'the click must also be confirmed by wording, not by DOM position alone');
  });
});

describe('Usercentrics v3 (shadow DOM), class-based buttons without data-testid - usercentrics_classic_buttons', () => {
  function domWithClassBasedShadowUsercentrics(hostId = 'usercentrics-cmp-ui') {
    const document = domWithBody('');
    const host = document.createElement('aside');
    host.id = hostId;
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const denyButton = document.createElement('button');
    denyButton.id = 'deny';
    denyButton.className = 'deny uc-deny-button';
    denyButton.textContent = 'Rifiuta';
    shadow.appendChild(denyButton);
    const acceptButton = document.createElement('button');
    acceptButton.id = 'accept';
    acceptButton.className = 'accept uc-accept-button';
    acceptButton.textContent = 'Accetta e chiudi';
    shadow.appendChild(acceptButton);
    return { document, denyButton, acceptButton };
  }

  test('detect matches the #usercentrics-cmp-ui shadow host exposing .deny.uc-deny-button (confirmed live on usercentrics.com, dkb.de, zoopla.co.uk - no [data-testid] present there at all)', () => {
    const { document } = domWithClassBasedShadowUsercentrics();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'usercentrics_classic_buttons');
  });

  test('flow clicks .deny.uc-deny-button, never .accept.uc-accept-button', async () => {
    const cmp = findCmp('usercentrics_classic_buttons');
    const { document, denyButton, acceptButton } = domWithClassBasedShadowUsercentrics();

    let denyClicked = false;
    let acceptClicked = false;
    denyButton.addEventListener('click', () => { denyClicked = true; });
    acceptButton.addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(denyClicked, true);
    assert.equal(acceptClicked, false);
  });

  test('the data-testid variant (usercentrics) and the class-based variant (usercentrics_classic_buttons) do not both fire on the same minimal DOM', () => {
    // A tenant confirmed to expose [data-testid="uc-deny-all-button"] (o2online.de,
    // n26.com, deutsche-bank.de - src/rules/NOTE.md) was checked live to carry no
    // .deny.uc-deny-button class at all, and vice versa (usercentrics.com, dkb.de,
    // zoopla.co.uk carry no [data-testid] at all) - the two entries are mutually
    // exclusive in practice. This DOM only has the testid button; only one entry
    // should match.
    const document = domWithBody('');
    const host = document.createElement('div');
    host.id = 'usercentrics-root';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const denyButton = document.createElement('button');
    denyButton.setAttribute('data-testid', 'uc-deny-all-button');
    denyButton.textContent = 'Reject All';
    shadow.appendChild(denyButton);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'usercentrics');
  });
});

describe('Usercentrics tie-break: usercentrics vs usercentrics_classic_buttons (code review fix)', () => {
  // Both entries share the same priority (10) today. The two are mutually
  // exclusive on every tenant confirmed live (src/rules/NOTE.md), so this
  // scenario - both markers present on the very same shadow root - is not
  // expected to occur on a real site. It is still worth pinning explicitly:
  // today the precedence in favour of the historic `usercentrics` entry is
  // guaranteed only implicitly, by Array.prototype.sort's stability plus
  // `usercentrics` being declared before `usercentrics_classic_buttons` in
  // rules.json - a guarantee that would silently flip if anyone ever
  // reordered those two entries (or inserted a third between them) without
  // reading this comment. This test turns that silent assumption into a
  // loud, explicit regression check.
  test('when a shadow root exposes BOTH the [data-testid] button and the .deny.uc-deny-button class, the historic usercentrics entry wins the tie', () => {
    const document = domWithBody('');
    const host = document.createElement('div');
    host.id = 'usercentrics-root';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const testIdButton = document.createElement('button');
    testIdButton.setAttribute('data-testid', 'uc-deny-all-button');
    testIdButton.textContent = 'Reject All';
    shadow.appendChild(testIdButton);

    const classButton = document.createElement('button');
    classButton.className = 'deny uc-deny-button';
    classButton.textContent = 'Rifiuta';
    shadow.appendChild(classButton);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'usercentrics', 'the data-testid-based entry must win the tie over the class-based fallback');
  });

  test('priorities are declared equal on purpose (see src/rules/NOTE.md) - this pins today\'s values so a silent edit to either is caught', () => {
    const usercentrics = rules.cmps.find((c) => c.id === 'usercentrics');
    const classic = rules.cmps.find((c) => c.id === 'usercentrics_classic_buttons');
    assert.equal(usercentrics.priority, classic.priority, 'if these are ever made unequal, update this test and the tie-break test above deliberately, together with NOTE.md');
  });
});
