/**
 * Signature verification for the remote ruleset channel.
 *
 * Covers the primitive (verifyDetached) directly, and the integration with
 * ruleset.js's fetch path: a ruleset with an invalid/missing signature must
 * never be parsed, validated, or allowed to replace the currently active
 * ruleset.
 *
 * These tests never use the real embedded public key's matching private
 * key - it intentionally does not exist in this repository. Tests that need
 * to exercise the "valid signature is accepted" path generate their own
 * local keypair and pass its public half through verifyDetached()'s
 * testing-only third parameter (see src/engine/signature.js). Tests that
 * exercise rejection call the two-argument, production form, which always
 * verifies against the real embedded key.
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { verifyDetached, verifyDetachedWithKey, base64ToBytes } from '../src/engine/signature.js';
import { fetchAndValidateRemoteRuleset } from '../src/engine/ruleset.js';

const { subtle } = webcrypto;
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };

async function generateKeyPair() {
  return subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
}

async function signWith(privateKey, bytes) {
  const signature = await subtle.sign(SIGN_ALGORITHM, privateKey, bytes);
  return new Uint8Array(signature);
}

async function publicKeyToBase64(publicKey) {
  const spki = new Uint8Array(await subtle.exportKey('spki', publicKey));
  return bytesToBase64(spki);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

describe('signature.js - verifyDetached, acceptance path (local test keypair)', () => {
  test('a valid signature over the exact payload is accepted', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const payload = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, rulesetVersion: 1 }));
    const signature = await signWith(privateKey, payload);
    const publicKeyBase64 = await publicKeyToBase64(publicKey);

    const result = await verifyDetachedWithKey(payload, signature, publicKeyBase64);
    assert.equal(result, true);
  });

  test('a payload tampered by a single byte is rejected, even with an otherwise valid signature/key pair', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const payload = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, rulesetVersion: 1, cmps: [] }));
    const signature = await signWith(privateKey, payload);
    const publicKeyBase64 = await publicKeyToBase64(publicKey);

    const tampered = new Uint8Array(payload);
    tampered[5] = tampered[5] ^ 0xff; // flip a single byte

    const result = await verifyDetachedWithKey(tampered, signature, publicKeyBase64);
    assert.equal(result, false);
  });

  test('accepting a payload against ArrayBuffer inputs (as delivered by fetch) works the same as Uint8Array', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const payload = new TextEncoder().encode('{"a":1}');
    const signature = await signWith(privateKey, payload);
    const publicKeyBase64 = await publicKeyToBase64(publicKey);

    const payloadBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    const signatureBuffer = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength);

    const result = await verifyDetachedWithKey(payloadBuffer, signatureBuffer, publicKeyBase64);
    assert.equal(result, true);
  });
});

describe('signature.js - verifyDetached, rejection path (against the real embedded key)', () => {
  test('a signature produced by a different (unrelated) key is rejected', async () => {
    const payload = new TextEncoder().encode('{"schemaVersion":1}');
    const foreignKeyPair = await generateKeyPair();
    const signature = await signWith(foreignKeyPair.privateKey, payload);

    // Two-argument call: verifies against the real embedded public key,
    // which does not match `foreignKeyPair`.
    const result = await verifyDetached(payload, signature);
    assert.equal(result, false);
  });

  test('a malformed (wrong-length) signature is rejected without throwing', async () => {
    const payload = new TextEncoder().encode('hello');
    const tooShort = new Uint8Array([1, 2, 3]);

    await assert.doesNotReject(async () => {
      const result = await verifyDetached(payload, tooShort);
      assert.equal(result, false);
    });
  });

  test('non-binary signature input (base64 string, null, undefined) is rejected without throwing', async () => {
    const payload = new TextEncoder().encode('hello');

    await assert.doesNotReject(async () => {
      assert.equal(await verifyDetachedWithKey(payload, 'c29tZS1iYXNlNjQ='), false);
      assert.equal(await verifyDetachedWithKey(payload, null), false);
      assert.equal(await verifyDetachedWithKey(payload, undefined), false); // signature absent
    });
  });

  test('non-binary payload input is rejected without throwing', async () => {
    const signature = new Uint8Array(64);
    await assert.doesNotReject(async () => {
      assert.equal(await verifyDetachedWithKey('not-bytes', signature), false);
      assert.equal(await verifyDetachedWithKey(null, signature), false);
    });
  });
});

describe('signature.js - base64ToBytes', () => {
  test('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const decoded = base64ToBytes(bytesToBase64(original));
    assert.deepEqual(Array.from(decoded), Array.from(original));
  });

  test('throws (rather than silently coercing) on malformed or empty base64', () => {
    assert.throws(() => base64ToBytes('***not-base64***'));
    assert.throws(() => base64ToBytes(''));
    assert.throws(() => base64ToBytes(undefined));
  });
});

describe('ruleset.js - fetchAndValidateRemoteRuleset (signature-first integration)', () => {
  const originalFetch = globalThis.fetch;

  function stubFetch(handler) {
    globalThis.fetch = mock.fn(handler);
  }

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  function rulesetResponse(bodyBytes, ok = true) {
    return {
      ok,
      arrayBuffer: async () => bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
    };
  }

  function sigResponse(base64Text, ok = true) {
    return { ok, text: async () => base64Text };
  }

  const validRuleset = {
    schemaVersion: 1,
    generatedAt: '2026-07-27T00:00:00Z',
    rulesetVersion: 5,
    cmps: [],
  };
  const validRulesetBytes = new TextEncoder().encode(JSON.stringify(validRuleset));

  test('remote ruleset signed by a foreign (non-embedded) key is rejected; caller stays on the current ruleset', async (t) => {
    const foreignKeyPair = await generateKeyPair();
    const foreignSignature = await signWith(foreignKeyPair.privateKey, validRulesetBytes);
    const foreignSignatureBase64 = bytesToBase64(foreignSignature);

    let call = 0;
    stubFetch(async () => {
      call += 1;
      if (call === 1) return rulesetResponse(validRulesetBytes);
      return sigResponse(foreignSignatureBase64);
    });
    t.after(restoreFetch);

    const current = { schemaVersion: 1, generatedAt: '2026-07-01T00:00:00Z', rulesetVersion: 1, cmps: [] };
    const result = await fetchAndValidateRemoteRuleset(current);

    assert.equal(result, null);
  });

  test('remote ruleset with a payload tampered by one byte is rejected, current ruleset stays active', async (t) => {
    const foreignKeyPair = await generateKeyPair();
    const signatureOverOriginal = await signWith(foreignKeyPair.privateKey, validRulesetBytes);

    const tampered = new Uint8Array(validRulesetBytes);
    tampered[10] = tampered[10] ^ 0xff; // flip a single byte

    let call = 0;
    stubFetch(async () => {
      call += 1;
      if (call === 1) return rulesetResponse(tampered);
      return sigResponse(bytesToBase64(signatureOverOriginal));
    });
    t.after(restoreFetch);

    const current = { schemaVersion: 1, generatedAt: '2026-07-01T00:00:00Z', rulesetVersion: 1, cmps: [] };
    const result = await fetchAndValidateRemoteRuleset(current);

    assert.equal(result, null);
  });

  test('missing signature file (fetch not ok) leaves the current ruleset in place, without throwing', async (t) => {
    let call = 0;
    stubFetch(async () => {
      call += 1;
      if (call === 1) return rulesetResponse(validRulesetBytes);
      return sigResponse('', false); // .sig fetch fails (e.g. 404)
    });
    t.after(restoreFetch);

    const current = { schemaVersion: 1, generatedAt: '2026-07-01T00:00:00Z', rulesetVersion: 1, cmps: [] };

    await assert.doesNotReject(async () => {
      const result = await fetchAndValidateRemoteRuleset(current);
      assert.equal(result, null);
    });
  });

  test('malformed base64 in the signature response is rejected without throwing; the invalid payload is never parsed/acted on', async (t) => {
    let call = 0;
    stubFetch(async () => {
      call += 1;
      if (call === 1) return rulesetResponse(validRulesetBytes);
      return sigResponse('***not valid base64***');
    });
    t.after(restoreFetch);

    const current = { schemaVersion: 1, generatedAt: '2026-07-01T00:00:00Z', rulesetVersion: 1, cmps: [] };

    await assert.doesNotReject(async () => {
      const result = await fetchAndValidateRemoteRuleset(current);
      assert.equal(result, null);
    });
  });
});
