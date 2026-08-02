/**
 * Behavioural coverage for the CMP families added from the 393-site sweep
 * (verification/sweep-v4.json) recorded in src/rules/NOTE.md under
 * "Third sweep - 393 real sites, families 1-7": clickio_cmp,
 * inps_modalcookiebar, correos_cookiesmodule, ringpublishing_rasp_cmp,
 * heise_sourcepoint_consent_or_pay, wetter_contentpass_consent_or_pay,
 * ethyca_fides, schibsted_brand_level_sourcepoint, ebay_gdpr_banner,
 * as24_cmp, cookieinformation_coi, united_internet_consent_or_pay.
 *
 * For each actionable entry: a detect test against a minimal representative
 * DOM (taken from live inspection, not guessed), and a flow test asserting
 * the refusal button is clicked and the acceptance button never is. For the
 * three consentOrPay entries: a test that the wall is recognised but its
 * (empty) flow is never executed, mirroring content.js's own
 * isActionableKind() gate.
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

describe('Clickio CMP no-consent wall (clickio_consent_or_pay) - ilfattoquotidiano.it', () => {
  // Live inspection (src/rules/NOTE.md) found that clicking [data-role="b_decline"]
  // does NOT leave a working page: Clickio's own "no-consent" overlay
  // (#fov-noconsent / .ovl-noconsent, only injected in response to the click,
  // not present in the initial DOM) blocks reading the site and offers only
  // "Accetta i consensi" (accept) or "Rifiuta e Sostienici" (pay to support).
  // This is a consent-or-pay wall wearing Clickio's UI, so it must never be
  // acted on - the safest, and only honest, behaviour is to recognise the
  // banner and leave its flow empty.
  function domWithClickio() {
    return domWithBody(`
      <div id="cl-consent" class="cl-consent cl-consent-center cl-consent-lang-it">
        <div class="cl-consent__inner">
          <div class="cl-consent-popup cl-consent-popup--main cl-consent-visible">
            <div class="cl-consent__close-wrap">
              <button data-role="b_decline" type="button">Continua senza accettare</button>
            </div>
            <div class="cl-consent__buttons">
              <a href="#" class="cl-consent__btn cl-consent__hidden" data-role="b_decline_resurface">Rifiuta e chiudi</a>
              <a href="#" class="cl-consent__btn" data-role="b_options">Gestisci le opzioni</a>
              <a href="#" class="cl-consent__btn" data-role="b_agree">Accetta e chiudi</a>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  test('detect matches #cl-consent together with the confirmed [data-role="b_decline"] button', () => {
    const document = domWithClickio();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'clickio_consent_or_pay');
  });

  test('recognised but never acted on - the decline button is a trap, not a working refusal', async () => {
    const cmp = findCmp('clickio_consent_or_pay');
    const document = domWithClickio();
    assert.equal(cmp.kind, 'consentOrPay');
    assert.deepEqual(cmp.flow, []);

    let declineClicked = false;
    document.querySelector('[data-role="b_decline"]').addEventListener('click', () => { declineClicked = true; });

    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);

    assert.equal(declineClicked, false, 'the decline button must never be clicked - it springs a paywall, not a refusal');
  });
});

describe('INPS in-house cookie banner (inps_modalcookiebar)', () => {
  function domWithInps() {
    return domWithBody(`
      <div class="modal modalcookiebar show" id="modalcookiebar">
        <button id="closeBtn" onclick="rifiuta()">X</button>
        <button id="acceptAllBtn" onclick="accedi()">Accetta Tutti</button>
        <button id="refuseAnalyticsBtn" onclick="rifiuta()">Rifiuta i cookie non tecnici</button>
        <button id="settingCookieBtn">Impostazioni dei cookie</button>
      </div>
    `);
  }

  test('detect matches #modalcookiebar together with the confirmed #refuseAnalyticsBtn button', () => {
    const document = domWithInps();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'inps_modalcookiebar');
  });

  test('flow clicks #refuseAnalyticsBtn ("Rifiuta i cookie non tecnici"), never #acceptAllBtn', async () => {
    const cmp = findCmp('inps_modalcookiebar');
    const document = domWithInps();
    let refuseClicked = false;
    let acceptClicked = false;
    document.querySelector('#refuseAnalyticsBtn').addEventListener('click', () => { refuseClicked = true; });
    document.querySelector('#acceptAllBtn').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(refuseClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('Correos in-house cookie module (correos_cookiesmodule)', () => {
  function domWithCorreos() {
    return domWithBody(`
      <div class="cookiesmodule aem-GridColumn">
        <correos-cdk-cookies-module>
          <div class="sc-correos-cdk-cookies-module">
            <button aria-label="Rechazar todas las cookies">RECHAZAR TODAS</button>
            <button aria-label="Configurar cookies">CONFIGURAR COOKIES</button>
            <button>ACEPTAR TODAS</button>
          </div>
        </correos-cdk-cookies-module>
      </div>
    `);
  }

  test('detect matches the correos-cdk-cookies-module custom element together with .cookiesmodule', () => {
    const document = domWithCorreos();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'correos_cookiesmodule');
  });

  test('flow clicks the button with aria-label="Rechazar todas las cookies", never the accept button', async () => {
    const cmp = findCmp('correos_cookiesmodule');
    const document = domWithCorreos();
    const buttons = document.querySelectorAll('button');
    let rejectClicked = false;
    let acceptClicked = false;
    buttons[0].addEventListener('click', () => { rejectClicked = true; });
    buttons[2].addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('Ring Publishing / RASP CMP (ringpublishing_rasp_cmp) - onet.pl', () => {
  function domWithRasp() {
    const document = domWithBody(`
      <div class="cmp-popup_content cmp-popup_firstView" id="rasp_cmp">
        <div class="cmp-intro_intro">
          <div class="cmp-intro_options">
            <button class="cmp-button_button cmp-intro_rejectAll cmp-button_invert">Ustawienia zaawansowane</button>
            <button class="cmp-button_button cmp-intro_acceptAll">Przejdź do serwisu</button>
          </div>
        </div>
      </div>
    `);
    // Simulate the details layer the intro's "advanced settings" reveals -
    // confirmed live to swap in these three buttons (src/rules/NOTE.md).
    document.querySelector('.cmp-intro_rejectAll').addEventListener('click', () => {
      const container = document.querySelector('#rasp_cmp');
      const details = document.createElement('div');
      details.innerHTML = `
        <button class="cmp-button_button cmp-details_acceptAll">Włącz wszystko i przejdz do serwisu</button>
        <button class="cmp-button_button cmp-details_save">Zapisz i zamknij</button>
        <button class="cmp-button_button cmp-details_rejectAll cmp-button_invert">Nie wyrażam zgody</button>
      `;
      container.appendChild(details);
    });
    return document;
  }

  test('detect matches #rasp_cmp together with the confirmed .cmp-intro_rejectAll ("advanced settings") button', () => {
    const document = domWithRasp();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'ringpublishing_rasp_cmp');
  });

  test('flow opens the details layer and clicks .cmp-details_rejectAll ("Nie wyrażam zgody"), never an accept button', async () => {
    const cmp = findCmp('ringpublishing_rasp_cmp');
    const document = domWithRasp();

    // The reject/accept targets in the details layer do not exist until the
    // flow's own first click reveals them, so listeners are attached via
    // delegation on document rather than on the (not yet created) elements.
    let acceptClicked = false;
    let rejectClicked = false;
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.classList) return;
      if (target.classList.contains('cmp-intro_acceptAll') || target.classList.contains('cmp-details_acceptAll')) {
        acceptClicked = true;
      }
      if (target.classList.contains('cmp-details_rejectAll')) {
        rejectClicked = true;
      }
    });

    await runFlow(cmp.flow, document);

    assert.ok(document.querySelector('.cmp-details_rejectAll'), 'the details layer must have been revealed by clicking the intro button');
    assert.equal(rejectClicked, true, 'the details-layer reject-all button must have been clicked');
    assert.equal(acceptClicked, false, 'no accept button must ever be clicked');
  });
});

describe('heise.de Sourcepoint consent-or-pay wall (heise_sourcepoint_consent_or_pay)', () => {
  test('recognised but never acted on - both required categories offer no free reject path', async () => {
    const document = domWithBody(`
      <div class="cmp-banner">
        <button class="cmp-button cmp-offer-accept-btn cmp-consent-btn sp_choice_type_11">Zustimmen</button>
        <div class="cmp-offer-pur-tile">
          <a class="cmp-offer-pur-btn">Pur-Abo abschließen</a>
        </div>
        <button class="settings-button sp_choice_type_12">Einstellungen</button>
      </div>
    `);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'heise_sourcepoint_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
    assert.deepEqual(cmp.flow, []);
    assert.equal(isActionableKind(cmp.kind), false);

    let clicked = false;
    document.querySelector('.sp_choice_type_11').addEventListener('click', () => { clicked = true; });
    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);
    assert.equal(clicked, false);
  });
});

describe('wetter.com contentpass consent-or-pay wall (wetter_contentpass_consent_or_pay)', () => {
  test('recognised but never acted on - only "accept and continue" or "subscribe" are offered', async () => {
    const document = domWithBody(`
      <div id="cmp-paywall">
        <div id="cmp-consent">
          <button id="cmp-btn-accept">Akzeptieren und weiter</button>
        </div>
        <div id="cmp-pay">
          <button id="cmp-btn-signup">Werbefrei für 3,99€ / Monat</button>
        </div>
      </div>
    `);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'wetter_contentpass_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
    assert.deepEqual(cmp.flow, []);

    let clicked = false;
    document.querySelector('#cmp-btn-accept').addEventListener('click', () => { clicked = true; });
    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);
    assert.equal(clicked, false);
  });
});

describe('Ethyca Fides (ethyca_fides) - nytimes.com, wired.com, wired.it, arstechnica.com', () => {
  function domWithFides() {
    return domWithBody(`
      <div id="fides-banner-container">
        <div id="fides-banner">
          <div id="fides-button-group">
            <button id="fides-manage-preferences-button">Manage preferences</button>
            <button id="fides-reject-all-button">Reject All</button>
            <button id="fides-accept-all-button">Accept all</button>
          </div>
        </div>
      </div>
    `);
  }

  test('detect matches #fides-banner-container together with the confirmed #fides-reject-all-button', () => {
    const document = domWithFides();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'ethyca_fides');
  });

  test('flow clicks #fides-reject-all-button, never #fides-accept-all-button', async () => {
    const cmp = findCmp('ethyca_fides');
    const document = domWithFides();
    let rejectClicked = false;
    let acceptClicked = false;
    document.querySelector('#fides-reject-all-button').addEventListener('click', () => { rejectClicked = true; });
    document.querySelector('#fides-accept-all-button').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('Schibsted brand-level-consent / Sourcepoint (schibsted_brand_level_sourcepoint)', () => {
  test('dba.dk variant: the privacy-manager panel is already open with a direct REJECT_ALL button', async () => {
    const cmp = findCmp('schibsted_brand_level_sourcepoint');
    const document = domWithBody(`
      <div class="message-component message-column brand-level-consent true">
        <button class="message-component message-button tertiary sp_choice_type_SAVE_AND_EXIT">Tillad udvalgte</button>
        <button class="message-component message-button primary sp_choice_type_ACCEPT_ALL">Tillad alle</button>
        <button class="message-component message-button secondary sp_choice_type_REJECT_ALL">Kun nødvendige</button>
      </div>
    `);

    const detected = detectCMP(resolved, document);
    assert.ok(detected);
    assert.equal(detected.id, 'schibsted_brand_level_sourcepoint');

    let rejectClicked = false;
    let acceptClicked = false;
    document.querySelector('.sp_choice_type_REJECT_ALL').addEventListener('click', () => { rejectClicked = true; });
    document.querySelector('.sp_choice_type_ACCEPT_ALL').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false);
  });

  test('blocket.se/finn.no variant: first layer only offers accept/manage; opening manage reveals REJECT_ALL', async () => {
    const cmp = findCmp('schibsted_brand_level_sourcepoint');
    const document = domWithBody(`
      <div class="brand-level-consent">
        <button class="message-component message-button primary sp_choice_type_11">Godkänn alla</button>
        <button class="message-component message-button secondary sp_choice_type_12">Hantera eller avvisa</button>
      </div>
    `);

    document.querySelector('.sp_choice_type_12').addEventListener('click', () => {
      const container = document.querySelector('.brand-level-consent');
      const pm = document.createElement('div');
      pm.innerHTML = `
        <button class="message-component message-button secondary sp_choice_type_REJECT_ALL">Avvisa alla</button>
        <button class="message-component message-button primary sp_choice_type_ACCEPT_ALL">Godkänn alla</button>
      `;
      container.appendChild(pm);
    });

    // The reject/accept targets in the second layer do not exist until the
    // flow's own settings click reveals them, so listeners are attached via
    // delegation on document rather than on the (not yet created) elements.
    let acceptClicked = false;
    let rejectClicked = false;
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.classList) return;
      if (target.classList.contains('sp_choice_type_ACCEPT_ALL')) acceptClicked = true;
      if (target.classList.contains('sp_choice_type_REJECT_ALL')) rejectClicked = true;
    });

    const detected = detectCMP(resolved, document);
    assert.ok(detected);
    assert.equal(detected.id, 'schibsted_brand_level_sourcepoint');

    await runFlow(cmp.flow, document);

    assert.ok(document.querySelector('.sp_choice_type_REJECT_ALL'), 'clicking "Hantera eller avvisa" must have revealed the reject-all button');
    assert.equal(rejectClicked, true, 'the second-layer reject-all button must have been clicked');
    assert.equal(acceptClicked, false, 'no accept button must ever be clicked');
  });
});

describe('eBay/Kleinanzeigen gdpr-banner (ebay_gdpr_banner)', () => {
  test('ebay.it variant: a direct #gdpr-banner-decline button in the first layer', async () => {
    const cmp = findCmp('ebay_gdpr_banner');
    const document = domWithBody(`
      <section id="gdpr-banner">
        <button id="gdpr-banner-decline">Rifiuta tutto</button>
        <button id="gdpr-banner-accept">Accetta tutto</button>
      </section>
    `);

    const detected = detectCMP(resolved, document);
    assert.ok(detected);
    assert.equal(detected.id, 'ebay_gdpr_banner');

    let declineClicked = false;
    let acceptClicked = false;
    document.querySelector('#gdpr-banner-decline').addEventListener('click', () => { declineClicked = true; });
    document.querySelector('#gdpr-banner-accept').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(declineClicked, true);
    assert.equal(acceptClicked, false);
  });

  // kleinanzeigen.de variant: confirmed live (src/rules/NOTE.md) that there is
  // no direct decline id here - #gdpr-banner-cmp-button ("Datenschutzeinstellungen")
  // performs a full page navigation to a dedicated /gdpr settings page rather
  // than revealing an in-page panel. A single flow cannot span that
  // navigation (the JS execution context is torn down), so this is
  // deliberately two separate entries: this one only opens the settings
  // page (best effort within its own page), and
  // kleinanzeigen_gdpr_consent_management_page (below) is what the content
  // script detects and completes the refusal on once it reloads there -
  // exactly how the real extension's per-page content-script injection
  // handles it.
  test('kleinanzeigen.de variant: no direct decline id - the flow only opens the dedicated settings page, never clicks accept', async () => {
    const cmp = findCmp('ebay_gdpr_banner');
    const document = domWithBody(`
      <dialog id="gdpr-banner">
        <button id="gdpr-banner-accept" aria-label="Alle Cookies und Tracking akzeptieren">Alle akzeptieren</button>
        <button id="gdpr-banner-cmp-button" aria-label="Datenschutzeinstellungen anpassen oder ablehnen">Datenschutzeinstellungen</button>
      </dialog>
    `);

    let settingsClicked = false;
    let acceptClicked = false;
    document.querySelector('#gdpr-banner-cmp-button').addEventListener('click', () => { settingsClicked = true; });
    document.querySelector('#gdpr-banner-accept').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(settingsClicked, true, 'the settings button must be clicked when no direct decline id exists');
    assert.equal(acceptClicked, false, 'the accept button must never be clicked');
  });
});

describe('Kleinanzeigen dedicated /gdpr consent management page (kleinanzeigen_gdpr_consent_management_page)', () => {
  function domWithGdprPage() {
    return domWithBody(`
      <div id="gdpr-consent-management">
        <button aria-label="Datenschutzbestimmungen und Einstellungen ablehnen">Alle ablehnen und fortfahren</button>
        <button aria-label="Einverstanden - Datenschutzbestimmungen und Einstellungen akzeptieren">Alle akzeptieren</button>
      </div>
    `);
  }

  test('detect matches #gdpr-consent-management together with the confirmed aria-labelled reject button', () => {
    const document = domWithGdprPage();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'kleinanzeigen_gdpr_consent_management_page');
  });

  test('flow clicks the aria-labelled reject button, never the accept one', async () => {
    const cmp = findCmp('kleinanzeigen_gdpr_consent_management_page');
    const document = domWithGdprPage();
    let rejectClicked = false;
    let acceptClicked = false;
    document.querySelector('button[aria-label="Datenschutzbestimmungen und Einstellungen ablehnen"]')
      .addEventListener('click', () => { rejectClicked = true; });
    document.querySelector('button[aria-label="Einverstanden - Datenschutzbestimmungen und Einstellungen akzeptieren"]')
      .addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(rejectClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('AutoScout24 CMP (as24_cmp)', () => {
  test('detect matches #as24-cmp-popup together with the stable data-testid decline button (not the hashed class)', () => {
    const document = domWithBody(`
      <div id="as24-cmp-popup">
        <button class="_consent-decline_1lphq_67" data-testid="as24-cmp-decline-all-button">qui</button>
        <button class="_consent-settings_1lphq_103" data-testid="as24-cmp-partial-consent-button">Impostazioni di privacy</button>
        <button class="_consent-accept_1lphq_114" data-testid="as24-cmp-accept-all-button">Accetta tutto</button>
      </div>
    `);
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'as24_cmp');
  });

  test('flow clicks the data-testid decline button, never the accept one, and is immune to the build hash changing', async () => {
    const cmp = findCmp('as24_cmp');
    const document = domWithBody(`
      <div id="as24-cmp-popup">
        <button class="_consent-decline_ZZZZZ_1" data-testid="as24-cmp-decline-all-button">hier</button>
        <button class="_consent-accept_ZZZZZ_2" data-testid="as24-cmp-accept-all-button">Alles akzeptieren</button>
      </div>
    `);
    let declineClicked = false;
    let acceptClicked = false;
    document.querySelector('[data-testid="as24-cmp-decline-all-button"]').addEventListener('click', () => { declineClicked = true; });
    document.querySelector('[data-testid="as24-cmp-accept-all-button"]').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(declineClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('Cookie Information / Piwik PRO (cookieinformation_coi)', () => {
  function domWithCoi() {
    return domWithBody(`
      <div id="coi-banner-wrapper">
        <div class="coi-consent-banner__categories-wrapper">
          <button id="show_details">Show details</button>
          <button id="declineButton" class="coi-banner__decline">Decline all</button>
          <button class="coi-banner__accept">Accept all</button>
        </div>
      </div>
    `);
  }

  test('detect matches #coi-banner-wrapper together with the confirmed #declineButton', () => {
    const document = domWithCoi();
    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'cookieinformation_coi');
  });

  test('flow clicks #declineButton ("Decline all"), never .coi-banner__accept', async () => {
    const cmp = findCmp('cookieinformation_coi');
    const document = domWithCoi();
    let declineClicked = false;
    let acceptClicked = false;
    document.querySelector('#declineButton').addEventListener('click', () => { declineClicked = true; });
    document.querySelector('.coi-banner__accept').addEventListener('click', () => { acceptClicked = true; });

    await runFlow(cmp.flow, document);

    assert.equal(declineClicked, true);
    assert.equal(acceptClicked, false);
  });
});

describe('GMX/WEB.DE consent-or-pay wall (united_internet_consent_or_pay)', () => {
  test('recognised but never acted on - only "accept and continue" or "subscribe to Premium" are offered', async () => {
    const document = domWithBody(`
      <div>
        <a id="goto-abo">Zum Abo ohne Fremdwerbung</a>
        <button id="save-all-pur">Akzeptieren und weiter</button>
        <a id="privacy-center">Privacy Center</a>
        <a id="gdpr-info">Datenschutzhinweisen</a>
      </div>
    `);

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'united_internet_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
    assert.deepEqual(cmp.flow, []);

    let clicked = false;
    document.querySelector('#save-all-pur').addEventListener('click', () => { clicked = true; });
    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);
    assert.equal(clicked, false);
  });
});
