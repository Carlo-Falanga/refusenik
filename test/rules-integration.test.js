/**
 * Integration contract between src/rules/ and src/engine/.
 *
 * These two are built independently, so nothing guarantees they agree on the
 * shape of the data unless it is asserted. The first time they were written in
 * parallel the rules used `type` as the step discriminator while the engine
 * read `action`: every step would have been silently discarded as an unknown
 * action, on every site, with no error anywhere. Detection would have worked
 * and nothing else would.
 *
 * These tests exist so that failure mode can never happen quietly again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

import { validateRuleset } from '../src/engine/ruleset.js';
import { detectCMP } from '../src/engine/detect.js';
import { runFlow } from '../src/engine/steps.js';
import { resolveTextMatchRefs, assertNoUnresolvedRefs } from '../src/rules/expandTextMatchRefs.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(here, '..', 'src', 'rules', 'rules.json');
const labelsPath = join(here, '..', 'src', 'rules', 'labels.json');
const ruleset = JSON.parse(readFileSync(rulesPath, 'utf8'));
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));

/** Must stay in sync with the switch in src/engine/steps.js. */
const KNOWN_ACTIONS = new Set(['waitFor', 'click', 'setCheckbox', 'setAriaToggle', 'hide']);

describe('rules.json <-> engine contract', () => {
  test('the shipped ruleset (after textMatchRef resolution) passes the engine validator', () => {
    // src/rules/rules.json is the AUTHORED source and may legitimately carry
    // build-time-only `textMatchRef` fields the engine validator rejects on
    // purpose (see src/engine/ruleset.js). What actually ships is the
    // resolved ruleset build.mjs writes to dist/rules/ruleset.json, so that
    // is what must satisfy the engine's contract here.
    const resolved = resolveTextMatchRefs(ruleset, labels);
    assert.equal(validateRuleset(resolved), true);
  });

  test('every step uses an action the engine actually implements', () => {
    const unknown = [];
    for (const cmp of ruleset.cmps) {
      for (const [i, step] of cmp.flow.entries()) {
        if (!KNOWN_ACTIONS.has(step.action)) {
          unknown.push(`${cmp.id}.flow[${i}]: ${JSON.stringify(step.action)}`);
        }
      }
    }
    assert.deepEqual(unknown, [], `steps the engine would silently ignore:\n${unknown.join('\n')}`);
  });

  test('no step carries a stray discriminator field', () => {
    // Guards against a rules author reintroducing `type` alongside `action`.
    const stray = [];
    for (const cmp of ruleset.cmps) {
      for (const [i, step] of cmp.flow.entries()) {
        if ('type' in step) stray.push(`${cmp.id}.flow[${i}]`);
      }
    }
    assert.deepEqual(stray, []);
  });

  test('every selector is resolvable by the engine (has a css string)', () => {
    const bad = [];
    const checkSelector = (sel, where) => {
      if (!sel || typeof sel.css !== 'string' || sel.css.length === 0) bad.push(where);
      if (sel && sel.textMatchMode && !['contains', 'exact'].includes(sel.textMatchMode)) {
        bad.push(`${where}: unsupported textMatchMode ${sel.textMatchMode}`);
      }
    };
    for (const cmp of ruleset.cmps) {
      cmp.detect.forEach((s, i) => checkSelector(s, `${cmp.id}.detect[${i}]`));
      cmp.flow.forEach((step, i) => {
        if (step.selector) checkSelector(step.selector, `${cmp.id}.flow[${i}].selector`);
        if (step.ifExists) checkSelector(step.ifExists, `${cmp.id}.flow[${i}].ifExists`);
      });
    }
    assert.deepEqual(bad, []);
  });

  test('cmp ids are unique', () => {
    const ids = ruleset.cmps.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('rules.json <-> labels.json contract (textMatch / textMatchRef)', () => {
  test('a selector never carries both textMatch and textMatchRef', () => {
    const offenders = [];
    const checkSelector = (sel, where) => {
      if (sel && 'textMatch' in sel && 'textMatchRef' in sel) offenders.push(where);
    };
    for (const cmp of ruleset.cmps) {
      cmp.detect.forEach((s, i) => checkSelector(s, `${cmp.id}.detect[${i}]`));
      cmp.flow.forEach((step, i) => {
        if (step.selector) checkSelector(step.selector, `${cmp.id}.flow[${i}].selector`);
        if (step.ifExists) checkSelector(step.ifExists, `${cmp.id}.flow[${i}].ifExists`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  test('every literal textMatch is a non-empty string or a non-empty array of non-empty strings', () => {
    const bad = [];
    const checkSelector = (sel, where) => {
      if (!sel || !('textMatch' in sel)) return;
      const tm = sel.textMatch;
      const valid = typeof tm === 'string'
        ? tm.length > 0
        : Array.isArray(tm) && tm.length > 0 && tm.every((v) => typeof v === 'string' && v.length > 0);
      if (!valid) bad.push(where);
    };
    for (const cmp of ruleset.cmps) {
      cmp.detect.forEach((s, i) => checkSelector(s, `${cmp.id}.detect[${i}]`));
      cmp.flow.forEach((step, i) => {
        if (step.selector) checkSelector(step.selector, `${cmp.id}.flow[${i}].selector`);
        if (step.ifExists) checkSelector(step.ifExists, `${cmp.id}.flow[${i}].ifExists`);
      });
    }
    assert.deepEqual(bad, []);
  });

  test('every textMatchRef in rules.json resolves against labels.json without guessing', () => {
    assert.doesNotThrow(() => {
      const resolved = resolveTextMatchRefs(ruleset, labels);
      assertNoUnresolvedRefs(resolved);
    });
  });

  test('an unknown textMatchRef is rejected at build time rather than silently ignored', () => {
    const broken = {
      schemaVersion: 1,
      cmps: [{
        id: 'broken',
        name: 'Broken',
        priority: 1,
        detect: [{ css: '#x' }],
        flow: [{ action: 'click', selector: { css: '#y', textMatchRef: 'doesNotExist' } }],
      }],
    };
    assert.throws(() => resolveTextMatchRefs(broken, labels));
  });
});

describe('consent-or-pay walls: recognised without acting (docs/ARCHITETTURA.md, src/rules/NOTE.md)', () => {
  const resolved = resolveTextMatchRefs(ruleset, labels);

  function domWithBody(html) {
    return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: undefined }).window.document;
  }

  test('repubblica.it (Iubenda banner + subscribe-wall marker) is detected as the consent-or-pay entry, not generic Iubenda', () => {
    // repubblica.it genuinely runs the generic Iubenda widget AND is a
    // consent-or-pay wall at once - the dangerous case the task calls out.
    // The consent-or-pay entry's priority must win the tie.
    const document = domWithBody('<div id="iubenda-cs-banner"></div><button id="iub_cmp_subscribe_custom_btn"></button>');

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp, 'expected a CMP to be detected');
    assert.equal(cmp.id, 'repubblica_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
  });

  test('a plain Iubenda banner (no subscribe-wall marker) is detected as generic Iubenda, refusable', () => {
    const document = domWithBody('<div id="iubenda-cs-banner"></div>');

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'iubenda');
    assert.equal(cmp.kind, undefined);
  });

  test('corriere.it (privacy-cp-wall) is detected as its own consent-or-pay entry', () => {
    const document = domWithBody('<div class="privacy-cp-wall"><button id="privacy-cp-wall-reject-and-subscribe"></button></div>');

    const cmp = detectCMP(resolved, document);
    assert.ok(cmp);
    assert.equal(cmp.id, 'corriere_consent_or_pay');
    assert.equal(cmp.kind, 'consentOrPay');
  });

  test('every consentOrPay entry ships an empty flow: there is nothing for it to ever click', () => {
    const consentOrPayEntries = resolved.cmps.filter((cmp) => cmp.kind === 'consentOrPay');
    assert.ok(consentOrPayEntries.length >= 2, 'expected at least the corriere and repubblica entries');
    for (const cmp of consentOrPayEntries) {
      assert.deepEqual(cmp.flow, [], `${cmp.id} must not carry a flow - it is recognition-only`);
    }
  });
});

describe('Iubenda: the close-button fallback only ever fires on the exempted wording', () => {
  const resolved = resolveTextMatchRefs(ruleset, labels);
  const iubenda = resolved.cmps.find((cmp) => cmp.id === 'iubenda');

  test('the shipped Iubenda flow exists and its fallback step targets the close button via necessaryOnly wording', () => {
    assert.ok(iubenda, 'expected an "iubenda" entry in rules.json');
    const closeStep = iubenda.flow.find((step) => step.selector && step.selector.css === '.iubenda-cs-close-btn');
    assert.ok(closeStep, 'expected a step targeting .iubenda-cs-close-btn');
    assert.ok(Array.isArray(closeStep.selector.textMatch) && closeStep.selector.textMatch.length > 0);
  });

  test('alfemminile.com variant: no direct reject button, close button carries "Continua senza accettare" - it IS clicked', async () => {
    const document = domWithBody(`
      <div id="iubenda-cs-banner">
        <button class="iubenda-cs-close-btn">Continua senza accettare</button>
      </div>
    `);

    let clicked = false;
    document.querySelector('.iubenda-cs-close-btn').addEventListener('click', () => { clicked = true; });

    await runFlow(iubenda.flow, document);
    assert.equal(clicked, true, 'the close button must be clicked when it carries the necessaryOnly wording');
  });

  test('a bare dismiss "X" without the necessaryOnly wording is never clicked, even though it matches the selector', async () => {
    const document = domWithBody(`
      <div id="iubenda-cs-banner">
        <button class="iubenda-cs-close-btn" aria-label="Close">&times;</button>
      </div>
    `);

    let clicked = false;
    document.querySelector('.iubenda-cs-close-btn').addEventListener('click', () => { clicked = true; });

    await runFlow(iubenda.flow, document);
    assert.equal(clicked, false, 'a close button without the exempted wording must never be clicked - it would silently dismiss without refusing');
  });

  test('ilpost.it / giallozafferano.it variant: direct reject button present - it is clicked, and the close-button fallback is not needed', async () => {
    const document = domWithBody(`
      <div id="iubenda-cs-banner">
        <button class="iubenda-cs-reject-btn">Continua senza accettare</button>
      </div>
    `);

    let rejectClicked = false;
    document.querySelector('.iubenda-cs-reject-btn').addEventListener('click', () => { rejectClicked = true; });

    const results = await runFlow(iubenda.flow, document);
    assert.equal(rejectClicked, true);
    assert.equal(results[0].ok, true);
  });

  function domWithBody(html) {
    return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: undefined }).window.document;
  }
});
