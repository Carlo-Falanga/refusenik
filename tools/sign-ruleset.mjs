#!/usr/bin/env node
/**
 * Signing tool for the remote ruleset channel (docs/ARCHITETTURA.md,
 * "Firma del ruleset").
 *
 * Two commands:
 *
 *   node tools/sign-ruleset.mjs keygen <private-key-path>
 *     Generates an ECDSA P-256 keypair, writes the private key (PKCS8, PEM)
 *     to <private-key-path>, and prints the public key (SPKI, base64) to
 *     paste into src/engine/signature.js.
 *
 *   node tools/sign-ruleset.mjs sign <private-key-path> <ruleset-file>
 *     Signs the exact bytes of <ruleset-file> with the private key and
 *     writes the detached, base64-encoded signature to
 *     <ruleset-file>.sig.
 *
 * The private key must never live inside this repository: this script
 * refuses to write it there. Nothing here is imported by the extension
 * itself - it only runs as a local, offline tool.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const { subtle } = webcrypto;

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };

const PEM_PRIVATE_HEADER = '-----BEGIN PRIVATE KEY-----';
const PEM_PRIVATE_FOOTER = '-----END PRIVATE KEY-----';
const PEM_LINE_LENGTH = 64;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** True if `targetPath` resolves to a location inside the repository root. */
function isInsideRepo(targetPath) {
  const rel = relative(repoRoot, resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertOutsideRepo(targetPath) {
  if (isInsideRepo(targetPath)) {
    fail(
      `refusing to write the private key inside the repository (${resolve(targetPath)}).\n`
      + 'The private key must never be able to end up in a commit. Pass a path '
      + 'outside the project directory (e.g. in a password manager\'s vault or a '
      + 'dedicated secrets folder outside this repo).',
    );
  }
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function derToPem(der) {
  const base64 = bytesToBase64(der);
  const lines = [];
  for (let i = 0; i < base64.length; i += PEM_LINE_LENGTH) {
    lines.push(base64.slice(i, i + PEM_LINE_LENGTH));
  }
  return `${PEM_PRIVATE_HEADER}\n${lines.join('\n')}\n${PEM_PRIVATE_FOOTER}\n`;
}

function pemToDer(pem) {
  const body = pem
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('-----'))
    .join('');
  return base64ToBytes(body);
}

async function keygen(privateKeyPath) {
  if (!privateKeyPath) {
    fail('usage: node tools/sign-ruleset.mjs keygen <private-key-path>');
  }
  assertOutsideRepo(privateKeyPath);

  if (existsSync(privateKeyPath)) {
    fail(`refusing to overwrite existing file: ${resolve(privateKeyPath)}`);
  }

  const keyPair = await subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  const privateKeyDer = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey));
  writeFileSync(privateKeyPath, derToPem(privateKeyDer), { mode: 0o600 });

  const publicKeyDer = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey));
  const publicKeyBase64 = bytesToBase64(publicKeyDer);

  console.log(`Private key written to: ${resolve(privateKeyPath)}`);
  console.log('Keep it outside the repository and out of any commit.');
  console.log('');
  console.log('Public key (SPKI, base64) - paste into src/engine/signature.js:');
  console.log('');
  console.log(publicKeyBase64);
}

async function sign(privateKeyPath, rulesetPath) {
  if (!privateKeyPath || !rulesetPath) {
    fail('usage: node tools/sign-ruleset.mjs sign <private-key-path> <ruleset-file>');
  }
  if (!existsSync(privateKeyPath)) {
    fail(`private key not found: ${resolve(privateKeyPath)}`);
  }
  if (!existsSync(rulesetPath)) {
    fail(`ruleset file not found: ${resolve(rulesetPath)}`);
  }

  const privateKeyDer = pemToDer(readFileSync(privateKeyPath, 'utf8'));
  const privateKey = await subtle.importKey('pkcs8', privateKeyDer, ALGORITHM, false, ['sign']);

  const payload = readFileSync(rulesetPath);
  const signature = new Uint8Array(await subtle.sign(SIGN_ALGORITHM, privateKey, payload));
  const signatureBase64 = bytesToBase64(signature);

  const signaturePath = `${rulesetPath}.sig`;
  writeFileSync(signaturePath, signatureBase64, 'utf8');

  console.log(`Signature written to: ${resolve(signaturePath)}`);
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === 'keygen') {
    await keygen(args[0]);
    return;
  }

  if (command === 'sign') {
    await sign(args[0], args[1]);
    return;
  }

  console.error('usage:');
  console.error('  node tools/sign-ruleset.mjs keygen <private-key-path>');
  console.error('  node tools/sign-ruleset.mjs sign <private-key-path> <ruleset-file>');
  process.exit(1);
}

main().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
