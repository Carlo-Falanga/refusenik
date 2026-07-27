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
 * ruleset); nothing here needs to special-case that. The popup itself
 * detects that same revocation directly (browser-api.js's
 * hasAllUrlsPermission()) to explain it to the user instead of just
 * looking like "nothing happened".
 *
 * Also owns the popup's per-tab outcome state - see tabOutcomes below.
 */

import { getActiveRuleset, maybeRefreshRuleset } from './ruleset.js';
import {
  addRuntimeMessageListener,
  alarmsCreate,
  addAlarmListener,
  addTabUpdatedListener,
  addTabRemovedListener,
} from './browser-api.js';
import { MESSAGE_GET_RULESET, MESSAGE_OUTCOME, MESSAGE_GET_TAB_STATE, OUTCOME_STATUS } from './messages.js';

const RULESET_REFRESH_ALARM = 'cookieRefuser.rulesetRefresh';
const RULESET_REFRESH_PERIOD_MINUTES = 12 * 60; // 12h, per docs/ARCHITETTURA.md

/**
 * What the popup renders for the active tab (src/ui/popup.js), keyed by tab
 * id. In-memory only - it is a live "what happened on this page load" cache,
 * not data that needs to outlive a background restart, and it is entirely
 * separate from the opt-in problem report (src/ui/report.js), which never
 * reads from this map and carries only domain/cmpId/version.
 *
 * Cleared whenever the tab navigates to a new page (tabs.onUpdated, status
 * "loading") so a stale outcome from the previous page can never linger
 * into the next one, and whenever the tab closes (tabs.onRemoved).
 */
const tabOutcomes = new Map();

// A confirmed detection must never be silently downgraded by a later
// heuristic guess arriving from a different frame of the *same* page load
// (e.g. the top frame's "suspected banner" scan settling, 20s in, after a
// sub-frame already reported a handled/failed CMP) - see recordOutcome().
const OUTCOME_STATUS_RANK = {
  [OUTCOME_STATUS.HANDLED]: 2,
  [OUTCOME_STATUS.FAILED]: 2,
  [OUTCOME_STATUS.SUSPECTED_UNHANDLED]: 1,
};

function recordOutcome(tabId, outcome) {
  if (typeof tabId !== 'number') return; // no sender.tab (not a real page context) - nothing to key this on

  const existing = tabOutcomes.get(tabId);
  const existingRank = existing ? (OUTCOME_STATUS_RANK[existing.status] || 0) : -1;
  const incomingRank = OUTCOME_STATUS_RANK[outcome.status] || 0;
  if (incomingRank < existingRank) return;

  tabOutcomes.set(tabId, { ...outcome, updatedAt: Date.now() });
}

/**
 * Runs the (already 12h-gated) refresh check. Never throws: on any failure
 * maybeRefreshRuleset() itself resolves to the previously active ruleset,
 * so there is nothing for the alarm handler to react to either way.
 */
async function refreshRuleset() {
  await maybeRefreshRuleset();
}

function handleMessage(message, sender) {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === MESSAGE_GET_RULESET) {
    return getActiveRuleset();
  }

  if (message.type === MESSAGE_OUTCOME) {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    recordOutcome(tabId, {
      domain: typeof message.domain === 'string' ? message.domain : '',
      cmpId: typeof message.cmpId === 'string' ? message.cmpId : null,
      cmpName: typeof message.cmpName === 'string' ? message.cmpName : null,
      status: message.status,
      stepCount: Number.isInteger(message.stepCount) ? message.stepCount : null,
      failedStepCount: Number.isInteger(message.failedStepCount) ? message.failedStepCount : null,
      durationMs: Number.isInteger(message.durationMs) ? message.durationMs : null,
    });
    return undefined; // fire-and-forget: the content script does not wait on a reply
  }

  if (message.type === MESSAGE_GET_TAB_STATE) {
    const tabId = message.tabId;
    return typeof tabId === 'number' ? (tabOutcomes.get(tabId) || null) : null;
  }

  return undefined;
}

addRuntimeMessageListener(handleMessage);

addTabUpdatedListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') {
    tabOutcomes.delete(tabId);
  }
});

addTabRemovedListener((tabId) => {
  tabOutcomes.delete(tabId);
});

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
