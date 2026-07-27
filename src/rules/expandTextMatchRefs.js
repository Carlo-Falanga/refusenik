/**
 * Build-time expansion of `textMatchRef` into a literal `textMatch` array.
 *
 * This module is deliberately kept out of src/engine/: the engine must only
 * ever see a resolved, literal `textMatch` (a string or an array of
 * strings), never a reference it would have to look up itself. Only the
 * packaging step (build.mjs) - and this module's own tests - read
 * labels.json and perform the substitution.
 *
 * A Selector authored in src/rules/rules.json may carry a `textMatchRef`
 * naming a key of labels.json's `concepts` map instead of (never together
 * with) a literal `textMatch`. Resolving it flattens every language variant
 * listed for that concept into a single array: the resulting `textMatch`
 * matches if ANY of those variants matches. That is how one authored Step
 * covers every language labels.json knows about for that concept, instead
 * of being duplicated once per language.
 *
 * Resolution never guesses: an unknown concept key, or a selector carrying
 * both `textMatch` and `textMatchRef`, is a build-breaking error, not a
 * silently-ignored one.
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Flattens every language's variant list of a labels.json concept into one array. */
function flattenConcept(concept) {
  return Object.values(concept).flat();
}

/** Resolves `textMatchRef` on a single Selector-shaped object. Returns a new object. */
function resolveSelectorRefs(selector, labels, where) {
  if (!isPlainObject(selector)) return selector;
  if (!('textMatchRef' in selector)) return selector;

  if ('textMatch' in selector) {
    throw new Error(`${where}: selector carries both textMatch and textMatchRef - ambiguous, remove one`);
  }

  const refKey = selector.textMatchRef;
  const concept = labels && labels.concepts && labels.concepts[refKey];
  if (!concept) {
    throw new Error(`${where}: textMatchRef "${refKey}" has no matching concept in labels.json`);
  }

  const { textMatchRef, ...rest } = selector;
  return { ...rest, textMatch: flattenConcept(concept) };
}

/**
 * Returns a deep-cloned ruleset with every Selector's `textMatchRef`
 * resolved into a literal `textMatch` array. Throws on any unresolvable
 * reference or ambiguous authoring - it never resolves partially and never
 * guesses at intent.
 */
export function resolveTextMatchRefs(ruleset, labels) {
  const cloned = JSON.parse(JSON.stringify(ruleset));

  for (const cmp of cloned.cmps || []) {
    cmp.detect = (cmp.detect || []).map(
      (selector, i) => resolveSelectorRefs(selector, labels, `${cmp.id}.detect[${i}]`),
    );
    cmp.flow = (cmp.flow || []).map((step, i) => {
      if (step && step.selector) {
        step.selector = resolveSelectorRefs(step.selector, labels, `${cmp.id}.flow[${i}].selector`);
      }
      if (step && step.ifExists) {
        step.ifExists = resolveSelectorRefs(step.ifExists, labels, `${cmp.id}.flow[${i}].ifExists`);
      }
      return step;
    });
  }

  return cloned;
}

/**
 * Recursively asserts that no `textMatchRef` survived resolution. Meant as a
 * defense-in-depth gate right before a resolved ruleset is packaged: if this
 * ever throws, resolution above has a gap and the build must fail loudly
 * rather than ship something the engine cannot interpret.
 */
export function assertNoUnresolvedRefs(ruleset) {
  for (const cmp of ruleset.cmps || []) {
    (cmp.detect || []).forEach((selector, i) => {
      if (selector && 'textMatchRef' in selector) {
        throw new Error(`${cmp.id}.detect[${i}]: unresolved textMatchRef`);
      }
    });
    (cmp.flow || []).forEach((step, i) => {
      if (step && step.selector && 'textMatchRef' in step.selector) {
        throw new Error(`${cmp.id}.flow[${i}].selector: unresolved textMatchRef`);
      }
      if (step && step.ifExists && 'textMatchRef' in step.ifExists) {
        throw new Error(`${cmp.id}.flow[${i}].ifExists: unresolved textMatchRef`);
      }
    });
  }
}
