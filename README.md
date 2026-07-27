# cookie-refuser

A browser extension that **refuses** cookie consent banners instead of hiding them.

Working name — subject to change before release.

## Why this is different

Most tools hide consent banners with CSS. The banner disappears from view, but no
refusal is ever registered: scroll-blocking overlays remain, the banner reappears,
and the site still believes no choice was made.

This extension clicks the actual refusal path. Where a CMP requires it, it opens
preferences, clears the optional categories and saves.

## Design principles

**Never break a page.** On a site whose CMP is not recognised, the extension does
nothing at all and surfaces a report button instead. Acting on a page we do not
understand is worse than leaving a banner up.

**No telemetry, ever.** Nothing is collected automatically. A report is sent only
when the user explicitly clicks, and contains only the domain, the detected CMP
(if any) and the extension version.

**Rules are data, never code.** The extension ships a fixed interpreter and a
closed set of DOM actions. Rules are declarative JSON, fetched and cached at
runtime, signed and verified before use. This is what allows a new rule to reach
users in minutes rather than waiting on store review — without ever executing
remote code.

## Layout

```
src/engine/   selector resolution, step execution, CMP detection, remote channel
src/rules/    rules for the supported CMPs, multilingual labels, attributions
src/ui/       popup and report button
test/         unit tests and the rules/engine contract tests
```

## Development

```
npm install
npm test
```

Tests run on Node's built-in runner. There are no runtime dependencies; `jsdom`
is used for tests only.

## Building and running the extension

```
npm run build         # bundles content.js/background.js with esbuild into dist/
npm run lint:ext      # runs web-ext lint against dist/
npm run start:firefox # launches Firefox with the extension loaded from dist/
```

`dist/` is a disposable build artifact (git-ignored, never committed): the
committed sources are `manifest.json`, `build.mjs` and `src/`.

The background runs as a non-persistent Firefox MV3 event page (Firefox does
not support service workers for extensions). It owns the ruleset - loading,
verifying, refreshing it on a 12h `browser.alarms` schedule, and caching it -
and content scripts only ever ask it for the active ruleset over
`runtime.sendMessage`; they never fetch it themselves.

## Attribution

Rules for several CMPs are adapted from [Consent-O-Matic](https://github.com/cavi-au/Consent-O-Matic)
(MIT). See `src/rules/ATTRIBUTIONS.md` for the full notice.
