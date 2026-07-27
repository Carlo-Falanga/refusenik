/**
 * Remote ruleset channel.
 *
 * - Bundled rules (shipped inside the package, owned by src/rules/) are the
 *   always-available fallback: the extension works on first run and offline.
 * - A remote ruleset is fetched periodically (every 12h at most), validated
 *   against the schema, and cached in storage.local.
 * - A candidate ruleset is rejected if: the schema is invalid, the
 *   schemaVersion is unknown, or the version is not monotonically
 *   increasing (see isNewerRuleset() for how "version" is interpreted -
 *   flagged to the orchestrator, the schema has no explicit version
 *   counter).
 * - On ANY error, the engine stays on the last valid ruleset. It must never
 *   degrade to "no rules".
 *
 * NOTE ON SCOPE: MV3 needs a persistent context (background/service worker)
 * for a strict timer-based 12h schedule. No background entry point/manifest
 * was part of this task's scope. This module instead exposes
 * `maybeRefreshRuleset()`, which content.js calls once per page load and
 * which performs the remote check only if >=12h elapsed since the last
 * attempt. If a background script is introduced later, it can call the same
 * functions (e.g. from a `chrome.alarms` handler) with no changes here.
 */

import { storageLocalGet, storageLocalSet, getExtensionUrl } from './browser-api.js';

// Single point of configuration for the remote ruleset endpoint.
export const REMOTE_RULESET_URL = 'https://rules.cookie-refuser.example/ruleset.json';

// Contract with src/rules/: the bundled fallback ruleset must be packaged at
// this path (relative to the extension root) and match the schema below.
const BUNDLED_RULESET_PATH = 'rules/ruleset.json';

const SUPPORTED_SCHEMA_VERSIONS = [1];
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

const STORAGE_KEY_RULESET = 'cookieRefuser.ruleset';
const STORAGE_KEY_LAST_ATTEMPT = 'cookieRefuser.rulesetLastAttempt';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSelectorLike(value) {
  return isPlainObject(value) && typeof value.css === 'string' && value.css.length > 0;
}

function isStepLike(value) {
  return isPlainObject(value) && typeof value.action === 'string';
}

function isCmpLike(cmp) {
  return (
    isPlainObject(cmp)
    && typeof cmp.id === 'string' && cmp.id.length > 0
    && typeof cmp.name === 'string'
    && typeof cmp.priority === 'number'
    && Array.isArray(cmp.detect) && cmp.detect.every(isSelectorLike)
    && Array.isArray(cmp.flow) && cmp.flow.every(isStepLike)
  );
}

/** Structural validation of a ruleset payload against the schema in docs/ARCHITETTURA.md. */
export function validateRuleset(data) {
  try {
    if (!isPlainObject(data)) return false;
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(data.schemaVersion)) return false;
    if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) return false;
    if (!Array.isArray(data.cmps)) return false;
    return data.cmps.every(isCmpLike);
  } catch {
    return false;
  }
}

/**
 * "Monotonically increasing version" check. The schema (docs/ARCHITETTURA.md)
 * only carries `generatedAt`, not a dedicated incrementing version counter -
 * see the report to the orchestrator. `generatedAt` is used as the version
 * signal: a candidate must be strictly newer than the ruleset currently
 * cached, otherwise it is rejected as stale/rollback.
 */
export function isNewerRuleset(candidate, current) {
  if (!current) return true;
  try {
    const candidateTime = Date.parse(candidate.generatedAt);
    const currentTime = Date.parse(current.generatedAt);
    if (Number.isNaN(candidateTime)) return false;
    if (Number.isNaN(currentTime)) return true;
    return candidateTime > currentTime;
  } catch {
    return false;
  }
}

/** Loads the ruleset bundled with the extension package. Returns null on any failure. */
export async function loadBundledRuleset() {
  try {
    const url = getExtensionUrl(BUNDLED_RULESET_PATH);
    const response = await fetch(url);
    const data = await response.json();
    return validateRuleset(data) ? data : null;
  } catch {
    return null;
  }
}

/** Reads the cached ruleset from storage.local. Returns null if absent or invalid. */
export async function getCachedRuleset() {
  try {
    const stored = await storageLocalGet(STORAGE_KEY_RULESET);
    const ruleset = stored && stored[STORAGE_KEY_RULESET];
    return ruleset && validateRuleset(ruleset) ? ruleset : null;
  } catch {
    return null;
  }
}

async function persistRuleset(ruleset) {
  await storageLocalSet({ [STORAGE_KEY_RULESET]: ruleset });
}

/**
 * Fetches the remote ruleset (a plain, parameter-free GET - see privacy
 * constraints in docs/ARCHITETTURA.md) and validates it against
 * `currentRuleset`. Returns the new ruleset only if it is schema-valid AND
 * strictly newer; otherwise returns null, leaving the caller on its current
 * ruleset. Never throws.
 */
export async function fetchAndValidateRemoteRuleset(currentRuleset) {
  // Mark the attempt up front (success or failure) so a persistently
  // invalid/unreachable remote endpoint cannot cause a refresh storm on
  // every page load within the interval.
  await storageLocalSet({ [STORAGE_KEY_LAST_ATTEMPT]: Date.now() });

  try {
    const response = await fetch(REMOTE_RULESET_URL, { method: 'GET', cache: 'no-store' });
    if (!response || !response.ok) return null;

    const data = await response.json();
    if (!validateRuleset(data)) return null;
    if (!isNewerRuleset(data, currentRuleset)) return null;

    await persistRuleset(data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Returns a usable ruleset: the cached valid ruleset if present, otherwise
 * the bundled fallback, otherwise a well-formed empty ruleset. Always
 * resolves to something callers can pass to detect()/runFlow() without a
 * null check - never "no rules" in the sense of throwing or returning null.
 */
export async function getActiveRuleset() {
  const cached = await getCachedRuleset();
  if (cached) return cached;

  const bundled = await loadBundledRuleset();
  if (bundled) return bundled;

  // Last-resort defensive default: only reached if both the cache and the
  // bundled package are unavailable/corrupt, which should not happen in a
  // correctly packaged extension.
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), cmps: [] };
}

/**
 * Opportunistic periodic refresh, meant to be called once per content
 * script run. Performs the remote fetch only if >=12h elapsed since the
 * last attempt. Always resolves to a valid ruleset: the refreshed one on
 * success, or the previously active one on any failure.
 */
export async function maybeRefreshRuleset() {
  const active = await getActiveRuleset();

  try {
    const stored = await storageLocalGet(STORAGE_KEY_LAST_ATTEMPT);
    const lastAttempt = stored && stored[STORAGE_KEY_LAST_ATTEMPT];
    const dueForRefresh = !lastAttempt || (Date.now() - lastAttempt) >= REFRESH_INTERVAL_MS;
    if (!dueForRefresh) return active;

    const refreshed = await fetchAndValidateRemoteRuleset(active);
    return refreshed || active;
  } catch {
    return active;
  }
}
