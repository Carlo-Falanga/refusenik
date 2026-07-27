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
