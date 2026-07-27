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
