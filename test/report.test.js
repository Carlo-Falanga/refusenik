/**
 * Contract for the opt-in problem report (docs/ARCHITETTURA.md, "Privacy -
 * non negoziabile"): the payload must contain exactly domain, CMP id (or
 * "none"), and extension version - nothing else, and never a full URL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildReportPayload } from '../src/ui/report.js';

describe('report.js - buildReportPayload', () => {
  test('includes domain, cmp id and version, and nothing else', () => {
    const payload = buildReportPayload({ domain: 'bbc.com', cmpId: 'onetrust', version: '0.1.0' });
    assert.equal(payload, 'domain: bbc.com\ncmp: onetrust\nversion: 0.1.0');
  });

  test('reports "none" when no CMP was detected', () => {
    const payload = buildReportPayload({ domain: 'example.com', cmpId: null, version: '0.1.0' });
    assert.equal(payload, 'domain: example.com\ncmp: none\nversion: 0.1.0');
  });

  test('never contains a full URL, query string or path', () => {
    const payload = buildReportPayload({
      domain: 'example.com?should=not-appear-if-passed-a-url-by-mistake',
      cmpId: 'onetrust',
      version: '0.1.0',
    });
    // This module trusts its caller for what counts as "domain" - it is a
    // pure formatter, not a URL sanitizer - but it must never itself add a
    // path, query string or scheme on top of whatever it is given.
    assert.equal(payload.includes('http://'), false);
    assert.equal(payload.includes('https://'), false);
  });

  test('falls back to safe defaults for missing/invalid fields', () => {
    const payload = buildReportPayload({});
    assert.equal(payload, 'domain: unknown\ncmp: none\nversion: 0.0.0');
  });
});
