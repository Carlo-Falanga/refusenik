/**
 * Regression coverage for the "wrong domain in an iframe CMP" bug: several
 * CMPs this engine handles (Sourcepoint, TrustArc, BigID) render their
 * banner inside a cross-origin iframe, and the content script runs in every
 * frame (`all_frames: true`, manifest.json). When the *iframe's* frame is
 * the one that recognises and reports the CMP, `sender.tab.url` (known to
 * the background regardless of which frame sent the message) - not the
 * reporting frame's own `window.location.hostname` (src/engine/content.js's
 * currentDomain()) - must be what ends up in the recorded outcome, so the
 * popup and the problem report always show the page the user is actually
 * visiting (e.g. `zeit.de`) rather than the CMP's own host (e.g.
 * `consent-cdn.zeit.de`). See src/engine/background.js's
 * domainFromSenderTab().
 *
 * Also covers the "popup says 'nothing to do' even though the refusal really
 * happened" bug: this background script is a non-persistent Firefox event
 * page, unloaded after inactivity and restarted from scratch - so the old,
 * purely in-memory `tabOutcomes` cache was wiped by the time a user usually
 * gets around to opening the popup. background.js now mirrors every outcome
 * into `browser.storage.session`, which survives that unload/restart (see
 * background.js's tabOutcomes doc comment). `fakeSessionStorage` below is a
 * tiny in-memory stand-in for that store, kept in the test file (not reset
 * between tests) so it can outlive `__simulateEventPageUnloadForTests()`
 * clearing the in-memory cache, exactly like the real storage.session
 * outlives a real unload.
 *
 * Stubbing approach: browser-api.js reads `globalThis.browser` once, at
 * import time, into a module-level const - so the stub below must be
 * installed *before* background.js (which imports browser-api.js) is
 * imported. `globalThis.fetch` is stubbed too, purely so background.js's
 * own top-level ruleset refresh (triggered as a side effect of importing
 * it - see the bottom of background.js) never attempts a real network
 * request in a test run; every one of its call sites already tolerates a
 * failing fetch (src/engine/ruleset.js), so this has no bearing on what is
 * actually under test here. `node --test` runs each test file in its own
 * process by default, so neither stub leaks into any other test file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_OUTCOME, MESSAGE_GET_TAB_STATE, OUTCOME_STATUS } from '../src/engine/messages.js';

let onMessageListener;

const fakeSessionStorageBackingStore = new Map();

const fakeSessionStorage = {
  get: async (keys) => {
    const key = keys; // background.js only ever reads one key at a time
    return fakeSessionStorageBackingStore.has(key) ? { [key]: fakeSessionStorageBackingStore.get(key) } : {};
  },
  set: async (items) => {
    for (const [key, value] of Object.entries(items)) {
      fakeSessionStorageBackingStore.set(key, value);
    }
  },
  remove: async (keys) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      fakeSessionStorageBackingStore.delete(key);
    }
  },
};

globalThis.browser = {
  runtime: {
    onMessage: {
      addListener: (fn) => {
        onMessageListener = fn;
      },
    },
    getManifest: () => ({ version: '0.0.0' }),
    getURL: (path) => path,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
    session: fakeSessionStorage,
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [],
  },
};

globalThis.fetch = async () => {
  throw new Error('no real network access in tests');
};

const { clearTabState, __simulateEventPageUnloadForTests } = await import('../src/engine/background.js');

/**
 * Feeds a message straight into the listener background.js registered,
 * exactly as runtime.onMessage would. Both MESSAGE_OUTCOME and
 * MESSAGE_GET_TAB_STATE now resolve to a promise (background.js awaits
 * storage.session internally for both), so this - and every test below -
 * awaits it rather than reading the result synchronously.
 */
async function dispatch(message, sender) {
  return onMessageListener(message, sender, () => {});
}

async function getTabState(tabId) {
  return dispatch({ type: MESSAGE_GET_TAB_STATE, tabId }, {});
}

describe('background.js - domain recorded from an outcome message', () => {
  test('main frame: the reported domain matches the page (no regression)', async () => {
    const sender = {
      tab: { id: 101, url: 'https://www.zeit.de/politik/some-article' },
      frameId: 0, // top frame
    };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'www.zeit.de', // the frame's own currentDomain() - same as the tab here
        cmpId: 'sourcepoint',
        cmpName: 'Sourcepoint',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 2,
        failedStepCount: 0,
        durationMs: 120,
      },
      sender,
    );

    const outcome = await getTabState(101);
    assert.equal(outcome.domain, 'www.zeit.de');
  });

  test('third-party iframe CMP: reports the top-level page domain, not the iframe host', async () => {
    const sender = {
      tab: { id: 202, url: 'https://www.zeit.de/politik/some-article' },
      frameId: 7, // the CMP's own cross-origin sub-frame
    };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        // What the reporting frame's own currentDomain() computed: the
        // iframe's host, not the site the user is visiting.
        domain: 'consent-cdn.zeit.de',
        cmpId: 'sourcepoint',
        cmpName: 'Sourcepoint',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 3,
        failedStepCount: 0,
        durationMs: 340,
      },
      sender,
    );

    const outcome = await getTabState(202);
    assert.equal(outcome.domain, 'www.zeit.de');
    assert.notEqual(outcome.domain, 'consent-cdn.zeit.de');
  });

  test('third-party iframe CMP reporting a "consent or pay" wall also gets the top-level domain', async () => {
    // Same fix, different outcome status - domainFromSenderTab() does not
    // branch on `status`, but this guards against a future refactor that
    // accidentally only wires it up for the HANDLED/FAILED cases.
    const sender = {
      tab: { id: 303, url: 'https://example.com/some/page' },
      frameId: 3,
    };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'cmp-provider.example',
        cmpId: 'wall-cmp',
        cmpName: 'Wall CMP',
        status: OUTCOME_STATUS.CONSENT_OR_PAY,
      },
      sender,
    );

    const outcome = await getTabState(303);
    assert.equal(outcome.domain, 'example.com');
  });

  test('falls back to the reporting frame’s own domain if the tab URL cannot be resolved', async () => {
    // e.g. the <all_urls> host permission was revoked for this tab (Firefox
    // 127+ site access "Never"/"On click"): sender.tab.url comes back
    // undefined/redacted rather than throwing.
    const sender = {
      tab: { id: 404 }, // no `url` field at all
      frameId: 0,
    };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'fallback.example.com',
        cmpId: 'onetrust',
        cmpName: 'OneTrust',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 1,
        failedStepCount: 0,
        durationMs: 50,
      },
      sender,
    );

    const outcome = await getTabState(404);
    assert.equal(outcome.domain, 'fallback.example.com');
  });

  test('an unparseable tab URL also falls back to the reporting frame’s own domain instead of throwing', async () => {
    const sender = {
      tab: { id: 505, url: 'not-a-valid-url' },
      frameId: 0,
    };

    await assert.doesNotReject(
      dispatch(
        {
          type: MESSAGE_OUTCOME,
          domain: 'fallback-again.example.com',
          cmpId: null,
          cmpName: null,
          status: OUTCOME_STATUS.SUSPECTED_UNHANDLED,
        },
        sender,
      ),
    );

    const outcome = await getTabState(505);
    assert.equal(outcome.domain, 'fallback-again.example.com');
  });
});

describe('background.js - outcome survives the event page being unloaded', () => {
  test('an outcome recorded before an unload is still readable from the popup after it', async () => {
    const sender = {
      tab: { id: 601, url: 'https://example.org/some/page' },
      frameId: 0,
    };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'example.org',
        cmpId: 'onetrust',
        cmpName: 'OneTrust',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 2,
        failedStepCount: 0,
        durationMs: 90,
      },
      sender,
    );

    // Firefox unloading this non-persistent event page after inactivity
    // resets every module-level variable, most importantly the in-memory
    // tabOutcomes cache - see background.js's own doc comment on it, and
    // __simulateEventPageUnloadForTests()'s.
    __simulateEventPageUnloadForTests();

    const outcome = await getTabState(601);
    assert.ok(outcome, 'the outcome must still be readable after the cache was wiped, via storage.session');
    assert.equal(outcome.status, OUTCOME_STATUS.HANDLED);
    assert.equal(outcome.domain, 'example.org');
    assert.equal(outcome.cmpName, 'OneTrust');
    assert.equal(outcome.stepCount, 2);
  });

  test('a lower-ranked report arriving right after an unload cannot downgrade an already-persisted higher-ranked outcome', async () => {
    // The scenario documented on OUTCOME_STATUS_RANK: a sub-frame reports
    // HANDLED, then - after this event page happened to be unloaded and
    // restarted in between, so the in-memory cache is cold - the top frame's
    // slower "suspected banner" scan settles and reports SUSPECTED_UNHANDLED
    // for the very same page load. The second report must not win just
    // because the cache forgot about the first one.
    const tabId = 602;
    const sender = { tab: { id: tabId, url: 'https://example.net/' }, frameId: 5 };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'example.net',
        cmpId: 'sourcepoint',
        cmpName: 'Sourcepoint',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 1,
        failedStepCount: 0,
        durationMs: 60,
      },
      sender,
    );

    __simulateEventPageUnloadForTests();

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'example.net',
        cmpId: null,
        cmpName: null,
        status: OUTCOME_STATUS.SUSPECTED_UNHANDLED,
      },
      { tab: { id: tabId, url: 'https://example.net/' }, frameId: 0 },
    );

    const outcome = await getTabState(tabId);
    assert.equal(outcome.status, OUTCOME_STATUS.HANDLED, 'the confirmed HANDLED outcome must survive the cold-cache report');
    assert.equal(outcome.cmpName, 'Sourcepoint');
  });
});

describe('background.js - tab navigation clears storage.session, not just the in-memory cache', () => {
  test('a new top-level navigation removes the previous outcome from storage, not only from the cache', async () => {
    const tabId = 701;
    const sender = { tab: { id: tabId, url: 'https://old-site.example/' }, frameId: 0 };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'old-site.example',
        cmpId: 'onetrust',
        cmpName: 'OneTrust',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 1,
        failedStepCount: 0,
        durationMs: 40,
      },
      sender,
    );

    assert.ok(await getTabState(tabId), 'sanity check: the outcome was recorded before navigating away');

    // Simulates tabs.onUpdated firing with status "loading" for a new
    // top-level navigation on the same tab id - the same event
    // background.js's addTabUpdatedListener callback reacts to.
    await clearTabState(tabId);

    // Not just the in-memory cache: the underlying storage.session key must
    // be gone too, otherwise a next getTabState() (cold-cache path) would
    // hydrate the previous page's stale outcome right back into the cache.
    const key = `refusenik.tabOutcome.${tabId}`;
    assert.equal(
      fakeSessionStorageBackingStore.has(key),
      false,
      'storage.session must no longer hold the previous page’s outcome after navigation',
    );

    const outcomeAfterNavigation = await getTabState(tabId);
    assert.equal(outcomeAfterNavigation, null, 'nothing must be recorded for this tab id until the new page reports something');
  });

  test('closing a tab (tabs.onRemoved) also clears storage.session for that tab id', async () => {
    const tabId = 702;
    const sender = { tab: { id: tabId, url: 'https://another-site.example/' }, frameId: 0 };

    await dispatch(
      {
        type: MESSAGE_OUTCOME,
        domain: 'another-site.example',
        cmpId: 'onetrust',
        cmpName: 'OneTrust',
        status: OUTCOME_STATUS.HANDLED,
        stepCount: 1,
        failedStepCount: 0,
        durationMs: 40,
      },
      sender,
    );

    await clearTabState(tabId);

    const key = `refusenik.tabOutcome.${tabId}`;
    assert.equal(fakeSessionStorageBackingStore.has(key), false);
    assert.equal(await getTabState(tabId), null);
  });
});
