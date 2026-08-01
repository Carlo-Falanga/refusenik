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
  storageSessionGet,
  storageSessionSet,
  storageSessionRemove,
} from './browser-api.js';
import { MESSAGE_GET_RULESET, MESSAGE_OUTCOME, MESSAGE_GET_TAB_STATE, OUTCOME_STATUS } from './messages.js';

const RULESET_REFRESH_ALARM = 'refusenik.rulesetRefresh';
const RULESET_REFRESH_PERIOD_MINUTES = 12 * 60; // 12h, per docs/ARCHITETTURA.md

/**
 * What the popup renders for the active tab (src/ui/popup.js), keyed by tab
 * id.
 *
 * This used to be the *only* copy of this data, kept purely in memory. That
 * was a real bug (not a theoretical one - reported by a user): this
 * background script runs as a non-persistent Firefox event page (see the
 * file's top doc comment), which Firefox unloads after roughly 30s of
 * inactivity. The refusal genuinely happens on the page; but by the time the
 * user opens the popup a little while later, Firefox has already discarded
 * this whole module (including this Map) and restarted it from scratch, so
 * the popup found nothing recorded and fell back to "nothing to do" - making
 * a working extension look broken.
 *
 * This Map is now only ever a same-tick, synchronous *cache* in front of the
 * actual source of truth, which is `browser.storage.session` (see
 * persistOutcome()/loadPersistedOutcome() below): a store built for exactly
 * this problem, since it survives an event page being unloaded/restarted and
 * only clears when the whole browser closes - never written to disk, so
 * nothing here leaks past the current browser session (docs/ARCHITETTURA.md,
 * "Privacy - non negoziabile"). If `storage.session` is ever unavailable in
 * a given runtime, storageSessionGet()/storageSessionSet()
 * (src/engine/browser-api.js) both degrade to silent no-ops - this Map then
 * remains the only copy again, i.e. the pre-fix behaviour, rather than
 * crashing anything.
 *
 * Cleared whenever the tab navigates to a new page (tabs.onUpdated, status
 * "loading") so a stale outcome from the previous page can never linger
 * into the next one, and whenever the tab closes (tabs.onRemoved) - see
 * clearTabState(). That cleanup now reaches storage.session too, not just
 * this cache; otherwise a next page load on the same tab id could hydrate a
 * stale outcome straight out of storage the moment this cache goes cold.
 */
const tabOutcomes = new Map();

/**
 * Serializes every recordOutcome()/clearTabState() call per tab id into a
 * strict FIFO chain. Two frames of the same page can report an outcome
 * within milliseconds of each other (see OUTCOME_STATUS_RANK below), and a
 * navigation can start while an older report for the previous page is still
 * being persisted - both are read-then-write sequences against the same
 * storage.session key, so without this queue two overlapping calls could
 * interleave (one reads the "existing" outcome before the other has finished
 * writing its own) and let a lower-ranked or stale write land last. Chaining
 * every call for a given tab id onto the same promise, one after another,
 * removes the possibility of that interleaving entirely: the Nth call's body
 * never starts running until the (N-1)th has fully settled.
 */
const pendingWrites = new Map();

function storageKeyForTab(tabId) {
  return `refusenik.tabOutcome.${tabId}`;
}

/** Reads a tab's persisted outcome from storage.session. Returns null if absent/unavailable. */
async function loadPersistedOutcome(tabId) {
  const key = storageKeyForTab(tabId);
  const stored = await storageSessionGet(key);
  return (stored && stored[key]) || null;
}

/** Writes a tab's outcome to storage.session. See storageSessionSet()'s doc comment (browser-api.js) for the fallback if unavailable. */
async function persistOutcome(tabId, outcome) {
  await storageSessionSet({ [storageKeyForTab(tabId)]: outcome });
}

/** Removes a tab's persisted outcome from storage.session. */
async function clearPersistedOutcome(tabId) {
  await storageSessionRemove(storageKeyForTab(tabId));
}

/** Runs `task` after every previously enqueued call for this tab id has settled - see pendingWrites above. */
function enqueueForTab(tabId, task) {
  const previous = pendingWrites.get(tabId) || Promise.resolve();
  // `.catch(() => {})` before *and* after `task`: a prior step failing (it
  // shouldn't - every storage helper this relies on already never throws,
  // per src/engine/browser-api.js) must never wedge every later call for
  // this tab id stuck behind a permanently-rejected promise.
  const next = previous.catch(() => {}).then(task).catch(() => {});
  pendingWrites.set(tabId, next);
  return next;
}

// A confirmed detection must never be silently downgraded by a later
// heuristic guess arriving from a different frame of the *same* page load
// (e.g. the top frame's "suspected banner" scan settling, 20s in, after a
// sub-frame already reported a handled/failed CMP) - see recordOutcome().
const OUTCOME_STATUS_RANK = {
  [OUTCOME_STATUS.HANDLED]: 2,
  [OUTCOME_STATUS.FAILED]: 2,
  // A "consent or pay" wall is a confident, deterministic recognition (the
  // same certainty as HANDLED/FAILED), not a guess - so it ranks the same
  // and must not be downgraded by a later heuristic "suspected" report from
  // a slower top-frame scan of the same page load.
  [OUTCOME_STATUS.CONSENT_OR_PAY]: 2,
  [OUTCOME_STATUS.SUSPECTED_UNHANDLED]: 1,
};

/**
 * Resolves the top-level page's hostname from `sender.tab.url` (the tab's
 * own current URL, as known to the WebExtensions runtime) rather than trust
 * the domain a reporting frame computed for itself. This is what keeps the
 * popup and the problem report showing the page the user is actually on even
 * when a CMP's banner is recognised inside a cross-origin iframe - several
 * of the CMPs this engine handles (Sourcepoint, TrustArc, BigID) render
 * their UI that way (see src/engine/content.js's module doc comment, and the
 * `all_frames: true` content script registration in manifest.json). Without
 * this, a banner recognised inside e.g. `consent-cdn.zeit.de`'s iframe would
 * report that iframe's own host instead of `zeit.de`.
 *
 * `sender.tab.url` needs no `tabs` permission here: like `tabs.query`'s
 * `url`/`title` fields (see browser-api.js's queryActiveTabId()), it is
 * populated because this extension already holds the `<all_urls>` host
 * permission declared in manifest.json. If that permission is ever revoked
 * for this tab, `sender.tab.url` comes back undefined/redacted and this
 * resolves to '' - callers fall back to the reporting frame's own domain in
 * that case (see the MESSAGE_OUTCOME branch below), which regresses to
 * today's behaviour rather than losing the domain entirely.
 */
function domainFromSenderTab(sender) {
  const tabUrl = sender && sender.tab && typeof sender.tab.url === 'string' ? sender.tab.url : '';
  if (!tabUrl) return '';
  try {
    return new URL(tabUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * Records an outcome for `tabId`, honouring OUTCOME_STATUS_RANK, and mirrors
 * it into storage.session so it survives this event page being unloaded
 * (see tabOutcomes' doc comment above). Returns the promise the whole
 * read-decide-write sequence runs under - background.js's own callers treat
 * this as fire-and-forget (nothing here needs the resolved value), but
 * test/background.test.js awaits it directly to make assertions
 * deterministic instead of racing a background write.
 */
function recordOutcome(tabId, outcome) {
  if (typeof tabId !== 'number') return Promise.resolve(); // no sender.tab (not a real page context) - nothing to key this on

  return enqueueForTab(tabId, async () => {
    // The in-memory cache is checked first (cheap, and already
    // authoritative whenever this event page has stayed alive since the
    // outcome it holds was recorded). Only fall back to storage.session when
    // the cache has nothing for this tab id at all - e.g. right after this
    // event page was unloaded and restarted mid-page-load, so a later frame's
    // report must still be compared against an earlier frame's
    // already-persisted, possibly higher-ranked outcome instead of a rank of
    // -1 (see OUTCOME_STATUS_RANK's own doc comment, the "20s in" example).
    let existing = tabOutcomes.get(tabId);
    if (existing === undefined) {
      existing = await loadPersistedOutcome(tabId);
    }

    const existingRank = existing ? (OUTCOME_STATUS_RANK[existing.status] || 0) : -1;
    const incomingRank = OUTCOME_STATUS_RANK[outcome.status] || 0;
    if (incomingRank < existingRank) return;

    const merged = { ...outcome, updatedAt: Date.now() };
    tabOutcomes.set(tabId, merged);
    await persistOutcome(tabId, merged);
  });
}

/**
 * Resolves the tab state the popup renders: the in-memory cache if this
 * event page is still the one that recorded it, otherwise storage.session -
 * the case that matters most here is exactly the bug this fixes, a popup
 * opened after this event page was unloaded and restarted with an empty
 * cache. A storage hit rehydrates the cache so a second lookup in the same
 * event-page lifetime (e.g. the popup re-rendering) does not need to hit
 * storage again.
 */
async function getTabState(tabId) {
  if (typeof tabId !== 'number') return null;

  const cached = tabOutcomes.get(tabId);
  if (cached) return cached;

  const persisted = await loadPersistedOutcome(tabId);
  if (persisted) tabOutcomes.set(tabId, persisted);
  return persisted;
}

/**
 * Clears both the cache and storage.session for `tabId`, called on
 * navigation start and on tab close (see the listeners below). The cache
 * entry is deleted synchronously, immediately, so a popup query racing this
 * exact moment never sees the outgoing page's outcome; the storage clear is
 * then queued behind any recordOutcome() already in flight for this tab id
 * (see enqueueForTab()), and the cache is deleted a second time once that
 * settles - a recordOutcome() call queued *before* this clear (a last report
 * from the page that is navigating away) can still repopulate the cache with
 * its own tabOutcomes.set() after the synchronous delete above already ran;
 * the queue guarantees that call finishes before this one starts, but says
 * nothing about the timing of that first, synchronous delete relative to it.
 * Deleting again here, last in the queue, guarantees both copies end up
 * clear no matter how that lands.
 */
function clearTabState(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve();

  tabOutcomes.delete(tabId);

  return enqueueForTab(tabId, async () => {
    await clearPersistedOutcome(tabId);
    tabOutcomes.delete(tabId);
  });
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
    const reportingFrameDomain = typeof message.domain === 'string' ? message.domain : '';
    // Prefer the tab's own top-level URL (domainFromSenderTab() above) over
    // whatever domain the reporting frame computed for itself
    // (src/engine/content.js's currentDomain(), which is only ever that
    // frame's own `window.location.hostname`) - falling back to the frame's
    // domain only if the tab's URL could not be resolved.
    //
    // The promise recordOutcome() returns is handed straight back as this
    // listener's own return value. content.js's reportOutcome() does await
    // this call, so this resolving now waits for the outcome to actually be
    // persisted rather than the near-instant `undefined` a synchronous
    // handler would give it - it still never reads or uses the resolved
    // value (there is nothing meaningful to reply with), so nothing about
    // this message being a one-way, best-effort report changes.
    return recordOutcome(tabId, {
      domain: domainFromSenderTab(sender) || reportingFrameDomain,
      cmpId: typeof message.cmpId === 'string' ? message.cmpId : null,
      cmpName: typeof message.cmpName === 'string' ? message.cmpName : null,
      status: message.status,
      stepCount: Number.isInteger(message.stepCount) ? message.stepCount : null,
      failedStepCount: Number.isInteger(message.failedStepCount) ? message.failedStepCount : null,
      durationMs: Number.isInteger(message.durationMs) ? message.durationMs : null,
    });
  }

  if (message.type === MESSAGE_GET_TAB_STATE) {
    return getTabState(message.tabId);
  }

  return undefined;
}

addRuntimeMessageListener(handleMessage);

addTabUpdatedListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') {
    clearTabState(tabId);
  }
});

addTabRemovedListener((tabId) => {
  clearTabState(tabId);
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

// ---------------------------------------------------------------------------
// TEST-ONLY EXPORTS - production code (the module's own top-level code
// above, and every other file that imports from this one) never imports any
// of these. background.js is an entry point, not a library, but recordOutcome
// /getTabState/clearTabState are exported anyway so test/background.test.js
// can call them directly and `await` their result, instead of only going
// through the fire-and-forget runtime.onMessage channel (dispatch() in that
// file), where timing would otherwise be impossible to pin down
// deterministically.
// ---------------------------------------------------------------------------
export { recordOutcome, getTabState, clearTabState };

/**
 * TEST-ONLY: simulates exactly what happens when Firefox unloads this
 * non-persistent event page after a period of inactivity and later restarts
 * it - every module-level variable, this `tabOutcomes` cache above all,
 * resets to empty, while storage.session (a separate browser-owned store,
 * not part of this module) is untouched. A real unload achieves this for
 * free simply by the whole module being re-evaluated from scratch; this
 * exists purely so a test can reproduce that effect without spinning up a
 * real browser and losing the ability to also inspect the fake
 * storage.session backing it in the same test.
 */
export function __simulateEventPageUnloadForTests() {
  tabOutcomes.clear();
}
