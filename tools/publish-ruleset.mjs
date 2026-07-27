#!/usr/bin/env node
/**
 * Publishes a freshly built ruleset to site/, the folder Vercel serves as
 * static files (site/vercel.json). This is the one script that produces the
 * exact artifacts users' extensions download and verify.
 *
 * Rerunnable: node tools/publish-ruleset.mjs <private-key-path>
 *
 * In order:
 *   1. Require dist/rules/ruleset.json to exist (run `npm run build` first).
 *   2. Read its rulesetVersion, and the currently published one from
 *      site/ruleset.json, if any.
 *   3. Refuse to publish if the new version is not strictly greater: the
 *      extension's own version check (src/engine/ruleset.js,
 *      isNewerRuleset()) would silently discard the "update", so a
 *      publish that appears to succeed would in fact reach nobody.
 *   4. Copy the built ruleset to site/ruleset.json.
 *   5. Sign it, reusing tools/sign-ruleset.mjs's sign() rather than
 *      duplicating the cryptographic code.
 *   6. Re-read both files from disk and verify the signature with
 *      src/engine/signature.js's verifyDetached() - the exact function the
 *      extension itself calls - so a publish that the extension would
 *      reject is never left looking successful.
 *   7. Print a summary: published version, size in bytes, verification
 *      outcome.
 *
 * The private key never leaves the machine running this script: it is read
 * from the path given on the command line and is never written anywhere
 * under this repository.
 */

import { readFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sign } from './sign-ruleset.mjs';
import { verifyDetached, base64ToBytes } from '../src/engine/signature.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const BUILT_RULESET_PATH = join(repoRoot, 'dist', 'rules', 'ruleset.json');
const SITE_DIR = join(repoRoot, 'site');
const PUBLISHED_RULESET_PATH = join(SITE_DIR, 'ruleset.json');
const PUBLISHED_SIGNATURE_PATH = join(SITE_DIR, 'ruleset.json.sig');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readRulesetVersion(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isInteger(data.rulesetVersion)) {
    fail(`${path} has no integer rulesetVersion - it is not a valid ruleset file.`);
  }
  return data.rulesetVersion;
}

async function publish(privateKeyPath) {
  if (!privateKeyPath) {
    fail('usage: node tools/publish-ruleset.mjs <private-key-path>');
  }

  if (!existsSync(BUILT_RULESET_PATH)) {
    fail(
      `${BUILT_RULESET_PATH} does not exist. Run "npm run build" first to produce it, `
      + 'then rerun this script.',
    );
  }

  const candidateVersion = readRulesetVersion(BUILT_RULESET_PATH);
  const publishedVersion = existsSync(PUBLISHED_RULESET_PATH)
    ? readRulesetVersion(PUBLISHED_RULESET_PATH)
    : null;

  if (publishedVersion !== null && candidateVersion <= publishedVersion) {
    fail(
      `candidate rulesetVersion (${candidateVersion}) is not strictly greater than the `
      + `currently published one (${publishedVersion}). Refusing to publish: the extension `
      + '(src/engine/ruleset.js, isNewerRuleset()) only accepts a remote ruleset whose '
      + 'rulesetVersion is strictly greater than the one it already has cached, so it would '
      + 'silently discard this "update" while the publish itself would look successful. '
      + 'Bump rulesetVersion in src/rules/rules.json, rebuild, and rerun this script.',
    );
  }

  copyFileSync(BUILT_RULESET_PATH, PUBLISHED_RULESET_PATH);

  await sign(privateKeyPath, PUBLISHED_RULESET_PATH);

  const payloadBytes = readFileSync(PUBLISHED_RULESET_PATH);
  const signatureBase64 = readFileSync(PUBLISHED_SIGNATURE_PATH, 'utf8').trim();

  let signatureBytes;
  try {
    signatureBytes = base64ToBytes(signatureBase64);
  } catch (error) {
    fail(`just-written signature file is not valid base64: ${error.message}`);
  }

  const verified = await verifyDetached(payloadBytes, signatureBytes);
  if (!verified) {
    fail(
      'signature verification failed for the ruleset just published - the extension would '
      + 'reject it too. Not leaving this as a silent-looking success.',
    );
  }

  const rulesetSize = statSync(PUBLISHED_RULESET_PATH).size;
  const signatureSize = statSync(PUBLISHED_SIGNATURE_PATH).size;

  console.log('Published ruleset:');
  console.log(`  rulesetVersion: ${candidateVersion}`);
  console.log(`  ${PUBLISHED_RULESET_PATH} (${rulesetSize} bytes)`);
  console.log(`  ${PUBLISHED_SIGNATURE_PATH} (${signatureSize} bytes)`);
  console.log(`  signature verification: ${verified ? 'PASSED' : 'FAILED'}`);
}

publish(process.argv[2]).catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
