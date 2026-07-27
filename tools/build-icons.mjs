/**
 * Rasterizes the icon SVG sources into the PNG sizes the manifest needs.
 *
 *   node tools/build-icons.mjs
 *
 * Renders each source SVG at each target size with Playwright (Chromium),
 * screenshotting a transparent viewport sized to match exactly, so every
 * PNG comes out at precisely NxN px with no surrounding fill.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const iconsDir = join(root, 'icons');

const sources = {
  dark: readFileSync(join(iconsDir, 'refusenik-dark.svg'), 'utf8'),
  light: readFileSync(join(iconsDir, 'refusenik-light.svg'), 'utf8'),
};

const targets = [
  { source: 'dark', size: 48, file: 'icon-48.png' },
  { source: 'dark', size: 96, file: 'icon-96.png' },
  { source: 'dark', size: 128, file: 'icon-128.png' },
  { source: 'dark', size: 512, file: 'icon-512.png' },
  { source: 'dark', size: 16, file: 'icon-dark-16.png' },
  { source: 'dark', size: 32, file: 'icon-dark-32.png' },
  { source: 'light', size: 16, file: 'icon-light-16.png' },
  { source: 'light', size: 32, file: 'icon-light-32.png' },
];

function pageHtml(svg, size) {
  const sized = svg.replace(/width="128"/, `width="${size}"`).replace(/height="128"/, `height="${size}"`);
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;}
  </style></head><body>${sized}</body></html>`;
}

function readPngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const generated = [];
  for (const target of targets) {
    const { source, size, file } = target;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(pageHtml(sources[source], size));
    const outPath = join(iconsDir, file);
    const buffer = await page.screenshot({ path: outPath, omitBackground: true });
    const { width, height } = readPngDimensions(buffer);
    generated.push({ file, width, height });
  }

  await browser.close();

  console.log('Generated icons:');
  for (const { file, width, height } of generated) {
    console.log(`  ${file.padEnd(20)} ${width}x${height}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
