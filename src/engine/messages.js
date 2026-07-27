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
});
