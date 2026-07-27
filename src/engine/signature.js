/**
 * Signature verification for the remote ruleset channel
 * (docs/ARCHITETTURA.md, "Firma del ruleset").
 *
 * Rules are declarative data, so the remote channel cannot smuggle in
 * executable code - but it could still smuggle in a hostile *action*: a
 * ruleset that clicks "accept all" instead of "reject", or clicks arbitrary
 * elements on arbitrary sites, for the whole user base, without failing any
 * schema check. Every remote ruleset is therefore signed with ECDSA P-256 /
 * SHA-256 and verified here, before the payload is ever parsed as JSON.
 *
 * P-256 rather than Ed25519: Ed25519 only reached WebCrypto in Chrome 137
 * (May 2025) and Firefox 129, with broad support not expected before
 * roughly 2027. Users on a runtime without it would silently stop
 * receiving ruleset updates - the exact advantage this product is built
 * on, lost without anyone noticing. ECDSA P-256 has had universal WebCrypto
 * support for over a decade, produces a signature the same size (64 bytes)
 * and a 91-byte SPKI public key, and needs no runtime dependency.
 *
 * The ruleset bundled with the extension package is NOT verified here - it
 * is implicitly trusted, protected by the extension store's own signature.
 * This module only guards the remote fetch path (src/engine/ruleset.js).
 */

// ---------------------------------------------------------------------------
// Public key, SPKI format, base64-encoded. This is the single point where
// the trusted signer for the remote ruleset is configured. Generate a
// matching keypair with `node tools/sign-ruleset.mjs keygen <path>`; the
// private key is never stored in this repository.
// ---------------------------------------------------------------------------
const RULESET_PUBLIC_KEY_SPKI_BASE64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbAJDnuEzTpb1ltYHMgvF4U6XCEv5dGj786m7NYrXZ9vBVbMtDja/cLXFPe2xhySzfgwAVrI9F6BzTnjul6gq9Q==';

const IMPORT_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const VERIFY_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };

/**
 * Decodes a base64 string into raw bytes. Throws on malformed input
 * (invalid base64) - callers in this module always run it inside a
 * try/catch so nothing ever escapes as an unhandled rejection.
 */
export function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error('empty or non-string base64 input');
  }
  const binary = atob(base64); // throws SyntaxError/InvalidCharacterError on malformed base64
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const importedKeyCache = new Map();

function importPublicKey(subtle, publicKeySpkiBase64) {
  if (!importedKeyCache.has(publicKeySpkiBase64)) {
    importedKeyCache.set(publicKeySpkiBase64, (async () => {
      const keyBytes = base64ToBytes(publicKeySpkiBase64);
      return subtle.importKey('spki', keyBytes, IMPORT_ALGORITHM, false, ['verify']);
    })());
  }
  return importedKeyCache.get(publicKeySpkiBase64);
}

/**
 * Verifies a detached ECDSA P-256/SHA-256 signature against `payloadBytes`,
 * using the one public key embedded in this file.
 *
 * This is the ONLY entry point production code may use, and it deliberately
 * takes no key argument: the trust anchor is not something a caller gets to
 * choose. An earlier revision let the key be overridden through an optional
 * third parameter; nothing in production passed it, but "safe because nobody
 * passes it" is one careless edit away from "an attacker-supplied key is
 * accepted". The override now lives in a separate, explicitly named function
 * that production code must never call.
 *
 * Never throws: a malformed public key, a malformed or wrong-length
 * signature, missing WebCrypto support, or any other failure all resolve
 * to `false` rather than rejecting. Callers must be able to treat this as
 * a plain boolean gate without their own try/catch.
 */
export async function verifyDetached(payloadBytes, signatureBytes) {
  return verifyDetachedWithKey(payloadBytes, signatureBytes, RULESET_PUBLIC_KEY_SPKI_BASE64);
}

/**
 * Verification against an explicitly supplied public key.
 *
 * TEST SEAM ONLY - production code must call verifyDetached() instead.
 * It exists because the private key matching the embedded public key
 * intentionally never lives in this repository, so the "a valid signature is
 * accepted" path could otherwise not be exercised at all: tests generate a
 * throwaway keypair and pass its public half here.
 */
export async function verifyDetachedWithKey(payloadBytes, signatureBytes, publicKeySpkiBase64) {
  try {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) return false;

    if (!isBinaryLike(payloadBytes) || !isBinaryLike(signatureBytes)) return false;

    let publicKey;
    try {
      publicKey = await importPublicKey(subtle, publicKeySpkiBase64);
    } catch {
      // Only invalidate the cache entry when the import itself failed (e.g.
      // a malformed key), not on an ordinary bad-signature case.
      importedKeyCache.delete(publicKeySpkiBase64);
      return false;
    }

    return await subtle.verify(VERIFY_ALGORITHM, publicKey, signatureBytes, payloadBytes);
  } catch {
    return false;
  }
}

function isBinaryLike(value) {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}
