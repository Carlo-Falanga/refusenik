/**
 * Second round of candidate directions for the redesigned extension icon.
 * The first round (tools/icon-directions.mjs) was fully reviewed: "il
 * timbro" (barra che tocca gli angoli, letta come ⌀), "il banner reciso"
 * (letto come un monitor a 128px e una macchia a 16px) and "la R nel
 * divieto" (lettera coperta dalla sbarra, resta un disco con una tacca)
 * were all rejected. Only "la X" survived and is reused here unchanged.
 *
 * This script produces three NEW directions plus the same X, with the same
 * hand-written-SVG discipline and the same rasterized comparison sheet as
 * the first round:
 *
 *   node tools/icon-directions-v3.mjs
 *
 * This is a proposal/review tool, not part of the shipped extension: it
 * does not touch icons/refusenik-dark.svg, icons/refusenik-light.svg,
 * tools/build-icons.mjs, manifest.json, src/* or tools/icon-directions.mjs
 * (which stays untouched as the historical record of the first round).
 *
 * Output:
 *   - 8 SVG files in <vault>/cookie-refuser/icone/proposte-v3/
 *   - 1 comparison PNG at <vault>/cookie-refuser/icone/direzioni-v3.png
 *     (1440px wide, full page height, rasterized with Playwright/Chromium).
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
const PROPOSALS_DIR = join(VAULT_ICONS_DIR, 'proposte-v3');
const SHEET_PATH = join(VAULT_ICONS_DIR, 'direzioni-v3.png');

const INK = '#12120F';
const PAPER = '#F2EFE6';

const SVG_HEAD = 'xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"';

// ---------------------------------------------------------------------------
// A - "Il banner sbarrato": a solid disc (the universal "no" glyph), crossed
// by a diagonal band shaped like a strip/banner - thick, square-capped, cut
// off cleanly by the disc's own circular outline via a clip.
// ---------------------------------------------------------------------------

function bannerSbarratoSvg(discColor, bandColor, clipId) {
  return `<svg ${SVG_HEAD}>
  <defs><clipPath id="${clipId}"><circle cx="64" cy="64" r="60"/></clipPath></defs>
  <circle cx="64" cy="64" r="60" fill="${discColor}"/>
  <g clip-path="url(#${clipId})">
    <rect x="-30" y="52" width="188" height="24" fill="${bandColor}" transform="rotate(-35 64 64)"/>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// B - "Il timbro, corretto": the same rejection-stamp idea as the first
// round, but fixed at the root cause. The frame is a much heavier stroke,
// and the diagonal bar's endpoints sit on the LEFT/RIGHT SIDES of the
// square (not on its corners), overshooting the frame by a few pixels on
// each end - so the bar reads as a stamped-on cancel mark rather than the
// diameter/no-entry glyph the corner-to-corner version collapsed into.
// ---------------------------------------------------------------------------

function timbroCorrettoSvg(color) {
  // Two earlier passes both failed at 16px: a ~30-degree bar hugging the
  // corners read as a frame with a corner-to-corner diagonal (the "broken
  // image" placeholder glyph), and a shallower ~20-degree bar combined with
  // heavily rounded corners split the frame into two lobes that read as the
  // digit 8 or the letter S. Fixed with a middle angle and much less corner
  // rounding, so the frame stays a plain square-ish tag rather than lobing
  // into a numeral, while the bar still lands on the sides, not the corners.
  return `<svg ${SVG_HEAD}>
  <rect x="12" y="12" width="104" height="104" rx="10" fill="none" stroke="${color}" stroke-width="15"/>
  <line x1="7" y1="90.5" x2="121" y2="37.5" stroke="${color}" stroke-width="20" stroke-linecap="square"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// C - "La casella negata": a checkbox frame (rounded square, thick stroke)
// with a solid horizontal bar where the checkmark would go, spanning edge
// to edge of the frame's inner face. It is literally what the extension
// does - every optional consent category left unchecked.
// ---------------------------------------------------------------------------

function caselleSvg(color) {
  return `<svg ${SVG_HEAD}>
  <rect x="14" y="14" width="100" height="100" rx="10" fill="none" stroke="${color}" stroke-width="14"/>
  <rect x="21" y="55" width="86" height="18" fill="${color}"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// D - "La X": unchanged from the first round - the reference for legibility.
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
    slug: 'a-banner-sbarrato',
    title: 'Il banner sbarrato',
    description:
      'Il segnale di divieto universale, ma la sua barra è sagomata come un banner: spessa, a bordi squadrati, tagliata di netto dal profilo del disco. Il compromesso: la barra deve restare abbastanza spessa da leggersi come nastro anche in piccolo, altrimenti torna a essere solo un disco pieno senza segno.',
    dark: bannerSbarratoSvg(INK, PAPER, 'aDarkClip'),
    light: bannerSbarratoSvg(PAPER, INK, 'aLightClip'),
  },
  {
    code: 'B',
    slug: 'b-timbro',
    title: 'Il timbro, corretto',
    description:
      'Stessa idea del timbro del primo giro, ma con la correzione che serviva: la barra tocca i lati del quadrato, non gli angoli, e sporge oltre la cornice. Il compromesso: una cornice vuota regge meno bene di una forma piena sui fondi scuri e alle taglie più piccole, dove lo spessore va spinto al massimo per non assottigliarsi.',
    dark: timbroCorrettoSvg(INK),
    light: timbroCorrettoSvg(PAPER),
  },
  {
    code: 'C',
    slug: 'c-casella',
    title: 'La casella negata',
    description:
      'Una casella di spunta che resta vuota, con un trattino orizzontale al posto del segno di conferma: è letteralmente ciò che fa l\u2019estensione, deselezionare tutte le categorie opzionali. Il compromesso: senza il contesto di un\u2019icona di estensione, un quadrato con un trattino può leggersi anche come un pulsante "meno" o una casella disabilitata.',
    dark: caselleSvg(INK),
    light: caselleSvg(PAPER),
  },
  {
    code: 'D',
    slug: 'd-x',
    title: 'La X',
    description:
      'Riproposta identica dal primo giro: il rifiuto ridotto alla sua forma più essenziale, una X spessa e squadrata su un campo pieno. L\u2019unica direzione promossa finora - resta il riferimento di leggibilità con cui confrontare le nuove proposte.',
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
      <h1>REFUSENIK &middot; DIREZIONI PER L'ICONA &middot; SECONDO GIRO</h1>
      <p>Del primo giro sono state scartate tutte le direzioni tranne la X (D, qui riproposta identica come riferimento di leggibilità). Le altre tre sono nuove tentativi che correggono i difetti riscontrati. Ogni direzione è mostrata a 128px e poi alle dimensioni reali della toolbar del browser (32, 24, 16px), sulle due barre di sfondo che l'icona incontrerà davvero.</p>
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
