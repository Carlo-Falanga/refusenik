# Refusenik

A browser extension that **refuses** cookie consent banners instead of hiding them.

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

## Building and running

These are the exact steps to reproduce the package from a clean checkout.

```
node --version        # v24.14.0 is the minimum tested version
npm ci                # installs exactly the versions pinned in package-lock.json
npm run build         # bundles the extension into dist/
npm test              # unit and contract tests, on Node's built-in runner
```

Two further scripts are useful while working on it:

```
npm run lint:ext      # runs web-ext lint against dist/
npm run start:firefox # launches Firefox with the extension loaded from dist/
```

`npm run build` bundles `src/engine/content.js`, `src/engine/background.js` and
`src/ui/popup.js` with esbuild, copies `manifest.json`, the popup markup and
styles, `_locales/` and `icons/` as-is, and resolves `src/rules/rules.json`
against `src/rules/labels.json` into the fully literal
`dist/rules/ruleset.json` that ships in the package.

`dist/` is a disposable build artifact, git-ignored and never committed: the
committed sources are `manifest.json`, `build.mjs` and `src/`. Deleting `dist/`
and re-running the commands above rebuilds it from those sources alone, with
the tool versions pinned by the lockfile.

There are no runtime dependencies; `jsdom` is used for tests only. All build
tooling — esbuild, web-ext and Node's own test runner — is open source and runs
entirely locally. No web service or remote build step is involved at any point.

## How the extension runs

The background runs as a non-persistent Firefox MV3 event page (Firefox does
not support service workers for extensions). It owns the ruleset - loading,
verifying, refreshing it on a 12h `browser.alarms` schedule, and caching it -
and content scripts only ever ask it for the active ruleset over
`runtime.sendMessage`; they never fetch it themselves.

## Attribution

Rules for several CMPs are adapted from [Consent-O-Matic](https://github.com/cavi-au/Consent-O-Matic)
(MIT). See `src/rules/ATTRIBUTIONS.md` for the full notice.

## License

Refusenik is licensed under the GNU General Public License v3.0
(GPL-3.0-only). See `LICENSE` for the full text and
`src/rules/ATTRIBUTIONS.md` for third-party licensing notices on the rules
adapted from Consent-O-Matic.
