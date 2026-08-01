/**
 * Renders a verification sheet for the final, shipped extension icon
 * ("il banner sbarrato", direction A from tools/icon-directions-v3.mjs):
 * the icon at 128px, plus the dark/light variants at the toolbar sizes
 * (32, 24, 16px) on both a light and a dark background.
 *
 *   node tools/icon-final-sheet.mjs
 *
 * Reads the shipped sources directly from icons/refusenik-dark.svg and
 * icons/refusenik-light.svg (not the historical proposals), so the sheet
 * always reflects whatever is actually built into the extension.
 *
 * Output:
 *   - 1 PNG at <vault>/cookie-refuser/icone/icona-finale.png
 *     (1440px wide, full page height, rasterized with Playwright/Chromium).
 */

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const iconsDir = join(root, 'icons');

// The sheet is a design record rather than a build artifact. It defaults to a
// folder inside the repository, which keeps a clean checkout working with no
// setup; set ICON_OUT_DIR to keep that record in a notes directory instead.
const VAULT_ICONS_DIR = process.env.ICON_OUT_DIR || join(root, 'verification', 'icons');
const SHEET_PATH = join(VAULT_ICONS_DIR, 'icona-finale.png');

const dark = readFileSync(join(iconsDir, 'refusenik-dark.svg'), 'utf8');
const light = readFileSync(join(iconsDir, 'refusenik-light.svg'), 'utf8');

function toDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

const REVIEW_SIZES = [32, 24, 16];

function sizeGroupHtml(svg) {
  const uri = toDataUri(svg);
  return REVIEW_SIZES.map(
    (size) => `
        <div class="size-item">
          <img src="${uri}" style="width:${size}px;height:${size}px;" alt="">
          <span class="px-label">${size}px</span>
        </div>`
  ).join('');
}

function pageHtml() {
  const bigUri = toDataUri(dark);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --ink: #12120F;
    --paper: #F2EFE6;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #EDEAE1;
    color: var(--ink);
    font-family: system-ui, "Segoe UI", sans-serif;
  }
  .sheet {
    width: 1440px;
    padding: 64px 80px 96px;
  }
  header h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }
  header p {
    margin: 12px 0 0;
    font-size: 15px;
    color: rgba(18, 18, 15, 0.62);
    max-width: 70ch;
  }
  .stage-row {
    margin-top: 48px;
    display: flex;
    align-items: flex-start;
    gap: 64px;
  }
  .icon-stage {
    border: 1px solid rgba(18, 18, 15, 0.16);
    background: #ffffff;
    padding: 20px;
    line-height: 0;
  }
  .icon-stage-label {
    margin-top: 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(18, 18, 15, 0.55);
  }
  .sizes-row {
    display: flex;
    gap: 16px;
    flex: 1;
  }
  .swatch {
    flex: 1;
    border: 1px solid rgba(18, 18, 15, 0.12);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .swatch.light { background: #ffffff; }
  .swatch.dark { background: #1A1A17; }
  .swatch .label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .swatch.light .label { color: rgba(18, 18, 15, 0.5); }
  .swatch.dark .label { color: rgba(242, 239, 230, 0.6); }
  .size-group {
    display: flex;
    align-items: flex-end;
    gap: 20px;
  }
  .size-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .size-item img { display: block; }
  .px-label {
    font-size: 10px;
  }
  .swatch.light .px-label { color: rgba(18, 18, 15, 0.55); }
  .swatch.dark .px-label { color: rgba(242, 239, 230, 0.65); }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <h1>REFUSENIK &middot; ICONA DEFINITIVA</h1>
      <p>La direzione A, "il banner sbarrato", scelta al termine della revisione. L'icona a 128px per l'estensione, e le due varianti dark/light alle taglie reali della toolbar del browser (32, 24, 16px), sulle due barre di sfondo che incontrerà davvero.</p>
    </header>
    <div class="stage-row">
      <div>
        <div class="icon-stage"><img src="${bigUri}" style="width:128px;height:128px;" alt=""></div>
        <div class="icon-stage-label">128px</div>
      </div>
      <div class="sizes-row">
        <div class="swatch light">
          <span class="label">Fondo chiaro</span>
          <div class="size-group">${sizeGroupHtml(dark)}</div>
        </div>
        <div class="swatch dark">
          <span class="label">Fondo scuro</span>
          <div class="size-group">${sizeGroupHtml(light)}</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  mkdirSync(VAULT_ICONS_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(pageHtml());
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  const sheet = page.locator('.sheet');
  await page.screenshot({ path: SHEET_PATH, clip: await sheet.boundingBox() });
  await browser.close();

  console.log(`Wrote verification sheet: ${SHEET_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
