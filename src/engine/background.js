/**
 * Background entry point (Firefox MV3 non-persistent event page - see
 * manifest.json; Firefox does not support service workers for extensions,
 * so this runs as `background.scripts` with `type: "module"` instead).
 *
 * Owns the ruleset end to end, per docs/ARCHITETTURA.md:
 *  - Holds the one authoritative copy (bundled fallback, cached remote
 *    ruleset, or the last-known-good one - see src/engine/ruleset.js).
 *  - Is the only context that ever fetches the remote ruleset and its
 *    detached signature. Content scripts never fetch; they ask this
 *    background for the active ruleset over `runtime.sendMessage`, which
 *    also means the ruleset never needs to be listed in
 *    `web_accessible_resources` (that would make it readable by any page).
 *  - Schedules the 12h refresh with `browser.alarms`, which - unlike a
 *    per-page-load opportunistic check - persists across the event page
 *    being unloaded and reloaded, and fires at most once per interval no
 *    matter how many tabs are open.
 *
 * If the extension's host permissions are revoked by the user (supported
 * since Firefox 127), the remote fetch simply fails and is swallowed by
 * ruleset.js's own error handling (it always falls back to the last valid
 * ruleset); nothing here needs to special-case that.
 */

import { getActiveRuleset, maybeRefreshRuleset } from './ruleset.js';
import { addRuntimeMessageListener, alarmsCreate, addAlarmListener } from './browser-api.js';

const RULESET_REFRESH_ALARM = 'cookieRefuser.rulesetRefresh';
const RULESET_REFRESH_PERIOD_MINUTES = 12 * 60; // 12h, per docs/ARCHITETTURA.md

const MESSAGE_TYPE_GET_RULESET = 'cookieRefuser:getRuleset';

/**
 * Runs the (already 12h-gated) refresh check. Never throws: on any failure
 * maybeRefreshRuleset() itself resolves to the previously active ruleset,
 * so there is nothing for the alarm handler to react to either way.
 */
async function refreshRuleset() {
  await maybeRefreshRuleset();
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === MESSAGE_TYPE_GET_RULESET) {
    return getActiveRuleset();
  }

  // Other message types (e.g. the content script's opt-in outcome report)
  // are not consumed by this background yet - left unanswered rather than
  // treated as an error, so sendRuntimeMessage callers resolve cleanly.
  return undefined;
}

addRuntimeMessageListener(handleMessage);

addAlarmListener((alarm) => {
  if (alarm && alarm.name === RULESET_REFRESH_ALARM) {
    refreshRuleset();
  }
});

alarmsCreate(RULESET_REFRESH_ALARM, { periodInMinutes: RULESET_REFRESH_PERIOD_MINUTES });

// Covers the case where the event page was unloaded for the entire 12h
// window and only wakes up later on an unrelated event (e.g. a new tab
// opening) rather than exactly on the alarm: maybeRefreshRuleset() is
// itself gated on the same 12h window via storage, so this is a no-op on
// every startup except the first one after the window has elapsed.
refreshRuleset();
