# Attribuzioni

Le regole per i CMP **OneTrust, TrustArc, Cookiebot, Didomi, Osano**
in `rules.json` sono state **adattate** (non copiate letteralmente: schema JSON diverso, set di azioni
diverso, nessuna logica condizionale/ciclica) a partire dai selettori CSS e dalla logica di flusso
osservabili nel progetto open source:

**Consent-O-Matic**
Repository: https://github.com/cavi-au/Consent-O-Matic
Copyright (c) 2019,2020,2021,2022 Janus Bager Kristensen and Rolf Bagge,
CAVI - Center for Advanced Visualization and Interaction, Aarhus University
Licenza: **MIT License**

> Avviso di copyright riprodotto **verbatim** dal file `LICENSE` del repository, come richiesto
> dalla MIT ("The above copyright notice ... shall be included in all copies or substantial
> portions of the Software"). Non riformattare né abbreviare: questo progetto è destinato a
> essere ceduto, e l'acquirente farà due diligence sulla proprietà intellettuale.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

La MIT License richiede solo la conservazione dell'avviso di copyright e del permesso in copie o
porzioni sostanziali del software. Questo file soddisfa tale obbligo per la porzione di `rules.json`
derivata dai file sorgente Consent-O-Matic elencati sotto.

## File sorgente usati (verificati via fetch diretto, MIT)

| File Consent-O-Matic | CMP nel nostro rules.json |
|---|---|
| `rules/onetrust.json`, `rules/onetrust_banner.json`, `rules/onetrust_pcpanel.json`, `rules/onetrust_pctab.json` | `onetrust` |
| `rules/trustarc_bar.json`, `rules/trustarc_frame_2022.json`, `rules/trustarc_popup_hider.json` | `trustarc_legacy_iframe` |
| `rules/cookiebot.json` | `cookiebot` |
| `rules/didomi.io.json` | `didomi` |
| `rules/osano.json` | `osano` |

**Nota di superamento**: questa tabella elencava in precedenza anche `rules/usercentrics.json` →
`usercentrics` e `rules/quantcast.json`/`rules/quantcast2.json` → `quantcast`/`quantcast_v2`. Quei
selettori (Consent-O-Matic, generazione precedente di entrambi i CMP: Usercentrics v2 light-DOM,
Quantcast Choice `qc-cmp-ui-container`/`data-tracking-opt-in-overlay`) non trovavano più riscontro sul
campo — verificato via ispezione DOM live in questa sessione, vedi `NOTE.md` — e sono stati **sostituiti
integralmente** con regole ricavate da ispezione diretta del DOM (vedi sezione successiva). Nessun
contenuto Consent-O-Matic rimane nelle regole `usercentrics` e `quantcast` attualmente in `rules.json`.

## CMP non derivati da Consent-O-Matic

**BigID** e **DataGrail** non sono presenti nel repository Consent-O-Matic (nessun file `rules/bigid*.json`
o `rules/datagrail*.json`, verificato su `rules-list.json` completo). Le rispettive regole in
`rules.json` sono state ricavate da **ispezione diretta del DOM live** (Playwright) su siti reali che
usano questi due CMP:
- BigID: `https://bigid.com` (deployment del vendor stesso)
- DataGrail: `https://www.bedbathandbeyond.com` (cliente DataGrail confermato)

Nessun contenuto Consent-O-Matic è stato usato per questi due CMP.

**Usercentrics** (regola riscritta), **Quantcast Choice CMP2** (regola riscritta), **Sourcepoint**,
**Complianz**, **CookieYes**, **Commanders Act / TagCommander** e **Sirdata** sono state ricavate
allo stesso modo, da **ispezione diretta del DOM live** (Playwright) su siti reali, in questa sessione:
- Usercentrics: `https://www.o2online.de`, `https://www.n26.com`, `https://www.deutsche-bank.de`
  (widget v3 con web component a shadow DOM, host `#usercentrics-root`; `https://usercentrics.com`
  stesso e `https://www.dm.de` espongono l'host ma non renderizzano il banner in modo affidabile in
  questa sessione — vedi `NOTE.md`).
- Quantcast Choice CMP2: `https://www.ilgiornale.it`, `https://www.liberoquotidiano.it`,
  `https://www.open.online`, `https://index.hu`, `https://www.quantcast.com`,
  `https://www.mirror.co.uk` (quest'ultimo per la variante pay-to-reject, vedi `NOTE.md`).
- Sourcepoint: `https://www.bbc.co.uk` (reject genuino), `https://www.spiegel.de`,
  `https://www.bild.de`, `https://www.zeit.de`, `https://www.sueddeutsche.de` (muro
  consenti-o-abbonati, nessun reject in nessun livello, vedi `NOTE.md`).
- Complianz: `https://complianz.io`.
- CookieYes: `https://www.cookieyes.com`.
- Commanders Act / TagCommander: `https://www.sparkasse.de`, `https://www.bouyguestelecom.fr`,
  `https://www.credit-agricole.fr`.
- Sirdata: `https://www.sirdata.com`, `https://www.01net.com`.

Nessun contenuto Consent-O-Matic è stato usato per nessuno di questi CMP.

## Compatibilità con la licenza GPL-3.0-only del progetto

Questo progetto è distribuito nel suo insieme sotto **GPL-3.0-only** (vedi `LICENSE`
nella radice del repository). Di seguito una nota di tracciabilità sulla compatibilità
con il materiale MIT descritto sopra, non una consulenza legale.

- La **MIT License è compatibile** con la GPL-3.0: un'opera che incorpora o adatta
  codice MIT può essere ridistribuita come parte di un progetto più ampio rilasciato
  sotto GPL-3.0-only.
- L'**avviso di copyright MIT** riprodotto in questo file resta **obbligatorio** e deve
  essere conservato così com'è, anche nell'opera distribuita sotto GPL: la compatibilità
  con la GPL non esime dal rispetto degli obblighi della licenza MIT di origine.
- La GPL-3.0-only si applica **all'insieme del progetto** così come distribuito qui,
  non retroattivamente al materiale Consent-O-Matic a monte: il repository originale di
  Consent-O-Matic rimane sotto la propria licenza MIT, indipendentemente da come viene
  usato qui.
