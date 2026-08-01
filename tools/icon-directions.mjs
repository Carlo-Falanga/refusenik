/**
 * Generates four candidate directions for a redesigned extension icon (the
 * current icon is a placeholder: a white "R" on a black rounded square) and
 * renders a side-by-side comparison sheet so a human can pick one before any
 * final icon is produced.
 *
 *   node tools/icon-directions.mjs
 *
 * This is a proposal/review tool, not part of the shipped extension: it does
 * not touch icons/refusenik-dark.svg, icons/refusenik-light.svg,
 * tools/build-icons.mjs, manifest.json or anything under src/. Every SVG
 * below is written by hand (rect/line/polygon/circle - no traced paths) and
 * is the single source of truth: running this script (re)writes the 8 SVG
 * files and the comparison PNG from these definitions, so tweaking a
 * thickness here and re-running is the whole iteration loop.
 *
 * Each direction gets a "-dark" variant (ink-colored shapes, for use on
 * light/bright toolbar backgrounds) and a "-light" variant (paper-colored
 * shapes, same roles, for use on dark toolbar backgrounds) - the same
 * dark/light naming convention already used by icons/refusenik-*.svg.
 *
 * Output:
 *   - 8 SVG files in <vault>/cookie-refuser/icone/proposte/
 *   - 1 comparison PNG at <vault>/cookie-refuser/icone/direzioni-v2.png
 *     (1440px wide, full page height, built with Playwright/Chromium
 *     exactly like tools/build-icons.mjs uses it to rasterize SVG).
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This phase only produces proposals for a human to choose from, so its output
// is a design record rather than a build artifact. It defaults to a folder
// inside the repository, which keeps a clean checkout working with no setup;
// set ICON_OUT_DIR to keep that record in a notes directory instead.
const VAULT_ICONS_DIR = process.env.ICON_OUT_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'verification', 'icons');
const PROPOSALS_DIR = join(VAULT_ICONS_DIR, 'proposte');
const SHEET_PATH = join(VAULT_ICONS_DIR, 'direzioni-v2.png');

const INK = '#12120F';
const PAPER = '#F2EFE6';

const SVG_HEAD = 'xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"';

// ---------------------------------------------------------------------------
// A - "Il timbro": a thick empty frame crossed by a diagonal bar, like a
// rejection stamp on a document. No fill inside the frame - the shape is
// pure outline plus one diagonal stroke.
// ---------------------------------------------------------------------------

function timbroSvg(shapeColor) {
  return `<svg ${SVG_HEAD}>
  <rect x="12" y="12" width="104" height="104" rx="14" fill="none" stroke="${shapeColor}" stroke-width="12"/>
  <rect x="-25" y="55" width="178" height="18" fill="${shapeColor}" transform="rotate(-45 64 64)"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// B - "Il banner reciso": a solid rounded square (the page) with a paper-
// colored horizontal strip (the cookie banner) in its lower half, split by a
// diagonal gap into two pieces that no longer line up - the right piece
// dropped down and to the right, as if sliced and sliding apart.
// ---------------------------------------------------------------------------

function bannerSvg(pageColor, stripColor, clipId) {
  // Three earlier attempts failed at 16px: a strip floating mid-page read as
  // a monitor stand, a diagonal cut pinching one piece into a corner point
  // read as a speech-bubble tail, and even a centered pair of small blocks
  // still merged into one small blob that again read as a monitor stand -
  // any single small shape centered under a rounded square reads as that
  // glyph once downscaled that far. Fixed by making both pieces wide and
  // reaching the left/right edges, with a wide centered gap between them,
  // so what survives downscaling is two distinct side pieces rather than
  // one blob in the middle.
  return `<svg ${SVG_HEAD}>
  <defs><clipPath id="${clipId}"><rect x="4" y="4" width="120" height="120" rx="24"/></clipPath></defs>
  <rect x="4" y="4" width="120" height="120" rx="24" fill="${pageColor}"/>
  <g clip-path="url(#${clipId})">
    <rect x="4" y="80" width="48" height="40" fill="${stripColor}"/>
    <g transform="translate(4,8)">
      <rect x="76" y="80" width="48" height="40" fill="${stripColor}"/>
    </g>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// C - "La R nel divieto": the brand's existing R, blocky and geometric,
// inside a solid disc, crossed by a diagonal "no" bar. The bar keeps a
// background-colored margin around itself (like the R's own counter-hole)
// so it reads as cutting through rather than just overlapping.
// ---------------------------------------------------------------------------

function rSvg(discColor, letterColor, barColor) {
  return `<svg ${SVG_HEAD}>
  <circle cx="64" cy="64" r="60" fill="${discColor}"/>
  <rect x="38" y="30" width="14" height="68" fill="${letterColor}"/>
  <rect x="38" y="30" width="52" height="38" fill="${letterColor}"/>
  <rect x="52" y="40" width="26" height="18" fill="${discColor}"/>
  <polygon points="52,68 68,68 90,98 74,98" fill="${letterColor}"/>
  <g transform="rotate(-45 64 64)">
    <rect x="-6" y="52.5" width="140" height="23" fill="${discColor}"/>
    <rect x="-6" y="56.5" width="140" height="15" fill="${barColor}"/>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// D - "La X": refusal reduced to its plainest form, a thick square-capped X
// on a solid rounded square.
// ---------------------------------------------------------------------------

function xSvg(fieldColor, strokeColor) {
  return `<svg ${SVG_HEAD}>
  <rect x="4" y="4" width="120" height="120" rx="26" fill="${fieldColor}"/>
  <line x1="31" y1="31" x2="97" y2="97" stroke="${strokeColor}" stroke-width="17" stroke-linecap="square"/>
  <line x1="31" y1="97" x2="97" y2="31" stroke="${strokeColor}" stroke-width="17" stroke-linecap="square"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// The four directions, each with its dark (ink shapes, for light bars) and
// light (paper shapes, for dark bars) variant, plus the copy for the sheet.
// ---------------------------------------------------------------------------

const DIRECTIONS = [
  {
    code: 'A',
    slug: 'a-timbro',
    title: 'Il timbro',
    description:
      'Una cornice vuota attraversata da un tratto diagonale, come un timbro di rifiuto su un documento. Senza superficie piena regge meno bene sui fondi scuri, e a 16px la cornice si assottiglia parecchio.',
    dark: timbroSvg(INK),
    light: timbroSvg(PAPER),
  },
  {
    code: 'B',
    slug: 'b-banner',
    title: 'Il banner reciso',
    description:
      'La pagina piena, con il banner cookie tagliato in due tronconi che scivolano fuori asse. Racconta letteralmente cosa fa l\u2019estensione, ma è la direzione più affollata e la più delicata da leggere in piccolo.',
    dark: bannerSvg(INK, PAPER, 'bDarkClip'),
    light: bannerSvg(PAPER, INK, 'bLightClip'),
  },
  {
    code: 'C',
    slug: 'c-r',
    title: 'La R nel divieto',
    description:
      'Riprende la R del marchio attuale, chiusa in un disco e sbarrata come un segnale di divieto. Continuità con l\u2019icona esistente, ma lettera e sbarra si affollano nello stesso spazio: a 16px il vuoto interno tende a sparire.',
    dark: rSvg(INK, PAPER, INK),
    light: rSvg(PAPER, INK, PAPER),
  },
  {
    code: 'D',
    slug: 'd-x',
    title: 'La X',
    description:
      'Il rifiuto ridotto alla sua forma più essenziale: una X spessa e squadrata su un campo pieno. La più leggibile a ogni dimensione, ma anche la meno legata all\u2019identità specifica del prodotto.',
    dark: xSvg(INK, PAPER),
    light: xSvg(PAPER, INK),
  },
];

// ---------------------------------------------------------------------------
// Write the 8 SVG files.
// ---------------------------------------------------------------------------

function writeSvgFiles() {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const written = [];
  for (const direction of DIRECTIONS) {
    for (const [variant, svg] of [['dark', direction.dark], ['light', direction.light]]) {
      const file = `${direction.slug}-${variant}.svg`;
      const outPath = join(PROPOSALS_DIR, file);
      writeFileSync(outPath, svg, 'utf8');
      written.push(outPath);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Comparison sheet: one HTML page, one Chromium screenshot. Each icon is
// embedded as a base64 data-URI <img>, sized purely with CSS width/height -
// since every image is its own independent SVG resource, there is no risk of
// id collisions between the different icons' <defs> on the same page.
// ---------------------------------------------------------------------------

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

function cardHtml(direction) {
  const bigUri = toDataUri(direction.dark);
  return `
      <article class="card">
        <div class="card-label"><span class="tag">${direction.code}</span>DIREZIONE ${direction.code}</div>
        <h2>${direction.title}</h2>
        <p class="desc">${direction.description}</p>
        <div class="icon-stage"><img src="${bigUri}" style="width:128px;height:128px;" alt=""></div>
        <div class="sizes-row">
          <div class="swatch light">
            <span class="label">Barra chiara</span>
            <div class="size-group">${sizeGroupHtml(direction.dark)}</div>
          </div>
          <div class="swatch dark">
            <span class="label">Barra scura</span>
            <div class="size-group">${sizeGroupHtml(direction.light)}</div>
          </div>
        </div>
      </article>`;
}

function pageHtml() {
  const cards = DIRECTIONS.map(cardHtml).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --ink: ${INK};
    --paper: ${PAPER};
    --accent: #D8382B;
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
  .grid {
    margin-top: 48px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 56px 64px;
  }
  .card {
    border-top: 3px solid var(--ink);
    padding-top: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .card-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(18, 18, 15, 0.55);
  }
  .card-label .tag {
    background: var(--accent);
    color: var(--paper);
    padding: 1px 6px;
    letter-spacing: 0.05em;
  }
  .card h2 {
    margin: 0;
    font-size: 21px;
    font-weight: 700;
  }
  .card p.desc {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: rgba(18, 18, 15, 0.78);
    max-width: 48ch;
  }
  .icon-stage {
    align-self: flex-start;
    border: 1px solid rgba(18, 18, 15, 0.16);
    background: #ffffff;
    padding: 20px;
    line-height: 0;
  }
  .sizes-row {
    display: flex;
    gap: 16px;
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
      <h1>REFUSENIK &middot; NUOVE DIREZIONI PER L'ICONA</h1>
      <p>Ogni direzione è mostrata a 128px e poi alle dimensioni reali della toolbar del browser (32, 24, 16px), sulle due barre di sfondo che l'icona incontrerà davvero.</p>
    </header>
    <div class="grid">${cards}
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const svgFiles = writeSvgFiles();
  console.log('Wrote SVG proposals:');
  for (const path of svgFiles) console.log(`  ${path}`);

  mkdirSync(VAULT_ICONS_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(pageHtml());
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  await page.screenshot({ path: SHEET_PATH, fullPage: true });
  await browser.close();

  console.log(`\nWrote comparison sheet: ${SHEET_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
