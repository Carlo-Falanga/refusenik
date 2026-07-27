/**
 * The `kind` field on a CMP entry (docs/ARCHITETTURA.md): absence or
 * `"refuse"` authorize the engine to run a flow, `"consentOrPay"` means
 * recognition-only, and anything else - including a value this engine
 * version has simply never heard of - must fail closed. See
 * src/engine/detect.js's isActionableKind() and src/engine/content.js's use
 * of it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { validateRuleset } from '../src/engine/ruleset.js';
import { detectCMP, isActionableKind } from '../src/engine/detect.js';
import { runFlow } from '../src/engine/steps.js';

function makeDom(html = '<!doctype html><html><body></body></html>') {
  return new JSDOM(html, { runScripts: undefined }).window.document;
}

function baseRuleset(cmps) {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), rulesetVersion: 1, cmps };
}

describe('isActionableKind() - fail-closed contract', () => {
  test('an absent kind is actionable (implicit "refuse" default)', () => {
    assert.equal(isActionableKind(undefined), true);
  });

  test('"refuse" is actionable', () => {
    assert.equal(isActionableKind('refuse'), true);
  });

  test('"consentOrPay" is NOT actionable - recognition only', () => {
    assert.equal(isActionableKind('consentOrPay'), false);
  });

  test('an unrecognised kind is NOT actionable - never guessed as "refuse"', () => {
    assert.equal(isActionableKind('somethingFromANewerReleaseOfTheRuleset'), false);
  });

  test('is case-sensitive: "Refuse" is not the same as "refuse" and is not actionable', () => {
    assert.equal(isActionableKind('Refuse'), false);
  });
});

describe('validateRuleset() - schema accepts the kind field without judging its value', () => {
  function cmpWith(kind) {
    return {
      id: 'x',
      name: 'X',
      priority: 1,
      ...(kind !== undefined ? { kind } : {}),
      detect: [{ css: '#x' }],
      flow: [{ action: 'click', selector: { css: '#y' }, optional: true }],
    };
  }

  test('accepts a CMP entry with no kind field at all', () => {
    assert.equal(validateRuleset(baseRuleset([cmpWith(undefined)])), true);
  });

  test('accepts kind: "refuse"', () => {
    assert.equal(validateRuleset(baseRuleset([cmpWith('refuse')])), true);
  });

  test('accepts kind: "consentOrPay"', () => {
    assert.equal(validateRuleset(baseRuleset([cmpWith('consentOrPay')])), true);
  });

  test('accepts an unrecognised string kind - forward compatibility with a newer ruleset', () => {
    // A remote ruleset newer than this engine must not be discarded wholesale
    // just because it introduces a `kind` value this release does not yet
    // understand - the fail-closed behaviour belongs to isActionableKind(),
    // not to schema validation. See docs/ARCHITETTURA.md.
    assert.equal(validateRuleset(baseRuleset([cmpWith('somethingFromTheFuture')])), true);
  });

  test('rejects a non-string kind', () => {
    assert.equal(validateRuleset(baseRuleset([cmpWith(42)])), false);
  });
});

describe('an unactionable kind never runs its flow, at the point content.js decides whether to call runFlow()', () => {
  test('kind: "consentOrPay" - detected, but the flow is never invoked', async () => {
    const document = makeDom();
    const banner = document.createElement('div');
    banner.id = 'wall';
    document.body.appendChild(banner);
    const button = document.createElement('button');
    button.id = 'only-button';
    document.body.appendChild(button);
    let clicked = false;
    button.addEventListener('click', () => { clicked = true; });

    const ruleset = baseRuleset([{
      id: 'wall-cmp',
      name: 'Wall',
      kind: 'consentOrPay',
      priority: 10,
      detect: [{ css: '#wall' }],
      flow: [{ action: 'click', selector: { css: '#only-button' } }],
    }]);

    const cmp = detectCMP(ruleset, document);
    assert.ok(cmp);
    assert.equal(isActionableKind(cmp.kind), false);

    // Mirrors content.js's own gate exactly: runFlow is only ever called
    // when isActionableKind(cmp.kind) is true.
    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);

    assert.equal(clicked, false, 'a consentOrPay entry must never have its flow executed');
  });

  test('an unrecognised kind - detected, but the flow is never invoked either', async () => {
    const document = makeDom();
    const banner = document.createElement('div');
    banner.id = 'future-banner';
    document.body.appendChild(banner);
    const button = document.createElement('button');
    button.id = 'reject';
    document.body.appendChild(button);
    let clicked = false;
    button.addEventListener('click', () => { clicked = true; });

    const ruleset = baseRuleset([{
      id: 'future-cmp',
      name: 'Future CMP',
      kind: 'someKindThisEngineDoesNotKnowYet',
      priority: 10,
      detect: [{ css: '#future-banner' }],
      flow: [{ action: 'click', selector: { css: '#reject' } }],
    }]);

    const cmp = detectCMP(ruleset, document);
    assert.ok(cmp);
    assert.equal(isActionableKind(cmp.kind), false);

    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);

    assert.equal(clicked, false, 'a flow behind an unrecognised kind must never execute');
  });

  test('control case: kind absent - the flow DOES run', async () => {
    const document = makeDom();
    const banner = document.createElement('div');
    banner.id = 'ordinary-banner';
    document.body.appendChild(banner);
    const button = document.createElement('button');
    button.id = 'reject';
    document.body.appendChild(button);
    let clicked = false;
    button.addEventListener('click', () => { clicked = true; });

    const ruleset = baseRuleset([{
      id: 'ordinary-cmp',
      name: 'Ordinary CMP',
      priority: 10,
      detect: [{ css: '#ordinary-banner' }],
      flow: [{ action: 'click', selector: { css: '#reject' } }],
    }]);

    const cmp = detectCMP(ruleset, document);
    assert.ok(cmp);
    assert.equal(isActionableKind(cmp.kind), true);

    if (isActionableKind(cmp.kind)) await runFlow(cmp.flow, document);

    assert.equal(clicked, true, 'a CMP with no kind field must be handled exactly as before');
  });
});
