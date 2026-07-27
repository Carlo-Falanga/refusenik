/**
 * Guard for a defect that is invisible in code review and silent at runtime.
 *
 * The popup shows and hides every optional section through the [hidden]
 * attribute, which relies on the browser's default stylesheet. Any author rule
 * that sets `display` on the same element defeats it - author styles win over
 * user-agent styles regardless of specificity. popup.css sets `display: flex`
 * on both .popup__meta and .popup__report-panel, so without an explicit
 * [hidden] rule the report panel (payload preview plus Cancel) stayed on
 * screen permanently and Cancel did nothing.
 *
 * Nothing throws, no test fails, and the markup still says `hidden`: the only
 * way to notice is to look at a rendered popup. Hence this guard.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'ui', 'popup.css'), 'utf8');
const html = readFileSync(join(here, '..', 'src', 'ui', 'popup.html'), 'utf8');

describe('popup.css / [hidden] contract', () => {
  test('an explicit [hidden] rule neutralises author display rules', () => {
    const rule = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i;
    assert.match(
      css.replace(/\/\*[\s\S]*?\*\//g, ''),
      rule,
      'popup.css must declare [hidden] { display: none !important } or every section toggled with the hidden attribute stays visible',
    );
  });

  test('the report panel starts hidden in the markup', () => {
    // The payload preview must be revealed on demand, never on open.
    const panel = html.match(/<div[^>]*data-field="reportPanel"[^>]*>/);
    assert.ok(panel, 'reportPanel element not found');
    assert.match(panel[0], /\shidden\b/, 'reportPanel must carry the hidden attribute');
  });
});
