/**
 * Builds an extended site list for measuring rule coverage, starting from the
 * 393 hand-verified sites in verify-sites.json and filling the rest from
 * Tranco (https://tranco-list.eu) - a public, non-commercial ranking of the
 * most visited domains, built specifically to be a neutral, redistributable
 * research baseline (unlike Alexa/SimilarWeb-style rankings, which are not
 * free to redistribute and are skewed by whatever toolbar or panel fed them).
 *
 * Usage:
 *   node tools/expand-sites.mjs                  # writes tools/verify-sites-1200.json
 *   node tools/expand-sites.mjs --limit 2000      # a different target size
 *   node tools/expand-sites.mjs --out my-list.json
 *
 * What this deliberately does NOT do: it never writes, moves or renames
 * verify-sites.json itself. That file's 393 `expect` values are knowledge
 * earned by watching real sites live, and every historical sweep report is
 * keyed against exactly that set - overwriting it would silently make every
 * past report incomparable to future ones. See the hard guard for this near
 * the top of main().
 *
 * The 393 existing entries are carried over byte-for-byte (see the trailing
 * bracket splicing in main()), not re-serialised from parsed objects,
 * precisely so their `expect` values and the file's existing formatting
 * cannot drift even by a stray whitespace change. New entries are appended after them,
 * pulled from Tranco in rank order and filtered against the exclusion lists
 * below, until --limit is reached (807 new sites for the default of 1200).
 *
 * No unzip dependency is used or needed. Tranco ships its CSV inside a
 * single-entry zip archive, and a zip local file header is a fixed,
 * documented 30-byte structure (PKWARE APPNOTE.TXT sez.4.3.7) followed by the
 * file name, an optional extra field, then the raw entry data - so reading it
 * is a handful of readUInt calls plus node:zlib's inflateRawSync for the one
 * compression method (8, deflate) zip actually uses in practice. That is
 * exactly what extractFirstZipEntry() below does, in well under 40 lines,
 * and it is chosen over shelling out to an external `unzip`/`tar` specifically
 * because it needs nothing beyond what Node already ships - no path lookup,
 * no platform-specific fallback, no silent "it worked on my machine". If
 * Tranco ever ships a differently-structured archive, extractFirstZipEntry()
 * is written to throw loudly rather than return something empty or partial.
 */

import {
  readFileSync, writeFileSync, existsSync, realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import https from 'node:https';

const here = dirname(fileURLToPath(import.meta.url));
const SITES_PATH = join(here, 'verify-sites.json');

// tranco-list.eu/top-1m.csv.zip always 307-redirects to whatever the current
// daily list happens to be (today it landed on /download/daily/top-1m.csv.zip).
// That is intentional here, not a shortcut: pinning to one historical list ID
// would freeze this tool's output on a ranking that only gets staler, when
// the entire point of a coverage sweep is to reflect what real, currently
// popular sites look like today.
const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip';
const MAX_REDIRECTS = 5;

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

const LIMIT = Number(argValue('--limit', 1200)) || 1200;
const OUT_NAME = argValue('--out', 'verify-sites-1200.json');
const outPath = isAbsolute(OUT_NAME) ? OUT_NAME : join(here, OUT_NAME);

/**
 * True when `pathA` and `pathB` refer to the exact same file on disk, which
 * is a stronger question than "are these the same string". Two things a
 * plain `resolve(a) === resolve(b)` gets wrong:
 *
 *  - Case. `resolve()` only makes a path absolute; it never normalises case.
 *    NTFS (and Windows filesystems generally) are case-insensitive, so
 *    "VERIFY-SITES.JSON" and "verify-sites.json" are the same file even
 *    though the strings differ - confirmed live on this machine: --out
 *    VERIFY-SITES.JSON slipped straight past a case-sensitive compare and
 *    overwrote verify-sites.json outright. caseNormalize() below lower-cases
 *    both sides on win32 (and only on win32 - a case-sensitive filesystem
 *    really does treat differently-cased paths as different files) before
 *    the first comparison, so this is caught without needing either path to
 *    exist yet.
 *  - Aliasing. A path that looks completely different can still land on the
 *    same file via a symlink or an NTFS junction. realpathSync.native (the
 *    OS-backed resolver, not the pure-JS fallback) follows those down to the
 *    real filesystem entry and, on Windows, also returns the file's true
 *    on-disk casing - catching case differences the string compare above
 *    cannot when they are hidden behind a link. This half only runs once
 *    both paths actually exist (resolving one that is not there yet would
 *    throw for a reason unrelated to this check), and any failure here (a
 *    dangling link, a permissions error) is treated as "not provably the
 *    same file" rather than crashing the guard over an unrelated filesystem
 *    hiccup.
 */
function sameFile(pathA, pathB) {
  const resolvedA = resolve(pathA);
  const resolvedB = resolve(pathB);
  const caseNormalize = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (caseNormalize(resolvedA) === caseNormalize(resolvedB)) return true;

  if (!existsSync(resolvedA) || !existsSync(resolvedB)) return false;
  try {
    const realA = realpathSync.native(resolvedA);
    const realB = realpathSync.native(resolvedB);
    return caseNormalize(realA) === caseNormalize(realB);
  } catch {
    return false;
  }
}

// The one thing this script must never do, checked before a single byte is
// downloaded: verify-sites.json's `expect` fields are knowledge gained by
// watching real sites live, and every historical sweep report was measured
// against exactly that 393-site set. Overwriting it - even with a superset
// that carries the same 393 entries - would still rewrite the file (a
// different byte layout, a different array length) and make every existing
// verification/*.json report silently incomparable to whatever runs next.
if (sameFile(outPath, SITES_PATH)) {
  console.error('! rifiuto di scrivere su tools/verify-sites.json: i suoi valori "expect" sono');
  console.error('  conoscenza verificata dal vivo, e i report di verifica storici (verification/*.json)');
  console.error('  diventerebbero incomparabili se questo file cambiasse. Usa --out per un altro percorso');
  console.error('  (di default questo script scrive tools/verify-sites-1200.json, che e\' distinto).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exclusion lists. Kept as plain, commented arrays (rather than one giant
// regex) so each category can be read, audited and extended on its own.
//
// Matching (see keywordMatches() below, right before isExcluded()) depends
// on whether a keyword contains a dot:
//   - a keyword WITH a dot is a full or partial domain (e.g. "wp.com",
//     "media.net") and is matched as a whole label: the candidate domain
//     must equal it exactly or end with ".<keyword>". A free substring test
//     here would be actively wrong - "wp.com" as a substring also matches
//     "wp.company" and "growp.com", and "media.net" also matches
//     "media.network", none of which are the CDN/ad-tech domain the keyword
//     was written for.
//   - a keyword WITHOUT a dot is a bare brand token (e.g. "akamai",
//     "taboola") with no such structure to anchor on, so it stays a free
//     substring test - cheap, and at "domain appears in a public top-1M
//     list" scale, the rare false positive (a legitimate site whose name
//     happens to contain the token) is an acceptable, easily-spotted
//     trade-off against a stricter match missing a real variant.
// ---------------------------------------------------------------------------

// CDNs and cloud/edge infrastructure: domains that serve assets or resolve
// traffic for other sites, not destinations anyone navigates to on their own.
// Measuring "coverage" against these would not be measuring a real site visit.
//
// 'cdn', 'dns' and '-servers' are deliberately generic substrings rather than
// one company name each: a first pass of this script against the real Tranco
// snapshot turned up dozens of country- and vendor-specific CDN/DNS domains
// (tiktokcdn.com, alicdn.com, dnspod.net, apple-dns.net, gtld-servers.net,
// registrar-servers.com, and so on) that no fixed brand list would keep up
// with as new ones rotate through the ranking. All three were checked by
// hand against every site this script actually pulled from Tranco and, at
// that size, matched nothing that was not itself CDN/DNS infrastructure - the
// substrings are short but not so short that ordinary words or brand names
// contain them by accident. 'cloud' was deliberately NOT added to this list
// despite catching real infrastructure (myhuaweicloud.com, dbankcloud.com,
// tencent-cloud.net...) because it also matches soundcloud.com, a genuine
// destination site, so the cloud-infra domains actually observed are listed
// individually below instead.
const CDN_INFRA_KEYWORDS = [
  'akamai', 'akamaiedge', 'akamaitechnologies', 'akamaihd', 'akadns',
  'cloudfront', 'cloudflare', 'fastly', 'fastlylb',
  'jsdelivr', 'unpkg', 'cdnjs',
  'gstatic', 'googleapis', 'googleusercontent', 'googlevideo', 'gvt1', 'gvt2', '1e100',
  'amazonaws', 'awsstatic', 'azureedge', 'azurewebsites', 'azurefd', 'msecnd', 'windows.net', 'msedge',
  'edgekey', 'edgesuite', 'edgecastcdn',
  'cachefly', 'stackpathdns', 'stackpathcdn', 'cdn77', 'bunnycdn', 'keycdn', 'cdnsun',
  'incapdns', 'imperva', 'sucuri',
  'llnwd', 'limelight',
  'fbcdn', 'twimg', 'cdninstagram',
  'wp.com', 'gravatar',
  'r2.dev',
  // '-servers' (with the leading hyphen) catches root/TLD nameserver
  // operators and registrar nameserver zones (gtld-servers.net,
  // root-servers.net, registrar-servers.com, tld-servers.ru, ci-servers.net)
  // - the plumbing that resolves domains, not a site itself. The hyphen is
  // deliberate: a bare "servers" substring would also match a real site
  // whose name happens to end that way, which "-servers" does not.
  'cdn', 'dns', '-servers', // generic substrings; see the note above for why
  // Static-asset CDNs for specific platforms, listed individually (rather
  // than a generic "static" substring, which risks matching an unrelated
  // brand whose name simply contains the word).
  'static.microsoft', 'mzstatic.com', 'steamstatic.com',
  // Vendor-specific cloud/IoT-sync backends observed in a real Tranco pull:
  // machine-to-machine traffic (device sync, account backup) inflates their
  // rank far beyond anything a person actually browses to.
  'hicloudcam', 'samsungcloud', 'samsungiotcloud', 'myhuaweicloud', 'huaweicloud',
  'skyhigh.cloud', 'myqcloud', 'tencent-cloud', 'hicloud.com', 'tplinkcloud',
  'oraclecloud', 'hihonorcloud', 'dbankcloud', 'yandexcloud', 'whecloud',
  'furycloud', 'usgovcloudapi', 'cloudsink', 'icloud-content',
  // Shared PaaS/user-content hosting zones: the domain itself belongs to the
  // platform, not to whichever of its many tenants happens to rank highly
  // this week, so there is no single site to measure coverage against.
  'netlify.app', 'vercel.app', 'vercel-dns', 'herokuapp.com', 'herokudns.com',
  'github.io', 'pages.dev', 'workers.dev', 'firebaseapp.com', 'web.app',
  'appspot.com', 'ngrok.io', 'surge.sh', 'onrender.com', 'digitaloceanspaces',
  // A game/app backend and a security/bot-mitigation edge network, both
  // machine-to-machine traffic rather than anything a person browses to.
  'steamserver', 'px-cloud', 'perimeterx',
  // Yandex's own static-asset CDN (the yastatic.net counterpart to
  // gstatic.com/fbcdn.net above).
  'yastatic',
  // ByteDance's non-China infrastructure backend, and Google's wildcard
  // user-content hosting zone for Blogger/blogspot (the usercontent.goog
  // counterpart to github.io/netlify.app above).
  'byteoversea', 'usercontent.goog',
];

// Ad-tech and tracking pixels/exchanges: reachable over HTTP, but they are not
// "sites" a person visits - they exist to serve or measure ads on other
// pages, which makes them meaningless entries for a "does the banner get
// dismissed on this page a user actually lands on" coverage list.
const ADTECH_KEYWORDS = [
  'doubleclick', 'googlesyndication', 'googleadservices', 'google-analytics',
  'googletagmanager', 'googletagservices',
  'scorecardresearch', 'criteo', 'adnxs', 'adsrvr', 'adform',
  'pubmatic', 'rubiconproject', 'openx', 'indexww', 'casalemedia', 'contextweb',
  'bidswitch', 'smartadserver', 'taboola', 'outbrain', 'mgid',
  'yieldmo', 'media.net', 'moatads', 'adroll', 'quantserve', 'bluekai', 'demdex',
  'krxd', 'tapad', 'agkn', 'mathtag', 'rlcdn', 'exponential', 'sharethrough',
  'triplelift', 'improvedigital', 'onetag', 'sovrn', 'rfihub', 'adsafeprotected',
  '3lift', 'yandexadexchange', 'adition', 'id5-sync',
  'appsflyer', 'teads', 'seedtag', 'aboutads.info', 'mythad',
  // A server-side tag-management domain (the "gtm-xxxx.com" naming pattern
  // used by tag-manager vendors for first-party-looking tagging endpoints),
  // observed once in a real Tranco pull and listed as-is rather than as a
  // "gtm-" prefix, since that prefix alone is too short to trust blindly.
  'gtm-a2b2.com',
  // The specific domain that first justified excluding analytics-only
  // backends: reachable, but nothing behind it but Apple's own app-analytics
  // collection endpoint. A bare "analytics" substring was tried and dropped
  // - the same caution that kept 'cloud' out of CDN_INFRA_KEYWORDS applies
  // here just as much, since "analytics" is common enough in real product
  // names that a generic substring risks excluding a genuine destination
  // site the same way 'cloud' would have excluded soundcloud.com.
  'app-analytics-services.com',
];

// Adult content. Matched by keyword rather than an exhaustive domain list
// because new adult domains constantly enter and leave any top-1M ranking;
// this is deliberately a little broad (it will catch some false positives
// among very obscure domains) rather than a curated list that would go stale
// the moment Tranco's next snapshot shuffles a new one into range.
const ADULT_KEYWORDS = [
  'porn', 'xxx', 'xvideos', 'xnxx', 'xhamster', 'hentai',
  'redtube', 'youporn', 'tube8', 'spankbang', 'brazzers',
  'livejasmin', 'bongacams', 'stripchat', 'chaturbate', 'onlyfans',
  'camsoda', 'myfreecams', 'motherless', 'thumbzilla', 'txxx',
  'javhub', 'javfor', 'erome', 'thothub', 'nhentai', 'rule34',
  'hclips', 'eporner', 'tnaflix', 'sexvid', 'sextube', 'cam4', 'manyvids',
  'fapdu', 'noodlemagazine', 'hqporner', 'sunporno',
];

// Domains that answer to a hostname but have no navigable web content at all
// (reverse-DNS infrastructure, IP-literal hosts) - a person cannot "visit"
// these the way they visit a site, so a consent-banner coverage list has
// nothing meaningful to measure on them.
const NON_NAVIGABLE_PATTERNS = [
  /\.arpa$/,
  /^in-addr\./,
  /^\d+\.\d+\.\d+\.\d+$/,
  /^localhost$/,
];

// A short list of domains that are reachable but exist purely as machine-to-
// machine APIs (no human-facing page with content, let alone a cookie
// banner to refuse). Deliberately small: most API-only services live on
// subdomains of a company's main site (already excluded above if that
// company is infrastructure, or simply not top-ranked enough to appear
// here), so this only needs to cover the handful of API-first domains that
// do show up in a global top-1M list on their own.
const PURE_API_DOMAINS = [
  'ip-api.com', 'ipapi.co', 'ipinfo.io', 'jsonip.com', 'ipify.org', 'httpstat.us',
  // App/game backend APIs observed in a real Tranco pull: reachable, but
  // nothing but a JSON endpoint behind the hostname.
  'userapi.com', 'capcutapi.com', 'opera-api.com', 'playfabapi.com',
];

/**
 * A keyword containing a dot is a full or partial domain, so it is matched
 * as a whole label (exact match or a "." + keyword suffix) rather than as a
 * free substring - see the exclusion-lists comment above for why a bare
 * substring test on something like "wp.com" or "media.net" is actively
 * wrong. A dot-less keyword is a bare brand token with no domain structure
 * to anchor on, so it stays a free substring test. Every list below
 * (including PURE_API_DOMAINS, whose entries are always full domains and so
 * always take the dotted branch) goes through this single function, so
 * there is exactly one place this rule is encoded rather than one
 * hand-written variant per list.
 */
function keywordMatches(domain, keyword) {
  if (keyword.includes('.')) return domain === keyword || domain.endsWith(`.${keyword}`);
  return domain.includes(keyword);
}

function isExcluded(domain) {
  if (NON_NAVIGABLE_PATTERNS.some((re) => re.test(domain))) return 'non-navigabile';
  if (CDN_INFRA_KEYWORDS.some((k) => keywordMatches(domain, k))) return 'cdn/infrastruttura';
  if (ADTECH_KEYWORDS.some((k) => keywordMatches(domain, k))) return 'tracker/ad-tech';
  if (ADULT_KEYWORDS.some((k) => keywordMatches(domain, k))) return 'contenuto per adulti';
  if (PURE_API_DOMAINS.some((k) => keywordMatches(domain, k))) return 'servizio solo api';
  return null;
}

// ---------------------------------------------------------------------------
// Geographic tagging for new entries, by ccTLD only. This is a heuristic, not
// a claim of where a site's audience actually is (a .com can be based
// anywhere) - it exists only to loosely group entries the same way the
// existing country field does, without inventing quotas Tranco's ranking
// does not actually support. Anything not recognised - most of a global top
// list, since .com/.net/.org dominate it - falls back to "global" rather than
// being guessed at.
// ---------------------------------------------------------------------------
const CCTLD_COUNTRY = {
  it: 'it',
  de: 'de',
  fr: 'fr',
  es: 'es',
  uk: 'uk',
  nl: 'nl',
  pl: 'pl',
  se: 'nordics', no: 'nordics', dk: 'nordics', fi: 'nordics', is: 'nordics',
  at: 'eu-other', ch: 'eu-other', be: 'eu-other', pt: 'eu-other', ie: 'eu-other',
  gr: 'eu-other', cz: 'eu-other', hu: 'eu-other', ro: 'eu-other', bg: 'eu-other',
  hr: 'eu-other', si: 'eu-other', sk: 'eu-other', lt: 'eu-other', lv: 'eu-other',
  ee: 'eu-other', lu: 'eu-other', mt: 'eu-other', cy: 'eu-other',
  us: 'us',
};

function countryFor(domain) {
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  // .co.uk et al. still end in "uk" as the last label, so this already
  // covers them alongside plain ".uk" without a separate special case.
  return CCTLD_COUNTRY[tld] || 'global';
}

function normalizeDomain(hostOrDomain) {
  const d = hostOrDomain.trim().toLowerCase();
  return d.startsWith('www.') ? d.slice(4) : d;
}

/**
 * Turns a domain into a filesystem/JSON-friendly slug, disambiguating against
 * every slug already taken (both the 393 existing ones and every new one
 * assigned so far in this same run) so two different domains that happen to
 * share a first label (media.net vs. media.io) cannot collide.
 */
function slugFor(domain, takenSlugs) {
  const labels = domain.split('.');
  let base = labels[0].replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'site';

  let candidate = base;
  if (takenSlugs.has(candidate)) candidate = `${base}-${labels[labels.length - 1]}`;
  let n = 2;
  while (takenSlugs.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  takenSlugs.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Download + zip extraction. No npm dependency: see the file-level comment
// for why the ~40-line hand-rolled zip reader below is preferred over a
// system `unzip`/`tar` fallback (it simply is not needed here, and a silent
// shell-out would be exactly the kind of non-portable, unannounced fallback
// the brief warns against).
// ---------------------------------------------------------------------------

function downloadBuffer(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolveDownload, rejectDownload) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain the redirect response body; nothing useful is in it
        if (redirectsLeft <= 0) {
          rejectDownload(new Error(`troppi redirect scaricando ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        downloadBuffer(nextUrl, redirectsLeft - 1).then(resolveDownload, rejectDownload);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectDownload(new Error(`risposta HTTP ${res.statusCode} scaricando ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveDownload(Buffer.concat(chunks)));
      res.on('error', rejectDownload);
    }).on('error', rejectDownload);
  });
}

/**
 * Reads the first local file entry out of a zip archive without any unzip
 * library. A zip local file header is a fixed 30-byte structure (PKWARE
 * APPNOTE.TXT sez.4.3.7): signature, version, flags, compression method, mtime,
 * crc32, compressed/uncompressed sizes, then variable-length name and extra
 * fields, then the entry's raw data - which is all this function reads.
 * Tranco's archive holds exactly one entry (top-1m.csv) with a known size up
 * front (flags bit 3 is not set, so the sizes in the header are trustworthy
 * rather than deferred to a trailing data descriptor), so nothing beyond the
 * first header is ever needed. Every assumption this makes - signature,
 * compression method, that the recorded size matches what actually came out
 * - is checked explicitly and throws loudly if it does not hold, rather than
 * ever returning something empty or partial that could be mistaken for real
 * data (requirement: never fabricate a coverage list from a failed download).
 */
function extractFirstZipEntry(zipBuffer) {
  const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
  if (zipBuffer.length < 30 || zipBuffer.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('firma del local file header zip non trovata: Tranco potrebbe aver cambiato formato di distribuzione');
  }
  const method = zipBuffer.readUInt16LE(8);
  const compressedSize = zipBuffer.readUInt32LE(18);
  const uncompressedSize = zipBuffer.readUInt32LE(22);
  const nameLength = zipBuffer.readUInt16LE(26);
  const extraLength = zipBuffer.readUInt16LE(28);
  const nameOffset = 30;
  const name = zipBuffer.toString('utf8', nameOffset, nameOffset + nameLength);
  const dataOffset = nameOffset + nameLength + extraLength;
  const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

  let data;
  if (method === 8) {
    data = inflateRawSync(compressedData);
  } else if (method === 0) {
    data = compressedData;
  } else {
    throw new Error(`metodo di compressione zip ${method} non supportato (atteso 0=stored o 8=deflate): Tranco potrebbe aver cambiato formato`);
  }
  if (data.length !== uncompressedSize) {
    throw new Error(`dimensione decompressa inattesa per "${name}": attesi ${uncompressedSize} byte, ottenuti ${data.length}`);
  }
  return data;
}

function parseTrancoCsv(buffer) {
  const text = buffer.toString('utf8');
  const domains = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex === -1) continue;
    const domain = trimmed.slice(commaIndex + 1).trim().toLowerCase();
    if (domain) domains.push(domain);
  }
  return domains;
}

async function main() {
  const existingRaw = readFileSync(SITES_PATH, 'utf8');
  const existingSites = JSON.parse(existingRaw);
  if (!Array.isArray(existingSites) || existingSites.length === 0) {
    console.error(`! ${SITES_PATH} non e' un elenco valido di siti; non posso ripartire da esso.`);
    process.exit(1);
  }

  // Strictly greater than, not "at least": at exactly existingSites.length,
  // `needed` would be 0 and there would be nothing to append after the 393
  // carried-over entries, which needs its own honest message rather than
  // silently producing a file that is just a copy of what is already there
  // (or, if the empty-append case were mishandled, a trailing comma before
  // "]" that only JSON.parse's own SyntaxError further down would catch).
  if (LIMIT <= existingSites.length) {
    console.error(`! --limit ${LIMIT} deve essere maggiore dei ${existingSites.length} siti gia' presenti in verify-sites.json: non c'e' nulla da aggiungere altrimenti.`);
    process.exit(1);
  }
  const needed = LIMIT - existingSites.length;

  const domainSeen = new Set();
  const slugSeen = new Set();
  for (const site of existingSites) {
    domainSeen.add(normalizeDomain(new URL(site.url).hostname));
    slugSeen.add(site.slug);
  }

  console.log(`Base: ${existingSites.length} siti gia' verificati (verify-sites.json), servono ${needed} siti nuovi per arrivare a ${LIMIT}.`);
  console.log(`Scarico la lista Tranco da ${TRANCO_URL} ...`);

  let zipBuffer;
  try {
    zipBuffer = await downloadBuffer(TRANCO_URL);
  } catch (error) {
    console.error(`! download di Tranco fallito: ${error.message}`);
    console.error('Nessun file e\' stato scritto: non genero una lista parziale o inventata.');
    process.exit(1);
  }

  let csvBuffer;
  try {
    csvBuffer = extractFirstZipEntry(zipBuffer);
  } catch (error) {
    console.error(`! estrazione dello zip Tranco fallita: ${error.message}`);
    console.error('Nessun file e\' stato scritto: non genero una lista parziale o inventata.');
    process.exit(1);
  }

  const rows = parseTrancoCsv(csvBuffer);
  if (rows.length < 1000) {
    console.error(`! il csv Tranco decompresso contiene solo ${rows.length} righe: sembra troncato o malformato, mi fermo senza scrivere nulla.`);
    process.exit(1);
  }
  console.log(`Lista Tranco decompressa: ${rows.length} domini.`);

  const added = [];
  const rejected = {
    duplicato: 0,
    'cdn/infrastruttura': 0,
    'tracker/ad-tech': 0,
    'contenuto per adulti': 0,
    'non-navigabile': 0,
    'servizio solo api': 0,
  };

  for (const rawDomain of rows) {
    if (added.length >= needed) break;
    const domain = normalizeDomain(rawDomain);
    if (!domain) continue;
    if (domainSeen.has(domain)) {
      rejected.duplicato += 1;
      continue;
    }
    const reason = isExcluded(domain);
    if (reason) {
      rejected[reason] += 1;
      continue;
    }
    domainSeen.add(domain);
    const slug = slugFor(domain, slugSeen);
    added.push({ slug, url: `https://${domain}`, expect: null, country: countryFor(domain) });
  }

  if (added.length < needed) {
    console.error(`! esauriti i ${rows.length} domini Tranco prima di raggiungere il limite: servivano ${needed} siti nuovi, ne sono stati trovati solo ${added.length} validi.`);
    console.error('Nessun file e\' stato scritto: non genero una lista piu\' corta spacciandola per completa.');
    process.exit(1);
  }

  // The 393 existing entries are carried over as the exact bytes already on
  // disk - stripping only the trailing "]" (and any whitespace around it) -
  // rather than being re-serialised from the parsed JS objects above. That is
  // what guarantees their `expect` values and the file's own formatting
  // (including the blank lines used as group separators) survive completely
  // unchanged, instead of merely trusting JSON.stringify to reproduce them.
  const body = existingRaw.replace(/\s*\]\s*$/, '');
  const newLines = added.map((site) => ` ${JSON.stringify(site)}`);
  const output = `${body},\n${newLines.join(',\n')}\n]\n`;

  // Parsed back before writing anything: if the splicing above produced
  // something that is not valid JSON, or the wrong number of entries, that is
  // a bug in this script, not a result worth writing to disk as if it were fine.
  const parsedOutput = JSON.parse(output);
  if (parsedOutput.length !== LIMIT) {
    throw new Error(`bug interno: attesi ${LIMIT} siti nel file finale, ottenuti ${parsedOutput.length}`);
  }

  writeFileSync(outPath, output);

  console.log(`\n${added.length} siti nuovi aggiunti da Tranco, ${existingSites.length} riportati invariati -> ${parsedOutput.length} totali.`);
  console.log('scartati dai domini Tranco:');
  for (const [reason, count] of Object.entries(rejected)) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
  console.log(`\nscritto: ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
