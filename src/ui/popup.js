/**
 * Popup UI. Its one job: make it obvious at a glance whether this extension
 * did anything on the current page, and offer a way to report it when it
 * didn't (docs/ARCHITETTURA.md does not cover the UI - this file and
 * report.js are where that product decision actually lives).
 *
 * Five states, in the priority they are checked:
 *  1. Site access revoked (browser-api.js's hasAllUrlsPermission() is
 *     false) - checked FIRST, since if it's true nothing below can be
 *     trusted (no content script ever ran here).
 *  2. No active tab id could be resolved at all - treated the same as "no
 *     recorded outcome" below; this popup never has (or needs) the `tabs`
 *     permission to know more about why.
 *  3. No recorded outcome for this tab (background.js's tabOutcomes) ->
 *     "nothing to do".
 *  4/5. A recorded outcome with status 'handled' / 'failed' /
 *     'suspected-unhandled' (src/engine/messages.js) -> refused / failed /
 *     suspected-unhandled respectively.
 *
 * The report button (states failed/suspected only) always reveals the exact
 * text that will be copied before anything is copied - see report.js.
 */

import {
  queryActiveTabId,
  hasAllUrlsPermission,
  getExtensionVersion,
  getMessage,
  sendRuntimeMessage,
} from '../engine/browser-api.js';
import { MESSAGE_GET_TAB_STATE, OUTCOME_STATUS } from '../engine/messages.js';
import { buildReportPayload, sendReport } from './report.js';

const root = document.querySelector('[data-root]');

const fields = {
  statusLabel: document.querySelector('[data-field="statusLabel"]'),
  cmpName: document.querySelector('[data-field="cmpName"]'),
  metaSection: document.querySelector('[data-field="metaSection"]'),
  domain: document.querySelector('[data-field="domain"]'),
  stepsSummary: document.querySelector('[data-field="stepsSummary"]'),
  body: document.querySelector('[data-field="body"]'),
  reportSection: document.querySelector('[data-field="reportSection"]'),
  reportPanel: document.querySelector('[data-field="reportPanel"]'),
  reportPayload: document.querySelector('[data-field="reportPayload"]'),
  reportConfirmation: document.querySelector('[data-field="reportConfirmation"]'),
};

const buttons = {
  openReport: document.querySelector('[data-action="open-report"]'),
  copyReport: document.querySelector('[data-action="copy-report"]'),
  cancelReport: document.querySelector('[data-action="cancel-report"]'),
};

function localizeStaticStrings() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = getMessage(el.getAttribute('data-i18n'));
  }
}

function setState(stateName) {
  root.setAttribute('data-state', stateName);
}

function show(el) {
  if (el) el.hidden = false;
}

function hide(el) {
  if (el) el.hidden = true;
}

function formatStepsSummary(stepCount, durationMs) {
  const ms = Number.isInteger(durationMs) ? durationMs : 0;
  if (stepCount === 1) return getMessage('stepsSummarySingular', [String(ms)]);
  return getMessage('stepsSummaryPlural', [String(stepCount), String(ms)]);
}

function renderRevoked() {
  setState('revoked');
  fields.statusLabel.textContent = getMessage('statusRevoked');
  fields.body.textContent = getMessage('bodyRevoked');
  show(fields.body);
}

function renderNothing() {
  setState('nothing');
  fields.statusLabel.textContent = getMessage('statusNothing');
  fields.body.textContent = getMessage('bodyNothing');
  show(fields.body);
}

function renderDomain(domain) {
  if (!domain) return;
  fields.domain.textContent = domain;
  show(fields.metaSection);
}

function renderRefused(outcome) {
  setState('refused');
  fields.statusLabel.textContent = getMessage('statusRefused');
  fields.cmpName.textContent = outcome.cmpName || outcome.cmpId || '';
  show(fields.cmpName);
  renderDomain(outcome.domain);
  if (Number.isInteger(outcome.stepCount)) {
    fields.stepsSummary.textContent = formatStepsSummary(outcome.stepCount, outcome.durationMs);
    show(fields.stepsSummary);
  }
}

function renderFailed(outcome) {
  setState('failed');
  fields.statusLabel.textContent = getMessage('statusFailed');
  fields.cmpName.textContent = outcome.cmpName || outcome.cmpId || '';
  show(fields.cmpName);
  renderDomain(outcome.domain);
  if (Number.isInteger(outcome.stepCount)) {
    fields.stepsSummary.textContent = formatStepsSummary(outcome.stepCount, outcome.durationMs);
    show(fields.stepsSummary);
  }
  fields.body.textContent = getMessage('bodyFailed', [
    outcome.cmpName || outcome.cmpId || '?',
    String(Number.isInteger(outcome.failedStepCount) ? outcome.failedStepCount : '?'),
    String(Number.isInteger(outcome.stepCount) ? outcome.stepCount : '?'),
  ]);
  show(fields.body);
  setUpReportButton(outcome);
}

function renderSuspected(outcome) {
  setState('suspected');
  fields.statusLabel.textContent = getMessage('statusSuspected');
  renderDomain(outcome.domain);
  fields.body.textContent = getMessage('bodySuspected');
  show(fields.body);
  setUpReportButton(outcome);
}

function setUpReportButton(outcome) {
  show(fields.reportSection);

  const payload = buildReportPayload({
    domain: outcome.domain,
    cmpId: outcome.cmpId,
    version: getExtensionVersion(),
  });
  fields.reportPayload.textContent = payload;

  buttons.openReport.addEventListener('click', () => {
    show(fields.reportPanel);
    hide(buttons.openReport);
    buttons.copyReport.focus();
  });

  buttons.cancelReport.addEventListener('click', () => {
    hide(fields.reportPanel);
    hide(fields.reportConfirmation);
    show(buttons.openReport);
    buttons.openReport.focus();
  });

  buttons.copyReport.addEventListener('click', async () => {
    const copied = await sendReport(payload);
    fields.reportConfirmation.textContent = getMessage(copied ? 'copiedConfirmation' : 'copyFailedConfirmation');
    show(fields.reportConfirmation);
  });
}

async function getTabOutcome(tabId) {
  if (typeof tabId !== 'number') return null;
  try {
    const outcome = await sendRuntimeMessage({ type: MESSAGE_GET_TAB_STATE, tabId });
    return outcome || null;
  } catch {
    return null;
  }
}

async function render() {
  const allowed = await hasAllUrlsPermission();
  if (!allowed) {
    renderRevoked();
    return;
  }

  const tabId = await queryActiveTabId();
  const outcome = await getTabOutcome(tabId);

  if (!outcome) {
    renderNothing();
    return;
  }

  if (outcome.status === OUTCOME_STATUS.HANDLED) {
    renderRefused(outcome);
    return;
  }

  if (outcome.status === OUTCOME_STATUS.FAILED) {
    renderFailed(outcome);
    return;
  }

  if (outcome.status === OUTCOME_STATUS.SUSPECTED_UNHANDLED) {
    renderSuspected(outcome);
    return;
  }

  renderNothing();
}

localizeStaticStrings();
render();
