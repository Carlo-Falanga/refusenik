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

import { validateRuleset } from '../src/engine/ruleset.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(here, '..', 'src', 'rules', 'rules.json');
const ruleset = JSON.parse(readFileSync(rulesPath, 'utf8'));

/** Must stay in sync with the switch in src/engine/steps.js. */
const KNOWN_ACTIONS = new Set(['waitFor', 'click', 'setCheckbox', 'hide']);

describe('rules.json <-> engine contract', () => {
  test('the shipped ruleset passes the engine validator', () => {
    assert.equal(validateRuleset(ruleset), true);
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
