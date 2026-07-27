/**
 * Cross-browser WebExtension API shim.
 *
 * Firefox exposes the promise-based `browser` global. Chrome (MV3) exposes
 * the callback-based `chrome` global (Firefox also exposes `chrome` as an
 * alias, so `browser` is checked first). This module normalizes both into a
 * small promise-based surface so the rest of the engine never branches on
 * the runtime. Nothing here interprets or executes remote/dynamic code -
 * it only wraps a few well-known extension APIs.
 *
 * Outside an extension context (e.g. unit tests run under plain Node) both
 * globals are undefined; every exported function degrades to a harmless
 * no-op/empty result instead of throwing.
 */

/** The raw extension API object for the current runtime, or null outside an extension context. */
export const extensionApi =
  (typeof globalThis.browser !== 'undefined' && globalThis.browser) ||
  (typeof globalThis.chrome !== 'undefined' && globalThis.chrome) ||
  null;

// Firefox's `browser.*` namespace is promise-based natively. `chrome.*` is
// callback-based (older Chrome) but modern Chrome versions also resolve a
// promise when the callback is omitted; we still wrap defensively for the
// lowest common denominator.
const isPromiseNative = typeof globalThis.browser !== 'undefined';

function callbackToPromise(fn, thisArg, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn.call(thisArg, ...args, (result) => {
        const lastError = extensionApi && extensionApi.runtime && extensionApi.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || String(lastError)));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** Reads one or more keys from storage.local. Never throws; returns {} on any failure. */
export async function storageLocalGet(keys) {
  if (!extensionApi || !extensionApi.storage || !extensionApi.storage.local) return {};
  try {
    if (isPromiseNative) return (await extensionApi.storage.local.get(keys)) || {};
    return (await callbackToPromise(extensionApi.storage.local.get, extensionApi.storage.local, keys)) || {};
  } catch {
    return {};
  }
}

/** Writes items to storage.local. Never throws; failures are silently dropped. */
export async function storageLocalSet(items) {
  if (!extensionApi || !extensionApi.storage || !extensionApi.storage.local) return;
  try {
    if (isPromiseNative) {
      await extensionApi.storage.local.set(items);
      return;
    }
    await callbackToPromise(extensionApi.storage.local.set, extensionApi.storage.local, items);
  } catch {
    /* Storage write failures must never crash the caller. */
  }
}

/** Sends a message to the extension's background/runtime. Never throws. */
export async function sendRuntimeMessage(message) {
  if (!extensionApi || !extensionApi.runtime || !extensionApi.runtime.sendMessage) return undefined;
  try {
    if (isPromiseNative) return await extensionApi.runtime.sendMessage(message);
    return await callbackToPromise(extensionApi.runtime.sendMessage, extensionApi.runtime, message);
  } catch {
    return undefined;
  }
}

/** Resolves a path bundled with the extension to a loadable URL. Falls back to the raw path outside an extension context. */
export function getExtensionUrl(path) {
  if (!extensionApi || !extensionApi.runtime || !extensionApi.runtime.getURL) return path;
  try {
    return extensionApi.runtime.getURL(path);
  } catch {
    return path;
  }
}

/**
 * Registers `handler` for messages sent via sendRuntimeMessage (from any
 * context - content script, popup, etc.). `handler(message, sender)` may
 * return a value or a Promise to send back as the reply, or `undefined` to
 * leave the message unanswered by this listener.
 *
 * Never throws; a missing runtime.onMessage API (e.g. plain Node, as in
 * unit tests) is a silent no-op. Firefox resolves an async reply by letting
 * the listener return a Promise directly; Chrome's callback-based listeners
 * additionally need `sendResponse` plus a `true` return to keep the channel
 * open, so both are covered here.
 */
export function addRuntimeMessageListener(handler) {
  if (!extensionApi || !extensionApi.runtime || !extensionApi.runtime.onMessage) return;
  try {
    extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      let result;
      try {
        result = handler(message, sender);
      } catch {
        return undefined;
      }

      if (result && typeof result.then === 'function') {
        if (isPromiseNative) return result;
        result.then(sendResponse).catch(() => sendResponse(undefined));
        return true;
      }

      return result;
    });
  } catch {
    /* ignore */
  }
}

/** Creates or replaces a named alarm. Never throws; a missing alarms API is a silent no-op. */
export function alarmsCreate(name, alarmInfo) {
  if (!extensionApi || !extensionApi.alarms || !extensionApi.alarms.create) return;
  try {
    extensionApi.alarms.create(name, alarmInfo);
  } catch {
    /* ignore */
  }
}

/** Registers `handler(alarm)` to run whenever any alarm fires. Never throws. */
export function addAlarmListener(handler) {
  if (!extensionApi || !extensionApi.alarms || !extensionApi.alarms.onAlarm) return;
  try {
    extensionApi.alarms.onAlarm.addListener((alarm) => {
      try {
        handler(alarm);
      } catch {
        /* A single failed refresh must not unregister the listener. */
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * Resolves only the numeric id of the current window's active tab, or
 * `null`. Deliberately reads nothing else off the tab object: `tabs.query`
 * works without the `tabs` permission, but fields like `url`/`title` are
 * redacted unless the extension also holds a host permission for that tab -
 * so this popup-only helper never asks for more than the id in the first
 * place, and never needs the `tabs` permission declared in the manifest.
 */
export async function queryActiveTabId() {
  if (!extensionApi || !extensionApi.tabs || !extensionApi.tabs.query) return null;
  try {
    const query = { active: true, currentWindow: true };
    const tabs = isPromiseNative
      ? await extensionApi.tabs.query(query)
      : await callbackToPromise(extensionApi.tabs.query, extensionApi.tabs, query);
    const tab = Array.isArray(tabs) ? tabs[0] : null;
    return tab && typeof tab.id === 'number' ? tab.id : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether the extension currently holds the broad `<all_urls>` host
 * permission declared in the manifest. Firefox lets users revoke a granted
 * host permission after install (site access set to "Never"/"On click"),
 * without uninstalling the extension - this is how the popup tells that
 * case apart from "nothing to do on this page" (docs: state 5 vs state 4).
 *
 * `permissions.contains` needs no `permissions` manifest entry of its own -
 * it only ever reports on the calling extension's own grants.
 *
 * Fails OPEN (returns true) if the check itself cannot be performed (e.g.
 * outside an extension context, or an unexpected API error): the absence of
 * evidence that access was revoked must not be read as "access revoked".
 */
export async function hasAllUrlsPermission() {
  if (!extensionApi || !extensionApi.permissions || !extensionApi.permissions.contains) return true;
  try {
    const query = { origins: ['<all_urls>'] };
    if (isPromiseNative) return await extensionApi.permissions.contains(query);
    return await callbackToPromise(extensionApi.permissions.contains, extensionApi.permissions, query);
  } catch {
    return true;
  }
}

/** Reads the extension's own version from its manifest. Returns '0.0.0' if unavailable. */
export function getExtensionVersion() {
  if (!extensionApi || !extensionApi.runtime || !extensionApi.runtime.getManifest) return '0.0.0';
  try {
    const manifest = extensionApi.runtime.getManifest();
    return (manifest && manifest.version) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Looks up a localized string from the extension's messages.json (see
 * _locales/en). Falls back to returning `key` itself outside an extension
 * context, so UI code stays readable even when run under a plain test
 * harness.
 */
export function getMessage(key, substitutions) {
  if (!extensionApi || !extensionApi.i18n || !extensionApi.i18n.getMessage) return key;
  try {
    return extensionApi.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

/**
 * Registers `handler(tabId, changeInfo)` for `tabs.onUpdated`. Used by the
 * background only to clear a tab's recorded outcome as soon as a new
 * top-level navigation starts (changeInfo.status === 'loading'), so a stale
 * result from the previous page never lingers into the next one. Firing
 * this event needs no `tabs` permission (only some `Tab` fields would be
 * redacted without it, and none of those are read here).
 */
export function addTabUpdatedListener(handler) {
  if (!extensionApi || !extensionApi.tabs || !extensionApi.tabs.onUpdated) return;
  try {
    extensionApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
      try {
        handler(tabId, changeInfo);
      } catch {
        /* A single bad callback must not unregister the listener. */
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * Registers `handler(tabId)` for `tabs.onRemoved`, so the background can
 * drop that tab's recorded outcome. No sensitive data is ever passed to
 * this event, so - like `onUpdated` above - it needs no `tabs` permission.
 */
export function addTabRemovedListener(handler) {
  if (!extensionApi || !extensionApi.tabs || !extensionApi.tabs.onRemoved) return;
  try {
    extensionApi.tabs.onRemoved.addListener((tabId) => {
      try {
        handler(tabId);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}
