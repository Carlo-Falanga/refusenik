# Note sulle regole — fonti, confidenza, verifiche mancanti

Legenda confidenza: **ALTA** (selettori confermati da codice sorgente o ispezione DOM live, struttura
semplice) · **MEDIA** (selettori confermati da una fonte ma con euristiche fragili o mapping imperfetto
sullo schema) · **BASSA** (fonte debole o non verificata in questa sessione).

## Ambiguità di schema riscontrata (leggere prima di tutto)

`docs/ARCHITETTURA.md` (righe 70–83) descrive lo Step come una tabella di azioni con parametri
(`selector`, `timeoutMs`, `optional`, `checked`, `all`, `ifExists`), ma **non mostra mai un esempio JSON
letterale di un oggetto Step** — non è chiaro con quale nome di campo lo step dichiari QUALE delle 4
azioni sta eseguendo. Ho assunto un campo `"type"` (es. `"type": "waitFor"`) perché è il pattern più
naturale, ma è un'assunzione non verificata contro il contratto. Chi implementa `src/engine/` deve
confermare o correggere questo nome di campo — se è diverso, tutti gli step in `rules.json` vanno
ribattezzati con un find/replace, la struttura resta valida.

## Discrepanza tra ARCHITETTURA.md e realtà osservata

La riga 56 del documento afferma: *"OneTrust e Cookiebot usano shadow root, i CMP conformi a TCF usano
iframe"*. Questa premessa **non è confermata dai fatti raccolti**:

- **OneTrust**: DOM normale (light DOM), confermato sia dal codice sorgente Consent-O-Matic (selettori
  CSS diretti, nessun riferimento a shadow root) sia da fonti secondarie (filtri cosmetici uBlock Origin
  che colpiscono `.onetrust-banner-sdk` direttamente, cosa impossibile se fosse in shadow DOM chiuso).
- **Cookiebot**: DOM normale, stessa evidenza (selettori diretti `#CybotCookiebotDialog...`), confermato
  anche da documentazione ufficiale Didomi/community che non menziona incapsulamento.
- **CMP conformi a IAB TCF**: **non esiste uno standard di rendering**. La spec TCF standardizza solo
  l'API JS (`__tcfapi`), non il markup del banner. Quantcast Choice stesso usa un `div` normale
  (`.qc-cmp-ui-container`) con un iframe nascosto `__cmpLocator` usato solo per messaging cross-window,
  non per la UI. Altri vendor TCF (es. Sourcepoint) potrebbero usare iframe per la UI, ma questo non è
  stato verificato in questa sessione — vale per QUEL vendor, non per "TCF" in generale.
- **Chi usa davvero shadow DOM**: **DataGrail**, non menzionato nella riga 56. Verificato dal vivo:
  `aside.dg-consent-banner` ha uno `shadowRoot` reale non nullo.

Ho scritto le regole secondo la realtà osservata, non secondo la premessa del documento. Se l'motore in
`src/engine/` è stato progettato assumendo la riga 56 come vera (es. traversata shadow DOM forzata su
OneTrust/Cookiebot), va segnalato: applicare `shadowPath` dove non esiste uno shadow root reale
farebbe fallire silenziosamente il selettore.

## Per-CMP

### OneTrust — confidenza ALTA
Fonte: codice sorgente Consent-O-Matic (MIT, `rules/onetrust*.json`) + `#onetrust-reject-all-handler`
è un ID ampiamente documentato pubblicamente (usato in innumerevoli guide di compliance GDPR).
Struttura: light DOM, nessun shadow/iframe. Flusso a due livelli: pulsante diretto "Reject All" se il
sito lo espone nel primo layer, altrimenti fallback su Preference Center (apri → deseleziona categorie
→ salva). Il toggle "Strictly Necessary" nel DOM reale è normalmente disabilitato/non interattivo, quindi
"deseleziona tutto" non dovrebbe romperlo — non verificato su un sito live in questa sessione.
**Da verificare**: comportamento reale su un sito live (non ho navigato un sito OneTrust vero con
Playwright, solo dedotto dal codice sorgente + documentazione pubblica).

### TrustArc — confidenza MEDIA, copertura PARZIALE
Due varianti reali esistono, ne consegno solo una:
- `trustarc_legacy_iframe` (consegnata): banner in bottom-bar + pannello "Preference Manager" dentro un
  iframe con `title="TrustArc Preference Manager"`. Fonte: Consent-O-Matic (MIT). I toggle di categoria
  nel widget reale **non sono checkbox nativi** ma elementi `span.switch[role='option']` con stato
  on/off gestito via classi — lo step `setCheckbox` è stato applicato per mancanza di un'azione più
  adatta nello schema, ma **non è verificato che l'azione `setCheckbox` dell'engine sappia gestire
  elementi non-`<input type=checkbox>`**. Segnalare a chi implementa l'engine.
- **TrustArc nuovo (iframe-free, dal 1 luglio 2026)**: TrustArc ha migrato la UI a DOM diretto
  (`div#consent-banner`, fonte: note di rilascio TrustArc Help Center, confermate da due ricerche
  indipendenti ma con fetch diretto fallito con HTTP 403 — fonte a media affidabilità). **Non consegnata**:
  non ho selettori verificati per i pulsanti (reject/save) di questa nuova versione. Un sito TrustArc
  aggiornato dopo luglio 2026 non verrà gestito correttamente dalla regola `trustarc_legacy_iframe`.
  Serve ispezione diretta di un sito TrustArc reale aggiornato prima di aggiungere questa variante.

### Cookiebot — confidenza ALTA
Fonte: codice sorgente Consent-O-Matic (MIT, `rules/cookiebot.json`). Light DOM confermato. Pulsante
diretto `#CybotCookiebotDialogBodyButtonDecline` presente nella maggior parte dei deployment EU
(obbligo normativo di rifiuto in un click). Fallback via checkbox di categoria (`...LevelButtonPreferences`,
`...LevelButtonStatistics`, `...LevelButtonMarketing`) + `hide` finale come da architettura ("ultima
risorsa, solo dopo rifiuto registrato").
**Da verificare**: selettore per il link "Mostra dettagli" quando il pulsante Decline non è nel primo
layer — non trovato con fonte affidabile, omesso invece di inventarlo.

### Didomi — confidenza MEDIA
Fonte: codice sorgente Consent-O-Matic (MIT, `rules/didomi.io.json`) + documentazione ufficiale Didomi
("tutti i nostri elementi vivono in quel div padre", conferma light DOM).

**Modifica post-review**: la bozza iniziale includeva un primo step che cliccava
`.didomi-popup-notice-buttons .didomi-button:not(.didomi-button-highlight)` come tentativo di "rifiuto
rapido". L'ho rimosso: nella fonte questo selettore è elencato genericamente come "Options" insieme al
pulsante "learn more", non come azione di rifiuto dedicata — non ho un testo del pulsante confermato che
mi permetta di distinguere "Rifiuta" da "Scopri di più" con un `textMatch` verificato, e aggiungere un
`textMatch` indovinato per giustificarlo violerebbe la stessa regola di onestà che vale per i selettori
CSS. Il flusso consegnato usa solo il percorso deterministico: apri pannello dettagliato → seleziona il
radio "Disagree" → salva.

Punto fragile residuo: il radio "Disagree" nel pannello dettagliato è selezionato per **posizione**
(`nth-child(2)`), non per ID — fragile se Didomi cambia l'ordine dei radio, e non protetto da `textMatch`
per lo stesso motivo (nessun testo del radio confermato in questa sessione).
**Da verificare**: su un sito Didomi reale, il testo effettivo dei due radio (per poter aggiungere
`textMatch` in modo fondato) e se il loro ordine è costante.

### Usercentrics — confidenza MEDIA, copertura PARZIALE
Fonte: codice sorgente Consent-O-Matic (MIT, `rules/usercentrics.json`), che riflette la vecchia UI
light-DOM (`.uc-banner-wrapper`). Lo step di deselezione categoria **non usa** le classi hashate
per-tenant trovate nella fonte originale (es. `.toggle-category-customCategory-<uuid>`, inutilizzabili
come regola generica); ho generalizzato a "tutti i checkbox non disabilitati dentro `.uc-inner-content`"
— questa generalizzazione **non è verificata su un sito live**, è la mia migliore approssimazione dato
lo schema disponibile.
**Copertura mancante**: esiste una versione più recente di Usercentrics (CMP v3, custom element
`<usercentrics-root>`) che potrebbe usare shadow DOM — non confermato con fonte affidabile in questa
sessione, e la regola consegnata **non la rileva** (il `detect` è scoped alla sola UI v2 light-DOM per
non generare falsa sicurezza). Serve ricerca/ispezione dedicata.

### Quantcast Choice (TCF) — confidenza MEDIA/MEDIA-ALTA
Due varianti reali, entrambe consegnate:
- `quantcast`: UI classica `qc-cmp-*`. Fonte Consent-O-Matic (MIT). Stesso problema di TrustArc/
  Usercentrics: i toggle vendor/purpose sono `div.qc-cmp-toggle`, non checkbox nativi — `setCheckbox`
  applicato per mancanza di alternativa nello schema, non verificato che funzioni su elementi non-input.
- `quantcast_v2`: UI più recente basata su attributi `data-tracking-opt-in-*`. Fonte Consent-O-Matic
  (MIT). Attributi molto distintivi → basso rischio di falsi positivi, ma i checkbox in questo caso
  sono dichiarati come `input[type=checkbox]` reali nella fonte, quindi più affidabile del ramo classico.
**Nota di prodotto**: "Quantcast (TCF)" nel task copre solo il vendor Quantcast Choice. Non copre altri
vendor TCF (Sourcepoint, ecc.) che potrebbero apparire su siti diversi con markup completamente diverso
— fuori scope per queste 9 regole per costruzione del task, ma va tenuto presente lato prodotto.

### Osano — confidenza MEDIA-ALTA
Fonte incrociata: codice sorgente Consent-O-Matic (MIT, `rules/osano.json`, per i toggle di categoria
`#osano-cm-drawer-toggle--category_*` / `#osano-cm-dialog-toggle--category_*`) + ricerca web indipendente
per il pulsante diretto (classi `.osano-cm-button--type_deny` / `.osano-cm-button--type_denyAll`, fonte:
snippet di ricerca su documentazione Osano, fetch diretto della pagina fallito con 404 — fonte più debole
di quella C-O-M). Ho incluso solo le due classi effettivamente riportate da una fonte, senza aggiungere
varianti plausibili non confermate.
**Da verificare**: se le classi `denyAll`/`deny` esistono davvero nel markup attuale (fonte debole).

### BigID Cookie Consent — confidenza ALTA (singolo sito verificato)
Fonte: **ispezione DOM live** (Playwright) su `https://bigid.com`, deployment del vendor stesso. Banner
in iframe same-origin `#bigidcmp-banner-widget` (popolato via `document.write`, quindi non cross-origin
in senso stretto — ma verificare che il content script dell'estensione venga iniettato anche nei frame
figli, `all_frames` in Manifest V3, è responsabilità di `src/engine/`/manifest, fuori scope qui).
Pulsante diretto `#cmp-reject-all` — ID stabile, non hashato. Script caricato da un host centralizzato
(`bigidcmp.cloud/banner.js`), quindi è ragionevole (ma non certo) che l'ID sia costante su tutti i
tenant BigID, non solo su bigid.com. **Verificato su un solo sito**, non su un cliente terzo.

### DataGrail Consent — confidenza ALTA (singolo sito verificato)
Fonte: **ispezione DOM live** (Playwright) su `https://www.bedbathandbeyond.com`, cliente DataGrail
confermato. Vero shadow DOM (`aside.dg-consent-banner.shadowRoot`). Pulsante diretto
`button.dg-button.reject_all` (testo osservato: "Accept Essentials Only", che è semanticamente il
rifiuto/necessari-soli). Script caricato da host centralizzato (`api.consentjs.datagrail.io`), stessa
considerazione di BigID sulla probabile costanza delle classi tra tenant. **Verificato su un solo sito**.

## labels.json — fonte e confidenza

Le traduzioni IT/DE/FR/ES sono **traduzioni linguistiche standard** dei 4 concetti richiesti, non
scraping sistematico di ogni CMP in ogni lingua (fuori scope per il tempo disponibile). Due eccezioni
con conferma diretta da ispezione live in questa sessione:
- BigID su bigid.com, in italiano: pulsanti osservati "Rifiuta" / "Accetta tutti", e
  `#cmp-custom-permissions` con testo "Preferenze cookie" (confermano le voci `rejectAll.it` e
  `manageSettings.it`).
- DataGrail su bedbathandbeyond.com, in inglese: "Accept Essentials Only" / "Save My Choices" /
  "Accept All" (confermano `necessaryOnly.en` e `savePreferences.en`).
Tutte le altre voci vanno trattate come MEDIA confidenza: corrette linguisticamente, non verificate
contro un'istanza CMP live specifica.

## Gap di schema: `textMatch` non è utilizzabile per verifiche multilingua

`labels.json` elenca più varianti per lingua per ciascun concetto (es. `rejectAll.it` ha sia "Rifiuta
tutto" sia "Rifiuta"), ma `Selector.textMatch` accetta **una sola stringa**. Non c'è modo, nello schema
attuale, di dire "verifica il testo contro una di queste N varianti" dentro un singolo Selector — l'unica
alternativa sarebbe duplicare l'intero oggetto Step una volta per variante di lingua/sinonimo (esplode la
combinatoria: 4 concetti x 5 lingue x più sinonimi ciascuno), oppure l'engine dovrebbe fare da sé il
fan-out su un array esterno a `labels.json`. Per questo motivo `labels.json` **non è referenziato da
nessun `textMatch` in rules.json** in questa consegna: usarlo per i selettori più fragili (es. il radio
Didomi sopra) avrebbe richiesto o indovinare un'unica stringa (violando la regola di onestà) o esplodere
il flow in decine di step quasi-duplicati (violando l'idea di "set chiuso di azioni" semplice). Segnalo
questo come lacuna reale dello schema, da risolvere probabilmente permettendo `textMatch` come
`string | string[]` in una prossima release, non da aggirare qui.

## `textMatch` come `string | string[]` e `textMatchRef` — mechanism aggiunto, non ancora applicato

Lo schema ora supporta `Selector.textMatch: string | string[]` (corrisponde se una qualsiasi variante
corrisponde) e, solo in `rules.json` come autore, `textMatchRef: "<chiave di labels.json>"`, risolto in un
array letterale da `build.mjs` tramite `src/rules/expandTextMatchRefs.js` prima di impacchettare
`dist/rules/ruleset.json`. L'engine (`src/engine/selector.js`) non risolve mai un `textMatchRef`: se ne
sopravvive uno a runtime, il selettore fallisce chiuso (nessuna corrispondenza), non tenta di indovinarne
il significato. `src/engine/ruleset.js` rifiuta inoltre l'intero ruleset (non solo il singolo selettore) se
un `textMatchRef` non risolto è presente in un candidato ruleset — difesa aggiuntiva, coerente con "in caso
di qualsiasi errore, resta sull'ultimo ruleset valido".

**Nessuna delle 9 regole CMP consegnate usa oggi `textMatchRef`.** Ho ispezionato ogni selettore CSS in uso
e nessuno dipende oggi da un'etichetta testuale in inglese: tutti usano ID o classi specifiche del CMP
(`#onetrust-reject-all-handler`, `.osano-cm-button--type_denyAll`, `button.dg-button.reject_all`, ecc.),
verificate per fonte o ispezione live (vedi sopra). Applicare `textMatchRef` a uno di questi selettori già
univoci non aggiungerebbe copertura multilingua: la aggiungerebbe come restrizione ULTERIORE, e per le
lingue non coperte da `labels.json` (o non confermate per quel CMP specifico, es. BigID è confermato solo
in italiano) romperebbe un selettore che oggi funziona in qualunque lingua — una regressione, non un
miglioramento.

L'unico selettore realmente generico/ambiguo nell'intero ruleset è TrustArc `.pdynamicbutton .shp`
(`trustarc_legacy_iframe`, step 2-3): più bottoni nel pannello "Preference Manager" potrebbero condividere
questa classe, e oggi il flusso clicca semplicemente il primo match, senza alcuna garanzia che sia quello
giusto — esattamente il caso a cui `textMatchRef` serve. Non ho però un testo confermato per questo
elemento in questa sessione (nessuna ispezione DOM live disponibile, e dedurlo dal titolo dell'iframe
"TrustArc Preference Manager" sarebbe un salto non verificato, lo stesso tipo di assunzione che la
richiesta di questo step vieta esplicitamente). Non l'ho aggiunto. Se in futuro si ottiene un'ispezione
live del widget TrustArc reale, questo è il candidato naturale per il primo uso reale di `textMatchRef`.

## `setAriaToggle` — azione aggiunta, non ancora applicata a TrustArc/Quantcast classico

Il punto 3 di questa lista è stato risolto lato motore: `src/engine/steps.js` implementa ora
`setAriaToggle` (`selector`, `checked`, `all`), documentata in `docs/ARCHITETTURA.md`. Legge
`aria-checked`/`aria-pressed`, clicca solo se lo stato letto differisce da quello desiderato, rilegge
per verificare l'esito, e fallisce chiuso (nessun click) se lo stato non è `"true"`/`"false"` — incluso
il tri-stato `"mixed"` o l'attributo assente. Copertura test in `test/steps.test.js`.

**Le regole `trustarc_legacy_iframe` e `quantcast` in `rules.json` NON sono state riscritte** per usare
questa azione, deliberatamente. Continuano a usare `setCheckbox` su `.switch[role='option']` e
`.qc-cmp-toggle`, che restano probabilmente sbagliati per lo stesso motivo già segnalato sopra (non sono
`<input>`, quindi `'checked' in el` è falso e `setCheckbox` salta silenziosamente quei target). In questa
sessione non ho avuto accesso a uno strumento di ispezione DOM dal vivo (nessun Playwright disponibile):
non ho potuto confermare se questi elementi espongano davvero `aria-checked`/`aria-pressed`, con quale
valore a riposo, e se il click li porti effettivamente allo stato atteso. Riscrivere quelle due regole ora
significherebbe cablare `setAriaToggle` su una struttura DOM immaginata — lo stesso errore, per un'altra
via, di scrivere un `textMatch` indovinato o una `shadowPath` non verificata. Consegno quindi il
meccanismo con i suoi test, e lascio le due regole com'erano.

**Prossimo passo per chiudere questo punto**: ispezione dal vivo (Playwright o browser reale) di
`.switch[role='option']` dentro l'iframe TrustArc Preference Manager e di `.qc-cmp-toggle` nella UI
`qc-cmp-*` di Quantcast Choice classico — verificare l'attributo di stato esposto, il valore a riposo, e
il comportamento post-click — prima di sostituire `setCheckbox` con `setAriaToggle` in quelle due regole.

## Cosa manca per dichiarare la v1 completa

1. Conferma del nome del campo discriminatore di Step (`type` è un'assunzione, vedi sopra) — **risolto**:
   il campo è `action`, confermato dal contratto in `test/rules-integration.test.js`.
2. Selettori per la nuova UI TrustArc iframe-free (post luglio 2026).
3. ~~Verifica se `setCheckbox` nell'engine gestisce anche toggle non-`<input>`~~ — **risolto**: aggiunta
   l'azione `setAriaToggle` (vedi sezione sopra). Resta aperta l'applicazione alle regole TrustArc/
   Quantcast classico, in attesa di ispezione dal vivo.
4. Verifica in ambiente reale (non solo sorgente) di OneTrust, Didomi, Usercentrics, Osano — solo
   BigID e DataGrail sono stati confermati su un sito live in questa sessione.
5. Copertura Usercentrics v3 (shadow DOM, `<usercentrics-root>`) — non indagata.

## setAriaToggle: what the live inspection must check (step 2.1)

`setAriaToggle` reads state from `aria-checked`, falling back to `aria-pressed`.
Two current rules still use `setCheckbox` on elements that are almost certainly
not `<input>`, and were deliberately left alone until their DOM is confirmed:

- `trustarc_legacy_iframe` — `.switch[role='option']`. Note the role: per ARIA,
  `role="option"` carries its state in **`aria-selected`**, not `aria-checked`.
  If that holds, `setAriaToggle` would fail with `aria-state-missing` — safe, as
  it refuses to click rather than risk inverting consent, but non-functional.
  Confirm which attribute the widget actually exposes before rewiring; the
  engine may need `aria-selected` added to the read order.
- `quantcast` — `.qc-cmp-toggle`. Attribute unknown; check the same way.

Do not add attribute support speculatively. Confirm on the live widget first:
a rule written against an imagined structure is worse than one left as it is.

## Consent-or-pay walls: recognise and say so, never act

Live checks on European news sites turned up something that is not a rule bug.
corriere.it, repubblica.it, lemonde.fr and spiegel.de (and elpais.com, same
pattern) no longer offer a refusal at all. The choice is "Accept and continue"
or "Subscribe": consent to tracking, or pay.

There is nothing for this extension to refuse on those pages. Clicking the only
available button would consent to tracking - the exact opposite of the product's
purpose - so doing nothing is correct behaviour, not a gap to close.

This is now a first-class engine concept rather than just a policy note: a CMP
entry may carry `"kind": "consentOrPay"` (`src/engine/messages.js`'s `CMP_KIND`,
gated by `isActionableKind()` in `src/engine/detect.js`). Such an entry exists
purely to be *recognised* - its `flow` is never executed, and the popup shows a
dedicated state that explains there is nothing to refuse, with no report button
(reporting an unsolvable case would only pollute the one channel meant for
cases that can actually be fixed).

Two entries are shipped on this basis, both with markers verified live:

- `corriere_consent_or_pay` - `.privacy-cp-wall` (**class, not id** - the
  brief for this rule assumed `#privacy-cp-wall`; live inspection via
  `tools/verify-rules.mjs --site corriere.it` showed the container only ever
  carries `privacy-cp-wall` as one of several classes, alongside an
  unrelated stylesheet element whose id happens to be `_privacy-cp-wall-css`.
  Corrected before shipping rather than guessed) together with
  `#privacy-cp-wall-reject-and-subscribe` (id, confirmed present).
- `repubblica_consent_or_pay` - `#iubenda-cs-banner` **together with**
  `#iub_cmp_subscribe_custom_btn`. Repubblica also runs the generic Iubenda
  widget (see the Iubenda section below), so this entry's `priority` (20) is
  set strictly above generic Iubenda's (10): both entries' `detect` match on
  repubblica.it, and without the higher priority the generic Iubenda entry
  would win the tie and the engine would attempt a refusal flow that does not
  exist on that page. Covered by an explicit precedence test in
  `test/rules-integration.test.js`.

**Not shipped, deliberately**: lemonde.fr and spiegel.de are the same pattern
by observation, but their actual DOM markers were never inspected live in any
session to date - writing a `detect` for them now would mean guessing at
selectors, which this project's own rules explicitly reject elsewhere. Add
them only after a live inspection confirms their markup.

Other consequences worth carrying forward:

1. Do NOT write a `"refuse"`-kind rule for a consent-or-pay wall. Any rule that
   "handles" one by clicking its only button is either useless or actively
   harmful.
2. The market sizing behind "nine CMPs cover 95%" came from a consent-management
   *software market* report, not from a survey of what actually renders banners
   on the open web. It omits Sourcepoint entirely, which spiegel.de uses
   (`sp_message_container_*`, `sp_message_iframe_*`) and which is common among
   European publishers. News and media sites are largely not the addressable
   market; ordinary corporate, e-commerce and service sites - where OneTrust,
   Cookiebot and Didomi dominate and a reject button still exists - are.

Sourcepoint is worth a rule only where it renders a genuine reject option.
Confirm that on a live site before writing one.

## Iubenda - confidence ALTA (three sites verified live)

Widespread on Italian sites and entirely absent from the original nine-CMP
plan (see the sweep below). Structure verified live on three sites:

- Container (`detect`): `#iubenda-cs-banner`.
- Direct reject: `.iubenda-cs-reject-btn`, text "Continua senza accettare" -
  confirmed on `ilpost.it` and `giallozafferano.it`.
- Accept: `.iubenda-cs-accept-btn` - never clicked by this rule.
- Options: `.iubenda-cs-customize-btn` - not used by the shipped flow (no
  path requires opening the preference panel; the direct reject or the
  close-button fallback below cover every site inspected).

**Variant confirmed on `alfemminile.com`**: `.iubenda-cs-reject-btn` does not
exist there at all. The only rejection path is `.iubenda-cs-close-btn` - but
that same class is, on other Iubenda deployments, an ordinary dismiss "X" that
closes the banner without registering any refusal. Clicking it unconditionally
would silently leave the user tracked while the popup claims "refused".

The flow therefore never clicks `.iubenda-cs-close-btn` unconditionally: it is
gated by `textMatchRef: "necessaryOnly"` (`labels.json`'s `necessaryOnly`
concept already contains the Italian variant "Continua senza accettare" used
by alfemminile.com). On a site where the close button does not carry that
text, the selector simply fails to match - the button is left alone. Covered
by an explicit test in `test/rules-integration.test.js` asserting the close
button is clicked only when it carries the exempted `necessaryOnly` wording,
never otherwise.

## What a 45-site sweep of real European sites actually found

Coverage is now driven by observed frequency rather than by a vendor list.
Results (`node tools/verify-rules.mjs`, Italian locale, clean profile):

| CMP | Sites | Note |
|---|---|---|
| OneTrust | 9 | accenture, booking, otto.de, lidl.de, renfe, ikea, atlassian, cloudflare |
| Didomi | 4 | subito.it, orange.fr, elpais.com |
| TrustArc | 2 | poste.it |
| Cookiebot | 1 | its own site only |
| Osano | 1 | its own site only |
| BigID | 1 | its own site only |

OneTrust and Didomi are what matter: 13 of 18 confirmed hits. Cookiebot, Osano
and BigID did not appear on a single site other than their vendor's own in a
45-site sample - they cost nothing now that they exist, but they were never
worth prioritising, and the original nine-CMP list badly mis-ranked them.

Uncovered banners, by fingerprint:

- **Iubenda** (`iubenda-cs-*`, `iub_cmp_*`) - repubblica.it. Widespread on
  Italian sites and entirely absent from the original plan. **Now covered**:
  see the Iubenda section above.
- **Tealium** (`__tealiumGDPRecModal`, `consentAcceptAll`) - telekom.de. Still
  not covered - no live inspection of its reject path yet.
- **Consent-or-pay walls** - corriere.it (`privacy-cp-wall-reject-and-subscribe`),
  repubblica.it. **Now recognised, never acted on**: see the "Consent-or-pay
  walls" section above (`kind: "consentOrPay"`). lemonde.fr and spiegel.de are
  the same pattern but remain unverified and therefore unshipped.
- **In-house implementations** - mediaworld.it (`pwa-consent-layer-*`),
  ryanair.com (`cookie-popup-with-overlay`). One-off markup, no platform behind
  it. This is the per-site long tail EasyList drowned in; do not chase it.

Caveat on the `offersRefusal` flag in the report: it reads body text in the
frame the fingerprint ran in, and returned false for sites that probably do
offer a refusal. Treat it as a hint, not a measurement, until it is validated.

## Non-regression run (step 2.3)

`node tools/verify-rules.mjs --execute` over 48 sites, clicking for real and
measuring the page before and after.

**No site was left broken by the measures that matter.** Across every site
where the extension acted: no scroll lock, no residual blocking overlay, no
loss of text content, no loss of navigation. The failure that earned the
incumbent its 3.11 rating - banner dismissed, page left frozen - did not occur
once.

Five sites logged a JavaScript error during the window. Four are not ours:

- onetrust.com, ikea.com - `TurnstileError 600010`, Cloudflare bot detection
  failing against a headless browser.
- alfemminile.com - `Video Expired`, from a media player.
- corriere.it - a null `classList`, on a consent-or-pay page where the
  extension deliberately does nothing at all. That one is a useful control: it
  proves these logs include the site's own errors.

The fifth is ours, and confirmed by experiment. On osano.com, loading the page
without refusing produces no errors; performing the refusal produces
`TypeError: Cannot read properties of undefined (reading 'ANALYTICS')`. Osano's
own script throws while processing our interaction.

Impact is low but real: the page stays usable, and Osano appeared on exactly
one of 48 sites - its own. Worth fixing before wide release, not before the
next step. The likely cause is acting on their category toggles before their
UI has finished initialising; try waiting on a settled state first.

## Quantcast Choice, Sourcepoint, Complianz, CookieYes, Commanders Act, Sirdata,
## Usercentrics - repaired/added from live DOM inspection (this session)

All selectors below were confirmed via Playwright against the live sites named,
not guessed and not carried over from a secondary source. `quantcast` and
`usercentrics` fully replace their previous entries (see `ATTRIBUTIONS.md` for
the licensing consequence of that).

### Quantcast Choice CMP2 - confidence ALTA (6 sites live)

The two previous entries (`quantcast` on `.qc-cmp-ui-container`,
`quantcast_v2` on `[data-tracking-opt-in-overlay]`) matched nothing on any
site checked in this session - the generation they targeted has been
superseded. What renders today, confirmed on `ilgiornale.it`,
`liberoquotidiano.it`, `open.online`, `index.hu`, `quantcast.com` and
`mirror.co.uk`, is Quantcast Choice CMP2 (`cmp.inmobi.com`, containers
`.qc-cmp2-container`/`.qc-cmp2-main`).

Two layers exist and both are handled:
- A first layer that on some deployments (ilgiornale.it, liberoquotidiano.it)
  already exposes a direct decline button, `#disagree-btn` ("NON ACCETTO"/
  "Rifiuta"). Clicking it alone fully dismisses the banner.
- On deployments without that direct button (open.online, index.hu,
  quantcast.com), the first layer only offers `#more-options-btn` ("PIÙ
  OPZIONI"/"More Options"). Opening it reveals a second layer with a
  single-click `#reject-all-btn` ("RIFIUTA TUTTO"/"REJECT ALL"/"ÖSSZES
  ELUTASÍTÁSA" - the ids are stable across languages, only the button text
  is localised) and `#save-and-exit`. No per-category toggling is needed:
  Quantcast's own "reject all" already does that server-side.

The flow tries both paths unconditionally (`#disagree-btn` first, then
`#more-options-btn` → wait for `#reject-all-btn` → click it → click
`#save-and-exit`); whichever path doesn't apply to a given deployment simply
finds nothing and no-ops, since every step is `optional: true`.

**mirror.co.uk (Reach plc) - the pay-to-reject variant, recognised separately.**
Reach's own deployment of the same CMP2 widget offers a THIRD choice not seen
elsewhere: a `.pp-pay` button ("Reject and Pay") sitting right next to
`#more-options-btn`/`#accept-btn` in the first layer, and the second layer's
"reject all" is itself relabelled "REJECT ALL AND PAY". Clicking it does not
register a free refusal - it opens a paid "Privacy Plus" upsell modal
("Continue to access our site for £1.99 per month", with only "Back to
Consent" / "Pay for Privacy Plus" / "I'm already a subscriber" as options),
confirmed by screenshot in this session. This is a consent-or-pay wall wearing
Quantcast's UI rather than a distinct CMP, so it is a separate entry,
`quantcast_consent_or_pay` (`kind: "consentOrPay"`, `flow: []`), detected on
`.qc-cmp2-container` + `.pp-pay` and given priority 20 (above generic
`quantcast`'s 10) so it wins the tie on any page where both detect blocks
happen to match.

**mirror.co.uk is also the least stable site checked in this session.**
Across repeated runs, `.pp-pay` and even `#disagree-btn`/`#more-options-btn`
were sometimes absent entirely from the first-layer DOM, and one run showed
the Quantcast banner disappear on its own (no click of ours found anything to
click) only to be replaced seconds later by an unrelated US state-privacy
notice (`CIPAConsentNotice_cipa-dialog__CZfBH` et al.) that this ruleset does
not cover. `tools/verify-rules.mjs --site mirror.co.uk --execute` flags
"overlay residuo" on that run, but `usabilityBefore.blockingOverlays` was `0`
and our flow's steps all reported `found: false` (a complete no-op) - the
second, later overlay appears on a site-driven timer independent of whether
the extension (or a human) interacts with the first banner at all. This is
Reach's own multi-jurisdiction consent sequencing, not a defect introduced by
`quantcast`/`quantcast_consent_or_pay`; it is documented here rather than
"fixed" because there is no rule that can prevent a second, later, unrelated
banner from a different vendor.

**ilgiornale.it and liberoquotidiano.it also flag "broke" on
`--execute`, for an unrelated reason, confirmed not to be ours**: dismissing
the banner (with EITHER `#disagree-btn` reject OR `#accept-btn` accept -
tested both) triggers a downstream `TypeError` from a lazy-loaded video/ad
player (`--- BridPlayer --- The element or ID supplied is not valid.` on
liberoquotidiano.it) and, on ilgiornale.it, a `SyntaxError: Unexpected end of
input` from another loaded script, sometimes leaving `body{overflow-y:hidden}`
in place. Confirmed by experiment: waiting on the page with **no** click at
all produces neither error nor lock; clicking **Accept** instead of reject
produces the same lock. Whichever consent choice a user makes causes the
page's own ad stack to reflow and (on these two sites) throw. This is the
same class of finding already recorded above for Osano's own site - the fix,
if any, belongs to the publisher's ad stack, not to this ruleset.

### Sourcepoint - confidence ALTA (BBC actionable; 4 German sites recognised, none actionable)

Important engine finding, not just a rule detail: **the `frame` selector field
does not work for a genuinely cross-origin iframe** - `resolveSelectorChain`
reaches into `iframeEl.contentDocument` from the parent frame, which a
cross-origin browser always refuses (see `selector.js`'s own comment on this).
Sourcepoint's message UI (`cdn.privacy-mgmt.com`, or a publisher's own
first-party proxy subdomain such as `sp-spiegel-de.spiegel.de`) always renders
in exactly such an iframe. A first version of this rule used `frame:
"iframe[id^='sp_message_iframe']"` as instructed and it never resolved in
`tools/verify-rules.mjs --execute` from either the top frame or from inside
the message iframe itself (confirmed live on `bbc.co.uk`: `detectDetail: []`
in both). The fix, and what is shipped: since the extension (and the verifier)
inject their script into **every** frame (`all_frames`), the message iframe
gets its own independent content-script instance whose `document` already
*is* the iframe's document - no `frame:` traversal is needed or wanted. The
shipped selectors are therefore plain `css` (`.message-container`,
`.sp_choice_type_13`, `.sp_choice_type_9`), meant to be evaluated by whichever
frame instance actually contains them. Confirmed working end-to-end via
`tools/verify-rules.mjs --site bbc.co.uk --execute` after this fix.

Sourcepoint's own choice-type class numbering turned out to be a stable,
vendor-assigned taxonomy (not a per-publisher customisation, unlike the
surrounding CSS classes, which are heavily re-skinned per publisher):
`sp_choice_type_11` = accept all, `sp_choice_type_12` = open
manage/settings, `sp_choice_type_13` = reject all, confirmed identical across
`bbc.co.uk`, `spiegel.de`, `bild.de`, `zeit.de` and `sueddeutsche.de` even
though the surrounding button classes and wording differ completely per site.

- `sourcepoint` (actionable, priority 10): detect requires `.sp_choice_type_13`
  to actually be present - by construction, if this entry matches, the
  refusal button genuinely exists to be clicked. Confirmed live on
  `bbc.co.uk` ("I do not agree"), where clicking it closes the banner with no
  scroll lock and no residual overlay (`tools/verify-rules.mjs --execute`
  reports "pagina integra").
- `sourcepoint_consent_or_pay` (`kind: "consentOrPay"`, priority 9, below the
  actionable entry so a page offering both wins toward the actionable one):
  detects `sp_choice_type_9`, the choice-type Sourcepoint's own taxonomy uses
  for a custom third option. On every German site checked - `spiegel.de`
  ("Jetzt abonnieren"), `bild.de` ("Jetzt BILD PUR abonnieren"), `zeit.de`
  ("zeit.de werbefrei abonnieren"/"zeit.de Pur abonnieren") and
  `sueddeutsche.de` ("Jetzt testen"/"Jetzt kostenlos testen") - this choice
  type is a paid-subscription CTA, and clicking "Einstellungen"/opening
  settings on every one of them revealed the SAME two-choice set
  (accept-and-continue or subscribe) with **no** `sp_choice_type_13` anywhere
  in the DOM, confirmed by an exhaustive `[class*="sp_choice_type"]` scan on
  each site. These are genuine Pur-Abo consent-or-pay walls; the rule
  recognises them and never runs a flow. `tools/verify-rules.mjs --execute`
  confirms all four as "pagina integra" (recognised, untouched).
- Not shipped: a rule for any Sourcepoint deployment that has neither
  `sp_choice_type_13` nor `sp_choice_type_9` - it would go undetected by
  design rather than guessed at.

### Complianz - confidence ALTA (`complianz.io`)

`.cmplz-cookiebanner` container, direct decline button
`.cmplz-btn.cmplz-deny` ("Deny") in the first layer on the vendor's own site.
No second layer needed. `hubspot.com` (the task's second suggested site) does
not run Complianz in this session - not shipped as a second confirmation for
that reason, but the single live confirmation is unambiguous (own vendor's
site, clean single-button flow). `tools/verify-rules.mjs --execute` reports
"pagina integra".

### CookieYes - confidence ALTA (`cookieyes.com`)

`.cky-consent-container` container, direct reject `.cky-btn.cky-btn-reject`
("Reject All") in the first layer. `tools/verify-rules.mjs --execute` reports
"pagina integra".

### Commanders Act / TagCommander - confidence ALTA (3/3 sites, contradicts the
### brief's own analysis)

The task's brief stated the automated sweep found "no direct refusal offered"
on `sparkasse.de`, `bouyguestelecom.fr` and `credit-agricole.fr`. Live
inspection in this session found the opposite on all three: a direct
decline/necessary-only button exists in the first layer of every one of
them. What is NOT stable across them is the numeric button id Commanders Act
assigns (`popin_tc_privacy_button_2` on `sparkasse.de` and
`bouyguestelecom.fr`, but `popin_tc_privacy_button_3` on
`credit-agricole.fr` - the numbering reflects each publisher's configured
button order, not a fixed semantic slot), so the flow matches by wording
instead of by id:
- `sparkasse.de`: "Zusätzliche Cookies ablehnen" - matched via
  `textMatchRef: "rejectAll"` (`labels.json`'s German `rejectAll` list
  already contains "Ablehnen", and `textMatch`'s default `contains` mode
  matches it as a substring).
- `bouyguestelecom.fr` / `credit-agricole.fr`: "Continuer sans accepter" -
  matched via `textMatchRef: "necessaryOnly"` (already listed verbatim in
  `labels.json`'s French `necessaryOnly`).

Confirmed live and clicked successfully (banner gone, no scroll lock, no
residual overlay) via `tools/verify-rules.mjs --execute` on
`bouyguestelecom.fr` and `credit-agricole.fr` ("pagina integra" both).

**`#tc-privacy-wrapper` in `detect` - confirmed live (code review, this
session).** `detect` is an AND (`src/engine/detect.js`), so an unconfirmed id
there would mean the rule never fires at all. A dedicated Playwright check
against live DOM found `#tc-privacy-wrapper` present (`querySelectorAll`
count 1, alongside `#popin_tc_privacy`/`.tc-privacy-banner`) on both
`bouyguestelecom.fr` and `credit-agricole.fr`. Left in `detect` as confirmed.
`sparkasse.de`'s banner did not render at all in this check (consistent with
the flakiness already documented above - a frequency cap/bot-defence
backoff, not evidence against the marker), so it neither confirms nor
contradicts `#tc-privacy-wrapper` there.

**`sparkasse.de` - flaky banner, and one real, unresolved caveat.** The banner
did not render on most attempts in this session (neither through direct
Playwright scripts nor through `tools/verify-rules.mjs`'s own 20s detection
poll), which looks like either a frequency cap or a bot-defence backoff after
repeated automated visits from the same IP in a short window - not something
this ruleset can control either way. On the two occasions the banner did
render, clicking "Zusätzliche Cookies ablehnen" correctly removed the banner
from the DOM, but `body{overflow-y}` stayed `hidden` afterwards in **both**
occurrences - reproduced with a bare `.click()` and again with the full
`pointerdown→mousedown→pointerup→mouseup→click` sequence `steps.js` actually
uses, ruling out "unrealistic click" as the cause. `bouyguestelecom.fr` and
`credit-agricole.fr`, tested the same way, do not show this. There is no
action in the closed set (`waitFor`/`click`/`setCheckbox`/`setAriaToggle`/
`hide`) that can reset an arbitrary `overflow` style on `<body>`; `hide` only
sets `display:none` on a selected element, and the banner wrapper itself was
already confirmed removed from the DOM (not merely hidden) when this
happened. This looks like a genuine, pre-existing bug in Sparkasse's own
cleanup script - not something introduced by this rule's selectors or
sequencing - but it could not be re-confirmed against a fresh
`tools/verify-rules.mjs --execute` run in this session due to the banner not
appearing at all in later attempts. Flagged here rather than silently shipped
as clean.

### Sirdata - confidence ALTA (2 sites), positional fallback REMOVED (review fix)

`#sd-cmp` container, buttons are true `<button>` elements but **all three**
(reject, customise, accept) share the identical CSS class (`sd-cmp-7Ga7b` on
both sites checked) - Sirdata's per-tenant build hashes classes per widget
build, not per button role, so class alone cannot distinguish them.

`detect` now carries a second marker, `#__abconsent-cmp` - confirmed live
(Playwright) as the actual parent element of `#sd-cmp` on both `sirdata.com`
and `01net.com`. Previously `sirdata.detect` had only `#sd-cmp`, the one CMP
entry in this batch with a single selector where every sibling entry had two;
this closes that gap with a marker that was actually observed, not guessed.

- French wording ("Continuer sans accepter", `01net.com`) is matched via the
  existing `textMatchRef: "necessaryOnly"`/`"rejectAll"` steps, no gap.
- English ("Do not accept", `sirdata.com`) and Italian ("Non accettare") are
  now covered: `labels.json`'s `necessaryOnly` concept has since been
  extended with "Do not accept"/"Do not consent" (en) and "Non accettare"/
  "Non acconsentire" (it), so the two semantic `textMatchRef` steps above
  cover every wording confirmed live on both sites without any fallback.

- **Positional fallback REMOVED (code review, this session).** A previous
  revision shipped a third `click` step with no `textMatch` at all,
  `{ "css": "#sd-cmp button" }`, on the reasoning that the reject button was
  consistently the *first* `<button>` in DOM order across the three samples
  checked at the time. That reasoning does not generalise: nothing about
  Sirdata's per-tenant build guarantees DOM order across tenants (the classes
  are hashed per widget build precisely because there is no stable per-role
  structure), so on a tenant where the order happened to be
  accept/customise/reject instead of reject/customise/accept, this step would
  click **Accept** while reporting a refusal - the exact failure this
  extension exists to prevent, and worse than doing nothing. Now that
  `necessaryOnly` covers the two remaining unmatched wordings observed live,
  the positional fallback no longer earns its risk: it is deleted rather than
  kept "just in case". The flow is now the two semantic `textMatchRef` steps
  only. On a Sirdata deployment whose button wording matches neither
  `rejectAll` nor `necessaryOnly` in `labels.json`, the correct behaviour -
  per this project's own design principle ("acting on a page we do not
  understand is worse than leaving a banner up") - is to do nothing, not to
  guess by position. See `test/rules-integration.test.js` for the adversarial
  regression test (first `<button>` under `#sd-cmp` is an accept button,
  reject buttons come after - the flow must never click the first one).

### Usercentrics - confidence ALTA (3 sites), previous rule fully replaced

The shipped `usercentrics` entry targeted `.uc-banner-wrapper`/
`.uc-banner-content`, a light-DOM v2 UI that did not match on
`usercentrics.com` itself or on any other site checked in this session. What
renders today is Usercentrics v3: a web component with an **open** shadow
root, host `<div id="usercentrics-root">` (seen on `o2online.de`, `n26.com`,
`deutsche-bank.de`) or `<aside id="usercentrics-cmp-ui">` (seen on
`usercentrics.com` itself, though empty there - see caveat below). Inside the
shadow root, every meaningful control carries a stable `data-testid`
independent of language or tenant: `uc-deny-all-button` ("Verweigern"/"Reject
All"/"Ablehnen"), `uc-accept-all-button` (never clicked), `uc-more-button`/
`uc-customize-anchor` (not needed - deny-all is always present directly in
the first layer on every site checked).

The rule uses `shadowPath: ["#usercentrics-root, #usercentrics-cmp-ui"]` (a
single selector-list entry, valid CSS, matching either host id) + `css:
"[data-testid=\"uc-deny-all-button\"]"`, both for `detect` and for the
`waitFor`/`click` flow steps. Confirmed working end-to-end - banner gone,
`scrollLocked` false, no residual overlay, zero page errors - on all three
sites that actually rendered the widget, verified with a standalone script
that imports the real, shipped `src/engine/*.js` modules exactly as
`tools/verify-rules.mjs` does (that file could not be extended with these
sites in this task, since `tools/verify-sites.json` was out of scope; the
same underlying engine code was exercised regardless).

**Caveat, not shipped as a gap in the rule itself**: `usercentrics.com`'s own
homepage and `dm.de` both expose the shadow host but never populated it with
actual banner content in any attempt this session (`shadowRoot.innerHTML`
stayed empty/style-only across repeated waits up to 12s) - plausibly
first-party suppression on the CMP vendor's own marketing site, and
something session/frequency-gated on `dm.de` (mirrors the `sparkasse.de`
flakiness above). Neither is evidence against the rule, since the rule's
detect condition is gated on the deny button actually existing - it simply
never claimed either of those two pages in this session.

## Second sweep of 393 real sites - three new CMP families, plus the
## Usercentrics gap closed

All entries below were confirmed via live Playwright inspection against the
named sites in this session (a realistic desktop UA, `chromium.launch({
headless: true })`), not carried over from a secondary source, and each was
exercised end-to-end with `tools/verify-rules.mjs --execute` before shipping.

### ConsentManager (`cdn.consentmanager.net`) - two rendering variants, both
### confidence ALTA

The brief's marker list (`cmpbox`, `cmpboxcontent`, `cmpwrapper`, `cmpbox2`,
classes `cmpbox`/`cmpstyleroot`/`cmpboxWelcomeGDPR`) turned out to describe
**two structurally different renderings of the same widget**, discovered by
live inspection rather than assumed:

- **Shadow-DOM rendering** (`consentmanager`, confirmed on
  `consentmanager.net`, `vodafone.it`, `es.wallapop.com`, `nzz.ch` - 4 of the
  5 sites named in the brief): `#cmpwrapper` is an **open** shadow host with
  zero light-DOM children of its own; everything - `#cmpbox`,
  `#cmpboxcontent`, every button - lives inside `hostEl.shadowRoot`. A bare
  `document.querySelector` (no `shadowPath`) finds nothing at all here,
  confirmed live: the first pass of this session's inspection queried the
  light DOM directly and got empty results on all four sites before the
  shadow root was found.
- **Light-DOM rendering** (`consentmanager_light_dom`, confirmed on
  `chefkoch.de`): no `#cmpwrapper` element exists at all; `#cmpbox2` (an empty
  background overlay) and `#cmpbox` sit directly in `<body>`, fully
  queryable without any `shadowPath`. chefkoch.de's markup is also visibly
  reskinned (`ck-btn-primary`, a custom "PUR" subscription upsell column next
  to the consent text) - a heavily customised tenant build that evidently
  disables the vendor's default shadow-DOM encapsulation, not a different
  CMP.

The two are mutually exclusive by construction on every site checked (a
light-DOM `#cmpbox` never coexists with a populated shadow `#cmpwrapper`, and
vice versa), so both entries ship at the same `priority: 10` with no ordering
concern between them.

**The brief's warning about `cmpwelcomebtnyes` (the accept button) is well
founded and is respected**: neither entry's `flow` ever references
`cmpwelcomebtnyes`/`.cmpboxbtnyes`. The real reject path has two forms,
confirmed by inspecting both the first layer and, where needed, the
"Customize"/"Einstellungen" second layer:

- **Direct first-layer reject** (`#cmpwelcomebtnno` wrapping
  `.cmpboxbtnno`): present and confirmed live on `consentmanager.net` ("Reject
  all"), `vodafone.it` ("Continua senza accettare") and `es.wallapop.com`
  ("Rechazar todo"). Clicking it alone closes the widget with the refusal
  registered (confirmed: `after.cmpId` is `null` post-click in every
  `--execute` run below, i.e. none of the CMP's own `detect` selectors
  resolve any more).
- **No direct reject; settings + second-layer reject** (`nzz.ch`,
  `chefkoch.de`): the first layer only offers "Alle Anbieter akzeptieren"
  (accept) and "Cookie-Einstellungen anpassen"/"Einstellungen" (customize).
  Clicking the customize link (`#cmpwelcomebtncustom`/`.cmpboxbtncustom`)
  reveals a second layer whose reject button is
  `.cmpboxbtnreject.cmpboxbtnrejectcustomchoices` - this compound class is
  stable across both sites and both rendering variants even though its label
  is not ("Alle Anbieter ablehnen" on `nzz.ch`, "Zustimmung widerrufen" -
  "revoke consent" - on `chefkoch.de`), so the flow matches by class, not by
  wording.

The shipped flow tries both paths unconditionally in one sequence (direct
reject -> open settings -> wait for the second-layer reject button -> click
it), the same "both paths, whichever no-ops" pattern already used for
Quantcast Choice CMP2 above: on a site with a direct reject, steps 2-4 simply
find nothing (the banner is already gone) and no-op; on a site without one,
step 1 no-ops and steps 2-4 do the work.

**`--execute` results, one issue per site, neither caused by this rule**:

- `consentmanager.net`, `es.wallapop.com`, `chefkoch.de`: "pagina integra" -
  banner gone, no scroll lock, no overlay, no page errors.
- `vodafone.it`: banner closes and the refusal registers correctly
  (`after.cmpId: null`), but `html{overflow-y: hidden}` stays stuck
  afterwards (`body` clears to `auto`, `html` does not) even 8+ seconds
  later. **Isolated by experiment**: reproduced identically whether the flow
  clicks only the direct reject button or runs the full four-step sequence -
  the extra settings-link click changes nothing. This is
  `vodafone.it`/consentmanager's own cleanup script forgetting to clear
  `<html>`'s inline overflow, the same category of pre-existing vendor bug
  already documented for `sparkasse.de` above; there is no action in the
  closed set that can reset an arbitrary style this project's own click did
  not set.
- `nzz.ch`: the refusal registers correctly (`after.cmpId: null`), but one
  page error (`"undefined"`, a bare thrown/rejected value with no message)
  appears exactly once the second-layer reject button is clicked. **Isolated
  by experiment**: a baseline run with no click at all produces zero errors;
  clicking only "Einstellungen" (settings) produces zero errors; the error
  appears only once `.cmpboxbtnrejectcustomchoices` itself is clicked, and it
  still appears when that click is a real, Playwright-trusted mouse click
  instead of this project's synthetic pointer/mouse sequence - ruling out
  "untrusted event" as the cause. This is `nzz.ch`'s/consentmanager's own
  script throwing while processing the reject-all action, the same category
  already documented for `osano.com` above (impact: low, the page stays
  usable, and the refusal is registered regardless).

### MediaMarkt/Saturn in-house PWA consent layer (`mms_pwa_consent_layer`) -
### confidence ALTA (4/4 sites), contradicts the brief's own automated
### analysis

The brief noted the automated sweep reported "direct refusal offered: none"
for `#pwa-consent-layer-deny-all-button`, despite the id's name. Live
inspection in this session found the opposite on all four named sites
(`mediaworld.it`, `mediamarkt.de`, `saturn.de`, `mediamarkt.es`): the button
is a genuine, always-present, first-layer direct reject -
`#pwa-consent-layer-deny-all-button` ("Rifiuta tutti"/"Alle ablehnen"/"Denegar
todo"), sitting next to `#pwa-consent-layer-accept-all-button` ("Accetta
tutti"/"Alle zulassen"/"Aceptar todo", never clicked) inside
`#mms-consent-portal-container`. No settings/second layer is needed - a
single click suffices, confirmed on all four sites with `--execute`: "pagina
integra" every time (banner gone, no scroll lock, no overlay, zero page
errors). The automated sweep's "none" verdict was very likely the same
`offersRefusal` text-matching caveat this file already flags elsewhere (it
reads body text, not button ids) - it is treated as a hint, not a
measurement, per the existing caveat above.

### The Polish/Romanian "cookie-consent-" family is NOT one platform - split
### into two separate rules, confirmed live

The three named sites (`wp.pl`, `ceneo.pl`, `emag.ro`) do **not** share a
single implementation, confirmed by inspecting each site's actual DOM rather
than assuming the shared "cookie-consent" name meant a shared vendor:

- **`wp.pl` and `ceneo.pl`** genuinely share one widget - same wrapper class
  `cookie-consent-banner`, same `js_cookie-consent-general`/
  `-custom`/`-partners` sub-ids, same button classes
  (`js_cookie-consent-agree`/`js_cookie-consent-necessary`/
  `js_cookie-consent-show-custom`). This is unsurprising once noticed: `wp.pl`
  and `ceneo.pl` are both properties of the same media group (Wirtualna
  Polska), which explains the shared in-house widget. Shipped as
  `wpholding_cookie_consent`: `detect` on `.cookie-consent-banner` +
  `.js_cookie-consent-necessary`, `flow` clicks
  `.js_cookie-consent-necessary` ("Nie zgadzam się" - "I don't agree",
  confirmed live on `ceneo.pl`; never `.js_cookie-consent-agree`, the accept
  button). `--execute` on `ceneo.pl`: "pagina integra".
- **`emag.ro` is a different, unrelated implementation**, confirmed live: its
  container is `.gdpr-cookie-banner`/`.js-gdpr-cookie-banner`, with buttons
  `.js-accept`/`.js-refuse`/`.js-change-settings` - no `cookie-consent-`
  prefix, no `js_` (underscore) naming, no shared sub-ids with the WP Holding
  widget at all. Per this project's own rule ("if they are different, do not
  force them into one rule"), this is a separate entry,
  `emag_gdpr_cookie_banner`: `detect` on `.gdpr-cookie-banner` + `.js-refuse`,
  `flow` clicks `.js-refuse` ("Refuză toate" - "Refuse all", confirmed live;
  never `.js-accept`). `--execute` on `emag.ro`: "pagina integra".

**`wp.pl` itself did not render actual banner content in this session** -
`.cookie-consent-banner` is present in the DOM (confirmed by repeated polling
up to 18s) but stays an empty, off-screen (`left: -9999px`) wrapper the whole
time, with none of the sub-ids or buttons ever populated. This is not
evidence the rule is wrong for `wp.pl`: the `detect` selector additionally
requires `.js_cookie-consent-necessary` to exist, which correctly does NOT
match while the widget is in this suppressed state, so the rule correctly
does nothing there right now (confirmed: `tools/verify-rules.mjs --site wp.pl
--execute` reports "BANNER NON COPERTO", i.e. no action taken, not a broken
action). If/when the same widget activates for a real visitor on `wp.pl` -
plausible given it is confirmed identical, class-for-class, to the widget
that does render on `ceneo.pl` - the same selectors should apply unchanged.
Not re-confirmed live on `wp.pl` itself in this session; flagged rather than
silently assumed.

### Usercentrics gap closed: a second, class-based button variant with no
### `data-testid` at all (`usercentrics_classic_buttons`)

The existing `usercentrics` entry's `detect`/`flow` require
`[data-testid="uc-deny-all-button"]` inside the shadow root. Live inspection
this session (with the realistic desktop UA already in place - see the
existing `usercentrics.com` caveat above, which no longer applies now that
the widget actually renders under that UA) found that **this attribute does
not exist at all** on several tenants that do otherwise run the same
Usercentrics v3 shadow-DOM widget:

- `usercentrics.com` itself, `dkb.de` and `zoopla.co.uk` (3 of the 8 sites
  named in this task) expose a shadow root whose deny/accept buttons carry
  only classes - `button.deny.uc-deny-button` (text varies: "Rifiuta" on
  `usercentrics.com`, "Ablehnen" on `dkb.de`, "Essential cookies only" on
  `zoopla.co.uk`) and `button.accept.uc-accept-button` (never clicked) - with
  no `data-testid` attribute anywhere in the shadow root.
- By contrast, `o2online.de`, `n26.com` and `deutsche-bank.de` (already
  shipped, confirmed again live in this session) expose the `data-testid`
  attribute and were checked to carry **no** `.uc-deny-button`/
  `.uc-accept-button` classes at all - the two forms are mutually exclusive
  in every tenant checked, not two attributes on the same button.

Rather than widening the existing entry's `css` to an `[data-testid=...],
.deny.uc-deny-button` union (which would blur what each entry's `detect`
actually proves and make a future regression harder to isolate to one
variant), this ships as a second, separate entry with an identical shape:
`shadowPath: ["#usercentrics-root, #usercentrics-cmp-ui"]` (same host-id
list as the existing entry, since both host ids were observed carrying
either button form) + `css: ".deny.uc-deny-button"`, for both `detect` and
the `waitFor`/`click` flow steps. Confirmed working end-to-end with
`--execute`: `dkb.de` and `zoopla.co.uk` both report "pagina integra" (banner
gone, no scroll lock, no residual overlay, zero page errors). `usercentrics.com`
itself was flaky again in this session's `--execute` run (reported "nessun
banner" - the same suppression/frequency-gating already documented above),
not evidence against the rule.

**Five of the eight sites named in the brief do not run Usercentrics at
all today**, confirmed live rather than assumed - the brief's sweep appears
stale for these:

- `heise.de` now runs a custom-skinned **Sourcepoint** deployment
  (`cmp.heise.de`, classes `cmp-banner`/`cmp-offer-accept-btn`/
  `cmp-consent-btn`/`cmp-offer-pur-tile`) with `.message-container` present
  but neither `.sp_choice_type_13` nor `.sp_choice_type_9` found - a
  choice-type numbering or a deeper settings layer not yet inspected. Not
  Usercentrics; out of scope for this fix; not chased further here.
- `ilfattoquotidiano.it` now runs **Clickio CMP** (`clickiocmp.com`, classes
  `clickio-cmp-*`), an entirely different vendor.
- `bmw.de`, `wetter.com`, `correos.es` showed **no Usercentrics markers, and
  in two cases no genuine cookie-consent banner at all** in this session's
  headless runs: `bmw.de`'s only "cmp-*" hits are an unrelated Adobe
  ePaaS-deprecation notice banner; `wetter.com` shows a generic in-house
  `cmp-*` id/class set with no vendor script loaded at all
  (`fingerprint.scripts: []`); `correos.es` shows only a `#form-cookies`
  element, also with no vendor script. None of the three loaded any
  `usercentrics`-hostname script in this session (checked directly via
  `page.on('request', ...)` and via a full-page HTML substring search for the
  literal word "usercentrics" - both came back empty). Plausibly geo-gated
  (a datacenter IP, not a residential EU one) rather than genuinely
  Usercentrics-free for a real visitor, but that is a guess, not a finding -
  left uncovered and reported honestly rather than guessed at.

## Usercentrics tie-break: `usercentrics` vs `usercentrics_classic_buttons` -
## precedence is pinned by a test, not by priority (code review fix)

Code review flagged that the two entries share the same `priority` (10), so
today's precedence in favour of the historic `usercentrics` (`[data-testid]`)
entry over `usercentrics_classic_buttons` is guaranteed only implicitly: by
`Array.prototype.sort`'s stability plus `usercentrics` being declared earlier
in `rules.json`. That guarantee would silently flip if anyone ever reordered
the two entries, or inserted a third one between them, without noticing the
dependency.

**Priorities were deliberately left equal rather than separated.** The two
entries are confirmed mutually exclusive on every live tenant checked (see
above: `o2online.de`/`n26.com`/`deutsche-bank.de` expose only `[data-testid]`,
`usercentrics.com`/`dkb.de`/`zoopla.co.uk` expose only the class form) - the
scenario this tie-break resolves does not occur on a real site today. Giving
either entry a priority strictly between 10 and the next tier up (20, used by
the `consentOrPay` overrides) or strictly below 10 (down toward 9/8, used by
`sourcepoint_consent_or_pay`/`trustarc_legacy_iframe`) would fix this one pair
deterministically, but it would also silently change the tie-break outcome
against every *other* `priority: 10` entry in the ruleset in the (extremely
unlikely, since every other CMP's `detect` selectors are structurally
unrelated) event one of them ever co-matched a page alongside Usercentrics.
That would trade one implicit, fragile guarantee for a different one
elsewhere, for no real coverage gain, which is worse than the problem being
fixed.

Instead, `test/new-cmp-rules.test.js` ("Usercentrics tie-break") now asserts,
against a DOM exposing both button forms in the same shadow root, that
`usercentrics` wins - and a second test pins today's equal-priority values so
a future edit to either priority is caught immediately rather than silently
changing which entry wins. If a real site is ever found that genuinely
exposes both forms together, revisit this: at that point a priority split
(or a schema-level "declaration order is the explicit tie-break" rule) would
be justified by an actual observed case, not a hypothetical one.

## eMAG rule hardened: click scoped to the banner, confirmed by wording
## (code review fix)

Code review correctly flagged `emag_gdpr_cookie_banner`'s `flow` as the same
class of risk already removed from Sirdata's positional fallback: it clicked
the bare `.js-refuse` class with `document.querySelector`-style reach across
the *entire* page, with no requirement that the clicked element actually live
inside `.gdpr-cookie-banner`, and no `textMatch` confirming its wording. Two
unrelated elements carrying those two generic class names anywhere on a
third-party page (`.gdpr-cookie-banner` from an entirely different widget,
`.js-refuse` on an unrelated "decline newsletter"/"refuse permission" button
elsewhere) would satisfy `detect` and then have the flow click whatever
`.js-refuse` happens to resolve first - not necessarily eMAG's own button.

Two independent fixes, both shipped:

- The click's `css` is now `.gdpr-cookie-banner .js-refuse` (a descendant
  selector), not the bare `.js-refuse` class - the clicked element must live
  inside the banner container `detect` already confirmed exists.
- The click now also carries `textMatchRef: "rejectAll"`, so the element must
  additionally carry refusal wording, not just the right class name and DOM
  position.

**Re-verified live on `www.emag.ro`** after both changes (Playwright,
`ro-RO` locale): the banner's real markup is
`.gdpr-cookie-banner > .cookie-banner-buttons > button.js-refuse`, text
"Refuză toate" - a genuine descendant of the container, exactly as the
hardened selector now requires. "Refuză toate" ("Refuse all") was not yet
covered by any `labels.json` variant (`rejectAll.ro` had "Respinge tot" /
"Respinge toate" / "Refuz toate cookie-urile", all *grammatically distinct*
verb forms - "Refuză" is third-person, the others are first-person/imperative
- `contains` matching would not have caught it), so it was added to
`rejectAll.ro` rather than guessed at or approximated with a near-miss
substring. It contains no acceptance-flavoured stem, so it passes
`test/text-match-safety.test.js` unchanged.

A new adversarial test in `test/new-cmp-rules.test.js` proves the fix: a DOM
with `.gdpr-cookie-banner` and an unrelated `.js-refuse` living *outside* it
still satisfies `detect` (that half of the risk is a separate, pre-existing
property of `detect.js` evaluating each selector independently - out of scope
for this fix, called out explicitly in the test) but the flow now clicks
nothing at all, rather than falling back to the unscoped, unrelated button.

`rulesetVersion` bumped to 5 for this change (labels.json + rules.json both
touched).

## rewe.de investigated (real-execution sweep flagged "contenuto sparito" /
## "navigazione persa") - confirmed the site's own Cloudflare WAF, not us

The non-regression sweep flagged `rewe.de` as broken after refusal. Live
investigation (Playwright, `de-DE` locale) found: the CMP is Usercentrics v3
(shadow host `#usercentrics-root`, `[data-testid="uc-deny-all-button"]` -
German wording "Nur notwendige erlauben"), matched by the existing
`usercentrics` entry, and the flow executes exactly as shipped (`waitFor`
then `click` on that one button).

Isolated with the same before/accept/refuse comparison already used
successfully for `ilgiornale.it`/`vodafone.it` elsewhere in this file, run
several times and in both orders to rule out a request-frequency confound
(the same trap already documented for `sparkasse.de`):

- **No click at all**: page stays fully intact (2110 chars of body text, 100
  links) across a longer, 8s observation window. No network call to
  Usercentrics' consent-registration endpoint at all.
- **Click "Alle erlauben" (accept)**: two calls to
  `consent-api.service.consent.usercentrics.eu/consent/uw/3` (Usercentrics'
  own consent-registration endpoint), page stays intact (100 links, only the
  banner's own markup leaves the DOM - text drops from 2110 to 1930 chars,
  nowhere near the >50% loss threshold that trips "broke"). Zero Cloudflare
  challenge requests.
- **Click "Nur notwendige erlauben" (deny)**: the *same* two calls to the
  *same* consent-registration endpoint, but additionally 14 requests to
  `www.rewe.de/cdn-cgi/challenge-platform/...` and
  `challenges.cloudflare.com/turnstile/...` - REWE's own Cloudflare Turnstile
  bot-verification challenge - fire immediately afterward. The page collapses
  to the challenge screen itself ("Zeig uns, dass du ein Mensch bist" / "WAF
  Challenge" / "Bot protection"): body text drops to 766 characters and every
  navigation link disappears (0 of the original 100), which is exactly the
  `contenuto sparito` + `navigazione persa` signature the sweep flagged.

Reproduced 4/4 times across both click orders (deny-then-accept-then-noclick,
and deny run in isolation as the very first and only request of its own
process) and with two different click mechanisms: this project's own
synthetic `pointerdown -> mousedown -> pointerup -> mouseup -> click`
sequence (`src/engine/steps.js`), and a fully OS-trusted Playwright
`page.click()` that pierces the open shadow root the same way a real user's
mouse would. Both trigger the identical challenge. Also reproduced with a
headed (non-headless) browser window, ruling out a pure headless-fingerprint
explanation for why the challenge appears at all (Chromium's headless build
does leak via Client Hints in ad-request payloads observed during this
investigation, but that leak is present identically across all three
conditions - accept, deny, no click - and only the deny path is followed by
a challenge).

**Conclusion: this is REWE's own Cloudflare Bot Management reacting to the
refusal decision itself, not a defect in this rule's selector, click
sequence, or the shared `usercentrics` flow.** The clicked element is
genuinely Usercentrics' own "deny all" control, confirmed by `data-testid`,
and a fully trusted native click on it produces the exact same outcome as
our synthetic one. This is the same category of finding already
documented above for `osano.com` and `nzz.ch` (the site's own script reacting
badly to a registered refusal) and for `sparkasse.de` (a leftover artifact
after refusal that no action in the closed set can clean up) - except here
the reaction is a hostile access wall rather than a leftover style, so the
practical impact for a real visitor who denies consent on `rewe.de` is worse:
they are shown a CAPTCHA rather than their shopping page. There is no
selector fix available for this: the existing `usercentrics` entry is
already correct, and no rule in the closed action set
(`waitFor`/`click`/`setCheckbox`/`setAriaToggle`/`hide`) can suppress or
work around a server-side WAF challenge triggered after the click already
succeeded. Reported honestly as a site-side finding rather than papered over;
not shipped as a "fix" because there is nothing in this project's rule schema
that could constitute one.

One caveat carried forward rather than hidden: this was tested from a single
residential/office IP over a short window, which is also exactly the
condition under which Cloudflare's bot scoring is most likely to escalate -
so while the accept/deny asymmetry (identical fingerprint, identical session,
only the button differs) is strong evidence the *decision* itself is what
triggers the escalation, it cannot be fully ruled out that a sufficiently
"trusted" IP/session would never see this challenge on deny either. That
distinction would not change the conclusion here either way: this project
still could not act on it from within the closed action set.
