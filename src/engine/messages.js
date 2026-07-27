/**
 * Message-type and outcome-status literals shared between the content
 * script, the background and the popup (src/ui/popup.js).
 *
 * These three are built and load independently, exactly like the
 * rules/engine `action` contract documented in docs/ARCHITETTURA.md - and
 * that document is explicit about the failure mode this caused once
 * already: two sides of a contract agreeing "in prose" but not in code is
 * how a whole feature goes silently inert. Single-sourcing the literals
 * here removes the class of bug outright instead of relying on a test to
 * catch a future mismatch.
 */

/** Content script -> background: ask for the currently active ruleset. */
export const MESSAGE_GET_RULESET = 'cookieRefuser:getRuleset';

/** Content script -> background: report what happened on this page load. */
export const MESSAGE_OUTCOME = 'cookieRefuser:outcome';

/** Popup -> background: ask for the recorded outcome of a specific tab id. */
export const MESSAGE_GET_TAB_STATE = 'cookieRefuser:getTabState';

/** Values of the outcome message's `status` field. */
export const OUTCOME_STATUS = Object.freeze({
  HANDLED: 'handled',
  FAILED: 'failed',
  SUSPECTED_UNHANDLED: 'suspected-unhandled',
  // A CMP was recognised, but only as a "consent or pay" wall: the site
  // offers no refusal, only tracking consent or a paid subscription. The
  // engine never runs a flow for these (see src/engine/detect.js's
  // isActionableKind() and src/rules/NOTE.md) - this status means "correctly
  // recognised and deliberately left alone", not a failure.
  CONSENT_OR_PAY: 'consent-or-pay',
});

/**
 * Values of a CMP entry's optional `kind` field (see docs/ARCHITETTURA.md).
 * `REFUSE` is the implicit default when the field is absent - both authorize
 * the engine to run the entry's `flow`. Any other value, known or not, must
 * never be treated as authorizing an action; see isActionableKind() in
 * src/engine/detect.js.
 */
export const CMP_KIND = Object.freeze({
  REFUSE: 'refuse',
  CONSENT_OR_PAY: 'consentOrPay',
});
