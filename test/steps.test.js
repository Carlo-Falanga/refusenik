import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { runFlow, runStep } from '../src/engine/steps.js';

function makeDom(html = '<!doctype html><html><body></body></html>') {
  return new JSDOM(html, { runScripts: undefined });
}

describe('steps.js - optional / failure handling', () => {
  test('an optional step that fails does not stop the flow', async () => {
    const { document } = makeDom().window;

    const target = document.createElement('button');
    target.id = 'reject';
    document.body.appendChild(target);

    const flow = [
      { action: 'click', selector: { css: '#does-not-exist' }, optional: true },
      { action: 'click', selector: { css: '#reject' } },
    ];

    const results = await runFlow(flow, document);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
  });

  test('a non-optional step that fails stops the flow', async () => {
    const { document } = makeDom().window;

    const target = document.createElement('button');
    target.id = 'reject';
    document.body.appendChild(target);

    const flow = [
      { action: 'click', selector: { css: '#does-not-exist' } }, // not optional
      { action: 'click', selector: { css: '#reject' } },
    ];

    const results = await runFlow(flow, document);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
  });
});

describe('steps.js - closed action set', () => {
  test('an unknown action is ignored, not executed, and the flow continues', async () => {
    const { document } = makeDom().window;

    const target = document.createElement('button');
    target.id = 'reject';
    let clicked = false;
    target.addEventListener('click', () => { clicked = true; });
    document.body.appendChild(target);

    const flow = [
      { action: 'evalScript', code: 'document.querySelector("#reject").click()' },
      { action: 'click', selector: { css: '#reject' } },
    ];

    const results = await runFlow(flow, document);

    assert.equal(results.length, 2);
    assert.equal(results[0].ignored, true);
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
    assert.equal(clicked, true, 'the legitimate click step should still run');
  });

  test('an unknown action inside a non-optional step still does not abort the flow', async () => {
    const { document } = makeDom().window;
    const target = document.createElement('button');
    target.id = 'reject';
    document.body.appendChild(target);

    const flow = [
      { action: 'runArbitraryCode' }, // no optional flag at all
      { action: 'click', selector: { css: '#reject' } },
    ];

    const results = await runFlow(flow, document);
    assert.equal(results.length, 2);
    assert.equal(results[1].ok, true);
  });
});

describe('steps.js - ifExists guard', () => {
  test('skips the step when the guard selector is absent, without failing the flow', async () => {
    const { document } = makeDom().window;

    const target = document.createElement('button');
    target.id = 'reject';
    document.body.appendChild(target);

    const flow = [
      { action: 'click', selector: { css: '#reject' }, ifExists: { css: '#marker-not-present' } },
    ];

    const results = await runFlow(flow, document);
    assert.equal(results[0].skipped, true);
    assert.equal(results[0].ok, true);
  });

  test('runs the step when the guard selector is present', async () => {
    const { document } = makeDom().window;

    const marker = document.createElement('div');
    marker.id = 'marker';
    document.body.appendChild(marker);

    const target = document.createElement('button');
    target.id = 'reject';
    document.body.appendChild(target);

    const step = { action: 'click', selector: { css: '#reject' }, ifExists: { css: '#marker' } };
    const result = await runStep(step, document);
    assert.equal(result.skipped, false);
    assert.equal(result.ok, true);
  });
});

describe('steps.js - setCheckbox', () => {
  test('all: true toggles every matching checkbox, not just the first', async () => {
    const { document } = makeDom().window;

    for (let i = 0; i < 3; i += 1) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'consent-toggle';
      cb.checked = true;
      document.body.appendChild(cb);
    }

    const step = { action: 'setCheckbox', selector: { css: '.consent-toggle' }, checked: false, all: true };
    const result = await runStep(step, document);

    assert.equal(result.ok, true);
    const boxes = Array.from(document.querySelectorAll('.consent-toggle'));
    assert.equal(boxes.every((cb) => cb.checked === false), true);
  });

  test('without all: true only the first match is toggled', async () => {
    const { document } = makeDom().window;

    for (let i = 0; i < 2; i += 1) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'consent-toggle';
      cb.checked = true;
      document.body.appendChild(cb);
    }

    const step = { action: 'setCheckbox', selector: { css: '.consent-toggle' }, checked: false };
    await runStep(step, document);

    const boxes = Array.from(document.querySelectorAll('.consent-toggle'));
    assert.equal(boxes[0].checked, false);
    assert.equal(boxes[1].checked, true);
  });
});

describe('steps.js - click simulation', () => {
  test('dispatches a realistic pointer/mouse sequence, not just a bare click', async () => {
    const { document } = makeDom().window;

    const target = document.createElement('button');
    target.id = 'reject';
    document.body.appendChild(target);

    const seen = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.addEventListener(type, () => seen.push(type));
    }

    const result = await runStep({ action: 'click', selector: { css: '#reject' } }, document);

    assert.equal(result.ok, true);
    assert.ok(seen.includes('mousedown'));
    assert.ok(seen.includes('mouseup'));
    assert.ok(seen.includes('click'));
  });
});

describe('steps.js - hide', () => {
  test('hides the first matching element via CSS', async () => {
    const { document } = makeDom().window;

    const banner = document.createElement('div');
    banner.id = 'banner';
    document.body.appendChild(banner);

    const result = await runStep({ action: 'hide', selector: { css: '#banner' } }, document);
    assert.equal(result.ok, true);
    assert.equal(banner.style.display, 'none');
  });
});

describe('steps.js - waitFor', () => {
  test('resolves once the element is inserted asynchronously, without polling', async () => {
    const { document } = makeDom().window;

    setTimeout(() => {
      const el = document.createElement('div');
      el.id = 'late';
      document.body.appendChild(el);
    }, 50);

    const result = await runStep(
      { action: 'waitFor', selector: { css: '#late' }, timeoutMs: 2000 },
      document,
    );
    assert.equal(result.ok, true);
  });

  test('resolves once a shadow host (with its shadow content already attached) is inserted late', async () => {
    // Mirrors how real CMP custom elements behave: the host is inserted
    // into the light DOM late, and its shadow root is attached/populated
    // synchronously within that same insertion (e.g. connectedCallback).
    // The host's insertion is itself the observable light-DOM mutation.
    const { document } = makeDom().window;

    setTimeout(() => {
      const host = document.createElement('div');
      host.id = 'host';
      const shadow = host.attachShadow({ mode: 'open' });
      const el = document.createElement('button');
      el.id = 'late-in-shadow';
      shadow.appendChild(el);
      document.body.appendChild(host);
    }, 50);

    const result = await runStep(
      { action: 'waitFor', selector: { css: '#late-in-shadow', shadowPath: ['#host'] }, timeoutMs: 2000 },
      document,
    );
    assert.equal(result.ok, true);
  });

  test('fails with a timeout reason when the element never appears', async () => {
    const result = await runStep(
      { action: 'waitFor', selector: { css: '#never' }, timeoutMs: 100 },
      makeDom().window.document,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
  });
});

describe('steps.js - invalid step data', () => {
  test('a malformed step object is ignored rather than throwing', async () => {
    const results = await runFlow([null, { notAnAction: true }, 42], makeDom().window.document);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ignored === true));
  });
});
