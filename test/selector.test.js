import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resolveSelector, resolveAllSelector, selectorExists } from '../src/engine/selector.js';

function makeDom(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { runScripts: undefined });
  return dom;
}

describe('selector.js - shadow DOM', () => {
  test('resolves an element nested two levels deep across shadow roots', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const host1 = document.createElement('div');
    host1.id = 'host1';
    document.body.appendChild(host1);
    const shadow1 = host1.attachShadow({ mode: 'open' });

    const host2 = document.createElement('div');
    host2.id = 'host2';
    shadow1.appendChild(host2);
    const shadow2 = host2.attachShadow({ mode: 'open' });

    const target = document.createElement('button');
    target.id = 'target';
    target.textContent = 'Reject all';
    shadow2.appendChild(target);

    const selector = { css: '#target', shadowPath: ['#host1', '#host2'] };
    const found = resolveSelector(selector, document);

    assert.equal(found, target);
  });

  test('returns null cleanly when a shadow host in the path is missing', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const host1 = document.createElement('div');
    host1.id = 'host1';
    document.body.appendChild(host1);
    host1.attachShadow({ mode: 'open' });

    const selector = { css: '#target', shadowPath: ['#host1', '#does-not-exist'] };
    assert.equal(resolveSelector(selector, document), null);
  });

  test('returns null cleanly when the host has no attached shadow root', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const host1 = document.createElement('div');
    host1.id = 'host1'; // no attachShadow() called
    document.body.appendChild(host1);

    const selector = { css: '#target', shadowPath: ['#host1'] };
    assert.equal(resolveSelector(selector, document), null);
  });
});

describe('selector.js - textMatch', () => {
  test('contains mode matches case-insensitively with whitespace normalization', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const decoy = document.createElement('button');
    decoy.textContent = 'Accept all';
    document.body.appendChild(decoy);

    const target = document.createElement('button');
    target.textContent = '  Reject   ALL\n cookies ';
    document.body.appendChild(target);

    const selector = { css: 'button', textMatch: 'reject all cookies', textMatchMode: 'contains' };
    assert.equal(resolveSelector(selector, document), target);
  });

  test('exact mode requires the full normalized text to match', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const partial = document.createElement('button');
    partial.textContent = 'Reject all cookies now';
    document.body.appendChild(partial);

    const exact = document.createElement('button');
    exact.textContent = '  Reject   all  ';
    document.body.appendChild(exact);

    const selector = { css: 'button', textMatch: 'reject all', textMatchMode: 'exact' };
    assert.equal(resolveSelector(selector, document), exact);
  });

  test('returns all matches via resolveAllSelector when multiple elements satisfy textMatch', () => {
    const dom = makeDom();
    const { document } = dom.window;

    for (let i = 0; i < 3; i += 1) {
      const btn = document.createElement('button');
      btn.className = 'reject';
      btn.textContent = 'Reject all';
      document.body.appendChild(btn);
    }

    const selector = { css: 'button.reject', textMatch: 'reject all' };
    const matches = resolveAllSelector(selector, document);
    assert.equal(matches.length, 3);
  });

  test('unknown textMatchMode fails closed (no match) instead of guessing semantics', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const target = document.createElement('button');
    target.textContent = 'Reject all';
    document.body.appendChild(target);

    const selector = { css: 'button', textMatch: 'reject all', textMatchMode: 'regex-safe' };
    assert.equal(resolveSelector(selector, document), null);
  });

  test('textMatch as an array matches if ANY variant matches (multi-language labels)', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const decoy = document.createElement('button');
    decoy.textContent = 'Accept all';
    document.body.appendChild(decoy);

    const target = document.createElement('button');
    target.textContent = 'Rifiuta tutto';
    document.body.appendChild(target);

    const selector = {
      css: 'button',
      textMatch: ['Reject all', 'Rifiuta tutto', 'Alle ablehnen', 'Tout refuser', 'Rechazar todo'],
      textMatchMode: 'contains',
    };
    assert.equal(resolveSelector(selector, document), target);
  });

  test('textMatch as an array matching none of the variants yields no match', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const target = document.createElement('button');
    target.textContent = 'Rifiuta tutto';
    document.body.appendChild(target);

    const selector = { css: 'button', textMatch: ['Reject all', 'Tout refuser'], textMatchMode: 'exact' };
    assert.equal(resolveSelector(selector, document), null);
  });

  test('an unresolved textMatchRef fails closed, never falling back to "match everything"', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const target = document.createElement('button');
    target.textContent = 'Reject all';
    document.body.appendChild(target);

    // No literal `textMatch` at all - if textMatchRef were ignored instead
    // of failing closed, this would match every <button> on the page.
    const selector = { css: 'button', textMatchRef: 'rejectAll' };
    assert.equal(resolveSelector(selector, document), null);
    assert.deepEqual(resolveAllSelector(selector, document), []);
  });

  test('a textMatchRef alongside a literal textMatch still fails closed', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const target = document.createElement('button');
    target.textContent = 'Reject all';
    document.body.appendChild(target);

    const selector = { css: 'button', textMatch: 'reject all', textMatchRef: 'rejectAll' };
    assert.equal(resolveSelector(selector, document), null);
  });
});

describe('selector.js - iframe', () => {
  test('resolves an element inside an accessible same-document iframe', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const iframe = document.createElement('iframe');
    iframe.id = 'cmp';
    document.body.appendChild(iframe);

    const target = iframe.contentDocument.createElement('button');
    target.id = 'reject';
    target.textContent = 'Reject';
    iframe.contentDocument.body.appendChild(target);

    const selector = { css: '#reject', frame: 'iframe#cmp' };
    assert.equal(resolveSelector(selector, document), target);
  });

  test('fails cleanly (returns null, never throws) for an inaccessible cross-origin iframe', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const iframe = document.createElement('iframe');
    iframe.id = 'cmp';
    document.body.appendChild(iframe);

    // Simulate a cross-origin iframe: accessing contentDocument throws a
    // SecurityError, as real browsers do.
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new dom.window.DOMException('Blocked a frame with origin', 'SecurityError');
      },
    });

    const selector = { css: '#reject', frame: 'iframe#cmp' };
    assert.doesNotThrow(() => resolveSelector(selector, document));
    assert.equal(resolveSelector(selector, document), null);
  });

  test('fails cleanly when the referenced iframe does not exist', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const selector = { css: '#reject', frame: 'iframe#does-not-exist' };
    assert.equal(resolveSelector(selector, document), null);
  });
});

describe('selector.js - defensive behaviour', () => {
  test('never throws on a malformed selector', () => {
    const dom = makeDom();
    const { document } = dom.window;

    assert.doesNotThrow(() => resolveSelector(null, document));
    assert.doesNotThrow(() => resolveSelector({}, document));
    assert.doesNotThrow(() => resolveSelector({ css: '[invalid' }, document));
    assert.equal(resolveSelector(null, document), null);
    assert.equal(resolveSelector({}, document), null);
    assert.equal(resolveSelector({ css: '[invalid' }, document), null);
  });

  test('selectorExists reflects presence/absence without throwing', () => {
    const dom = makeDom();
    const { document } = dom.window;

    const el = document.createElement('div');
    el.id = 'present';
    document.body.appendChild(el);

    assert.equal(selectorExists({ css: '#present' }, document), true);
    assert.equal(selectorExists({ css: '#missing' }, document), false);
  });
});
