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
 */

import { build } from 'esbuild';
import { rmSync, mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

copyFileSync(join(here, 'manifest.json'), join(distDir, 'manifest.json'));

mkdirSync(join(distDir, 'rules'), { recursive: true });
copyFileSync(join(here, 'src', 'rules', 'rules.json'), join(distDir, 'rules', 'ruleset.json'));

const iconsDir = join(here, 'icons');
if (existsSync(iconsDir)) {
  cpSync(iconsDir, join(distDir, 'icons'), { recursive: true });
}

console.log(`Build complete: ${distDir}`);
