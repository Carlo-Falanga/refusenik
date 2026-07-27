# site/

Static files served at `rules.refusenik.app`, deployed on Vercel with this
folder as the project's Root Directory. `vercel.json` sets the response
headers (content type, CORS, edge caching).

## Contents

- `ruleset.json` - the published remote ruleset, exactly as the extension
  downloads it.
- `ruleset.json.sig` - its detached ECDSA P-256/SHA-256 signature, base64,
  as plain text.

## Signing happens offline, not on this hosting

Both files are produced and signed on a local machine, with a private key
that is never uploaded to Vercel, set as an environment variable, or stored
anywhere in this repository. Only the already-signed output is committed
and deployed.

This is deliberate: the extension verifies the signature on every ruleset
it downloads and refuses anything that does not match (see
`src/engine/signature.js` and `src/engine/ruleset.js`). If the private key
existed on this hosting, whoever compromised the hosting could sign and
serve a malicious ruleset - one that clicks "accept all" instead of
"reject", for example - and every extension installation would accept it.
Keeping the key offline means a compromise of this hosting can, at worst,
serve data that fails signature verification, which the extension simply
discards while continuing to use its last valid ruleset.

## Publishing an update

From the repository root, with the private key available locally:

```
npm run build
node tools/publish-ruleset.mjs <path-to-private-key>
```

The script refuses to publish unless the new ruleset's `rulesetVersion` is
strictly greater than the one already in `ruleset.json`, and re-verifies
the signature it just produced before reporting success. Commit and push
the resulting `ruleset.json` and `ruleset.json.sig`; Vercel deploys them as
static files.
