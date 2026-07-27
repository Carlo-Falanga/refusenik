#!/usr/bin/env node
/**
 * Assembles the loadable extension package in dist/.
 *
 * The engine (src/engine/) is written as ES modules, which Firefox content
 * scripts cannot load directly. This bundles the content script and the
 * background script each into a single self-contained IIFE with esbuild
 * (a devDependency only - the package has no runtime dependencies, and
 * bundling introduces none), then copies the static files a browser needs
 * alongside them: manifest.json and the bundled ruleset.
 *
 * Naming note: the ruleset authored at src/rules/rules.json is packaged as
 * dist/rules/ruleset.json, because src/engine/ruleset.js's bundled-fallback
 * loader (BUNDLED_RULESET_PATH) expects that exact path. Renaming happens
 * only here, at the packaging boundary - neither file is renamed at the
 * source.
 *
 * Packaging the ruleset is not a plain copy: src/rules/rules.json may
 * contain `textMatchRef` entries pointing at src/rules/labels.json, and this
 * is the one place they get resolved into literal `textMatch` arrays (see
 * src/rules/expandTextMatchRefs.js). The engine never resolves references
 * itself, so what gets written to dist/rules/ruleset.json must already be
 * fully literal - checked explicitly before it is written.
 *
 * The popup (src/ui/) is bundled the same way as content/background: its
 * script is an ES module at the source, esbuild flattens it into a
 * self-contained IIFE so popup.html can load it with a plain <script> tag.
 * popup.html/popup.css are static and are only copied across.
 */

import { build } from 'esbuild';
import { rmSync, mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTextMatchRefs, assertNoUnresolvedRefs } from './src/rules/expandTextMatchRefs.js';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const sharedOptions = {
  bundle: true,
  format: 'iife',
  target: 'firefox115',
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...sharedOptions,
  entryPoints: [join(here, 'src', 'engine', 'content.js')],
  outfile: join(distDir, 'content.js'),
});

await build({
  ...sharedOptions,
  entryPoints: [join(here, 'src', 'engine', 'background.js')],
  outfile: join(distDir, 'background.js'),
});

await build({
  ...sharedOptions,
  entryPoints: [join(here, 'src', 'ui', 'popup.js')],
  outfile: join(distDir, 'ui', 'popup.js'),
});

copyFileSync(join(here, 'manifest.json'), join(distDir, 'manifest.json'));

mkdirSync(join(distDir, 'rules'), { recursive: true });

const authoredRules = JSON.parse(readFileSync(join(here, 'src', 'rules', 'rules.json'), 'utf8'));
const labels = JSON.parse(readFileSync(join(here, 'src', 'rules', 'labels.json'), 'utf8'));
const resolvedRules = resolveTextMatchRefs(authoredRules, labels);
assertNoUnresolvedRefs(resolvedRules);
writeFileSync(join(distDir, 'rules', 'ruleset.json'), JSON.stringify(resolvedRules, null, 2));

mkdirSync(join(distDir, 'ui'), { recursive: true });
copyFileSync(join(here, 'src', 'ui', 'popup.html'), join(distDir, 'ui', 'popup.html'));
copyFileSync(join(here, 'src', 'ui', 'popup.css'), join(distDir, 'ui', 'popup.css'));

const localesDir = join(here, '_locales');
if (existsSync(localesDir)) {
  cpSync(localesDir, join(distDir, '_locales'), { recursive: true });
}

const iconsDir = join(here, 'icons');
if (existsSync(iconsDir)) {
  cpSync(iconsDir, join(distDir, 'icons'), { recursive: true });
}

console.log(`Build complete: ${distDir}`);
