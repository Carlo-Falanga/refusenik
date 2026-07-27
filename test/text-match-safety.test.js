/**
 * Permanent safety net for textual matching.
 *
 * Widening a click target's matching from a single fixed string to a set of
 * language variants raises one specific risk: a variant meant to identify a
 * REFUSAL button could, by mistake, also match an ACCEPTANCE button (see
 * docs/ARCHITETTURA.md - clicking "Accept" while believing it clicked
 * "Reject" is the worst failure mode this extension can have).
 *
 * This suite scans every variant labels.json can ever contribute to a
 * `textMatch`, plus the resolved ruleset's actual `textMatch` values, for
 * acceptance/consent-granting wording. It must keep passing as labels.json
 * and rules.json evolve - it is not a one-time check.
 *
 * `necessaryOnly` is the one concept exempted from the blanket scan: real
 * CMPs phrase "reject everything but strictly necessary cookies" using
 * accept-flavoured or negated-consent wording in several languages (e.g.
 * "Accept Essentials Only", "Ohne Zustimmung fortfahren", "Continuer sans
 * accepter", "Continuar sin aceptar", "Continua senza accettare"). Those are
 * legitimate, and for the DataGrail case "Accept Essentials Only" is a
 * label directly confirmed by live inspection (see src/rules/NOTE.md).
 * Every OTHER concept must stay completely free of these stems.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveTextMatchRefs } from '../src/rules/expandTextMatchRefs.js';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'rules', 'rules.json'), 'utf8'));
const labels = JSON.parse(readFileSync(join(here, '..', 'src', 'rules', 'labels.json'), 'utf8'));

/**
 * Stems of acceptance/consent-granting terms across the languages
 * labels.json covers (EN/IT/DE/FR/ES). A textMatch string identifying a
 * refusal action must never contain one of these.
 */
const FORBIDDEN_STEMS = [
  'accept', 'accetta', 'akzeptier', 'acepta', // accept / accetta / akzeptieren / aceptar
  'allow', 'consenti', 'erlaub', 'autoris', 'permit', // allow / consenti / erlauben / autoriser / permitir
  'agree', 'acconsent', 'zustimm', // agree / acconsento / zustimmen
];

const EXEMPT_CONCEPTS = new Set(['necessaryOnly']);

function containsForbiddenStem(text) {
  const normalized = String(text).toLowerCase();
  return FORBIDDEN_STEMS.some((stem) => normalized.includes(stem));
}

function allVariantsOf(concept) {
  return Object.values(concept).flat();
}

describe('text-match safety net - refusal wording never overlaps acceptance wording', () => {
  test('every non-exempt labels.json concept is free of acceptance-term stems, in every language', () => {
    const offenders = [];
    for (const [conceptName, concept] of Object.entries(labels.concepts)) {
      if (EXEMPT_CONCEPTS.has(conceptName)) continue;
      for (const [lang, variants] of Object.entries(concept)) {
        for (const variant of variants) {
          if (containsForbiddenStem(variant)) offenders.push(`${conceptName}.${lang}: "${variant}"`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `acceptance-flavoured wording leaked into a refusal-type concept:\n${offenders.join('\n')}`,
    );
  });

  test('the German "ablehnen" vs "akzeptieren" trap: rejectAll never contains the acceptance stem', () => {
    // The exact trap called out in the task: a loose `contains` on "Alle"
    // would match both "Alle ablehnen" (reject) and "Alle akzeptieren"
    // (accept). Guard the actual data, not just the matching mode.
    const rejectDe = labels.concepts.rejectAll.de.map((s) => s.toLowerCase());
    assert.ok(rejectDe.every((s) => !s.includes('akzeptier')));
  });

  test('resolved ruleset: no textMatch value contains acceptance wording, unless it is a known necessaryOnly variant', () => {
    const resolved = resolveTextMatchRefs(rules, labels);
    const exemptStrings = new Set(
      allVariantsOf(labels.concepts.necessaryOnly).map((s) => String(s).toLowerCase().trim()),
    );

    const offenders = [];
    const checkSelector = (selector, where) => {
      if (!selector || !selector.textMatch) return;
      const values = Array.isArray(selector.textMatch) ? selector.textMatch : [selector.textMatch];
      for (const value of values) {
        const normalized = String(value).toLowerCase().trim();
        if (containsForbiddenStem(value) && !exemptStrings.has(normalized)) {
          offenders.push(`${where}: "${value}"`);
        }
      }
    };

    for (const cmp of resolved.cmps) {
      cmp.detect.forEach((s, i) => checkSelector(s, `${cmp.id}.detect[${i}]`));
      cmp.flow.forEach((step, i) => {
        checkSelector(step.selector, `${cmp.id}.flow[${i}].selector`);
        checkSelector(step.ifExists, `${cmp.id}.flow[${i}].ifExists`);
      });
    }

    assert.deepEqual(offenders, [], `unexpected acceptance wording in the shipped ruleset:\n${offenders.join('\n')}`);
  });
});
