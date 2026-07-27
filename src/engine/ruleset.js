/**
 * Remote ruleset channel.
 *
 * - Bundled rules (shipped inside the package, owned by src/rules/) are the
 *   always-available fallback: the extension works on first run and offline.
 *   They are implicitly trusted (protected by the extension store's own
 *   signature) and are never run through signature verification.
 * - A remote ruleset is fetched periodically (every 12h at most) as raw
 *   bytes, its detached signature verified (src/engine/signature.js),
 *   validated against the schema, checked for a strictly increasing
 *   `rulesetVersion`, and only then cached in storage.local.
 * - A candidate ruleset is rejected if: the signature does not verify, the
 *   schema is invalid, the schemaVersion is unknown, or `rulesetVersion` is
 *   not strictly greater than the cached ruleset's. A signature failure
 *   discards the candidate before it is even parsed as JSON - see
 *   fetchAndValidateRemoteRuleset().
 * - On ANY error, the engine stays on the last valid ruleset. It must never
 *   degrade to "no rules".
 *
 * OWNERSHIP: this module is only ever called from the background
 * (src/engine/background.js). Content scripts never import it directly -
 * they ask the background for the active ruleset over `runtime.sendMessage`,
 * so the ruleset never needs to be exposed via `web_accessible_resources`
 * and the remote endpoint is fetched at most once per refresh window rather
 * than once per open tab. `maybeRefreshRuleset()` is 12h-gated internally
 * (via storage, not a timer) and is invoked by the background both from its
 * `browser.alarms` handler and once at startup, to also cover the case
 * where the event page was unloaded across an entire window.
 */

import { storageLocalGet, storageLocalSet, getExtensionUrl } from './browser-api.js';
import { verifyDetached, base64ToBytes } from './signature.js';

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
  return (
    isPlainObject(value)
    && typeof value.css === 'string' && value.css.length > 0
    // `textMatchRef` is a build-time-only field (see
    // src/rules/expandTextMatchRefs.js): a shipped/remote ruleset must never
    // carry one. Rejecting it here means a ruleset that skipped resolution
    // fails schema validation wholesale and is discarded, instead of merely
    // having that one selector fail closed at match time.
    && !('textMatchRef' in value)
  );
}

function isStepLike(value) {
  return isPlainObject(value) && typeof value.action === 'string';
}

/**
 * A CMP entry's optional `kind` field (docs/ARCHITETTURA.md). Schema
 * validation only checks its type here, never its specific value: a `kind`
 * this engine version does not recognise must still pass schema validation,
 * otherwise a ruleset that is merely newer than the engine (using a `kind`
 * value introduced by a later release) would be discarded wholesale instead
 * of degrading gracefully. The fail-closed behaviour for an unrecognised
 * `kind` - never running its flow - lives at the point of use,
 * isActionableKind() in src/engine/detect.js, not here.
 */
function isKindLike(value) {
  return value === undefined || typeof value === 'string';
}

function isCmpLike(cmp) {
  return (
    isPlainObject(cmp)
    && typeof cmp.id === 'string' && cmp.id.length > 0
    && typeof cmp.name === 'string'
    && typeof cmp.priority === 'number'
    && isKindLike(cmp.kind)
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
    if (!Number.isInteger(data.rulesetVersion)) return false;
    if (!Array.isArray(data.cmps)) return false;
    return data.cmps.every(isCmpLike);
  } catch {
    return false;
  }
}

/**
 * "Monotonically increasing version" check, per docs/ARCHITETTURA.md:
 * `rulesetVersion` (integer) is the version signal, not `generatedAt` -
 * the latter depends on the server's clock and is ambiguous on rollback.
 * A candidate is accepted only if its `rulesetVersion` is strictly greater
 * than the currently cached ruleset's.
 */
export function isNewerRuleset(candidate, current) {
  if (!current) return true;
  try {
    if (!Number.isInteger(candidate.rulesetVersion)) return false;
    if (!Number.isInteger(current.rulesetVersion)) return true;
    return candidate.rulesetVersion > current.rulesetVersion;
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

// Detached signature for REMOTE_RULESET_URL, fetched as base64 text.
const REMOTE_RULESET_SIGNATURE_URL = `${REMOTE_RULESET_URL}.sig`;

/**
 * Fetches the remote ruleset (a plain, parameter-free GET - see privacy
 * constraints in docs/ARCHITETTURA.md) together with its detached
 * signature, and validates it against `currentRuleset`.
 *
 * Security-critical order, per docs/ARCHITETTURA.md - never reorder this:
 *   1. Download the ruleset as raw bytes (not `.json()`).
 *   2. Download the detached signature (base64 text).
 *   3. Verify the signature against those exact bytes.
 *   4. Only if the signature is valid: parse JSON, run schema validation,
 *      then check `rulesetVersion` is strictly newer.
 * An unauthenticated payload is never parsed, let alone acted upon.
 *
 * Returns the new ruleset only if every step above succeeds; otherwise
 * returns null, leaving the caller on its current ruleset. Never throws.
 */
export async function fetchAndValidateRemoteRuleset(currentRuleset) {
  // Mark the attempt up front (success or failure) so a persistently
  // invalid/unreachable remote endpoint cannot cause a refresh storm on
  // every page load within the interval.
  await storageLocalSet({ [STORAGE_KEY_LAST_ATTEMPT]: Date.now() });

  try {
    const response = await fetch(REMOTE_RULESET_URL, { method: 'GET', cache: 'no-store' });
    if (!response || !response.ok) return null;
    const payloadBytes = await response.arrayBuffer();

    const signatureResponse = await fetch(REMOTE_RULESET_SIGNATURE_URL, { method: 'GET', cache: 'no-store' });
    if (!signatureResponse || !signatureResponse.ok) return null;
    const signatureBase64 = (await signatureResponse.text()).trim();

    let signatureBytes;
    try {
      signatureBytes = base64ToBytes(signatureBase64);
    } catch {
      return null; // Malformed base64 - never let a bad signature reach verification/parsing.
    }

    const verified = await verifyDetached(payloadBytes, signatureBytes);
    if (!verified) return null;

    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      return null;
    }

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
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), rulesetVersion: 0, cmps: [] };
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
