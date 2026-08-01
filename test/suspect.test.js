/**
 * The shared "suspected banner" heuristic (src/engine/suspect.js), used
 * identically by the content script and tools/probe-entry.js - see that
 * module's doc comment for the full rationale (shadow DOM traversal,
 * bounded depth/nodes, scored rather than all-mandatory signals).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  findSuspiciousBanners,
  isSuspiciousBanner,
  collectShadowAwareElements,
} from '../src/engine/suspect.js';

function makeDom(html = '<!doctype html><html><body></body></html>') {
  return new JSDOM(html, { runScripts: undefined });
}

/** Stubs getBoundingClientRect - jsdom never computes real layout. */
function stubRect(el, { width = 0, height = 0, top = 0, left = 0 } = {}) {
  el.getBoundingClientRect = () => ({
    width, height, top, left,
    right: left + width,
    bottom: top + height,
  });
}

/** Builds a plausible, strongly-worded consent banner with two action buttons. */
function makeBannerElement(document, overrides = {}) {
  const banner = document.createElement('div');
  banner.style.position = overrides.position ?? 'fixed';
  if (overrides.zIndex !== undefined) banner.style.zIndex = overrides.zIndex;
  else banner.style.zIndex = '999999';

  banner.append(document.createTextNode('We use cookies to improve your experience and ask for your consent. '));
  const accept = document.createElement('button');
  accept.textContent = 'Accept all';
  const reject = document.createElement('button');
  reject.textContent = 'Reject all';
  banner.append(accept, reject);

  stubRect(banner, {
    width: overrides.width ?? 1024,
    height: overrides.height ?? 200,
    top: overrides.top ?? 568,
    left: overrides.left ?? 0,
  });

  return banner;
}

describe('suspect.js - direct child of body', () => {
  test('flags a fixed, high z-index consent banner appended directly to body', () => {
    const { document } = makeDom().window;
    const banner = makeBannerElement(document);
    document.body.appendChild(banner);

    const found = findSuspiciousBanners(document.body);
    assert.equal(found.length, 1);
    assert.equal(found[0], banner);
    assert.equal(isSuspiciousBanner(banner), true);
  });
});

describe('suspect.js - nested deep in the DOM', () => {
  test('flags a banner nested several wrapper divs deep (not just a direct body child)', () => {
    const { document } = makeDom().window;

    let wrapper = document.body;
    for (let i = 0; i < 6; i += 1) {
      const layer = document.createElement('div');
      layer.className = `app-layer-${i}`;
      wrapper.appendChild(layer);
      wrapper = layer;
    }

    const banner = makeBannerElement(document);
    wrapper.appendChild(banner);

    const found = findSuspiciousBanners(document.body);
    assert.equal(found.length, 1);
    assert.equal(found[0], banner);
  });
});

describe('suspect.js - shadow DOM', () => {
  test('flags a banner rendered inside an open shadow root', () => {
    const { document } = makeDom().window;

    const host = document.createElement('div');
    host.id = 'cmp-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const banner = makeBannerElement(document);
    shadow.appendChild(banner);

    const found = findSuspiciousBanners(document.body);
    assert.equal(found.length, 1);
    assert.equal(found[0], banner);
  });

  test('does not throw and finds nothing when the shadow root is closed (inaccessible by design)', () => {
    const { document } = makeDom().window;

    const host = document.createElement('div');
    document.body.appendChild(host);
    // A closed shadow root deliberately does not expose `host.shadowRoot`.
    host.attachShadow({ mode: 'closed' });

    assert.doesNotThrow(() => findSuspiciousBanners(document.body));
    assert.deepEqual(findSuspiciousBanners(document.body), []);
  });

  test('collectShadowAwareElements recurses into open shadow roots, not just light DOM children', () => {
    const { document } = makeDom().window;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    shadow.appendChild(inner);

    const all = collectShadowAwareElements(document.body);
    assert.ok(all.includes(host));
    assert.ok(all.includes(inner));
  });
});

describe('suspect.js - relaxed positioning/z-index thresholds', () => {
  test('flags an absolute-positioned banner with z-index: auto (previously rejected outright)', () => {
    const { document } = makeDom().window;

    const banner = makeBannerElement(document, {
      position: 'absolute',
      zIndex: 'auto',
      width: 700,
      height: 300,
      top: 200,
      left: 100,
    });
    document.body.appendChild(banner);

    assert.equal(isSuspiciousBanner(banner), true);
    const found = findSuspiciousBanners(document.body);
    assert.equal(found.length, 1);
  });
});

describe('suspect.js - negative cases (must NOT be flagged)', () => {
  test('an ordinary sticky site header with no consent wording is not flagged', () => {
    const { document } = makeDom().window;

    const header = document.createElement('div');
    header.style.position = 'sticky';
    header.style.zIndex = '10'; // positive, but well below the "high" threshold
    header.append(document.createTextNode('Home About Contact '));
    const login = document.createElement('button');
    login.textContent = 'Login';
    const search = document.createElement('button');
    search.textContent = 'Search';
    header.append(login, search);
    stubRect(header, { width: 1024, height: 64, top: 0, left: 0 });
    document.body.appendChild(header);

    assert.equal(isSuspiciousBanner(header), false);
    assert.deepEqual(findSuspiciousBanners(document.body), []);
  });

  test('a cookie banner that is already closed/hidden (display: none) is not flagged', () => {
    const { document } = makeDom().window;

    const banner = makeBannerElement(document);
    banner.style.display = 'none';
    document.body.appendChild(banner);

    assert.equal(isSuspiciousBanner(banner), false);
    assert.deepEqual(findSuspiciousBanners(document.body), []);
  });

  test('a long article that mentions cookies but has no actual banner is not flagged', () => {
    const { document } = makeDom().window;

    const article = document.createElement('div');
    const paragraph = 'This article discusses how cookies are used across the web and what consent means for privacy. ';
    article.append(document.createTextNode(paragraph.repeat(60))); // well over 4000 chars
    const share1 = document.createElement('a');
    share1.href = '#';
    share1.textContent = 'Share';
    const share2 = document.createElement('a');
    share2.href = '#';
    share2.textContent = 'Tweet';
    article.append(share1, share2);
    // No position set at all (static) - just a very tall content block.
    stubRect(article, { width: 1024, height: 5000, top: 0, left: 0 });
    document.body.appendChild(article);

    assert.equal(isSuspiciousBanner(article), false);
    assert.deepEqual(findSuspiciousBanners(document.body), []);
  });
});
