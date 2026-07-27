# Attribuzioni

Le regole per i CMP **OneTrust, TrustArc, Cookiebot, Didomi, Usercentrics, Quantcast Choice (TCF), Osano**
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
| `rules/usercentrics.json` | `usercentrics` |
| `rules/quantcast.json` | `quantcast` |
| `rules/quantcast2.json` | `quantcast_v2` |
| `rules/osano.json` | `osano` |

## CMP non derivati da Consent-O-Matic

**BigID** e **DataGrail** non sono presenti nel repository Consent-O-Matic (nessun file `rules/bigid*.json`
o `rules/datagrail*.json`, verificato su `rules-list.json` completo). Le rispettive regole in
`rules.json` sono state ricavate da **ispezione diretta del DOM live** (Playwright) su siti reali che
usano questi due CMP:
- BigID: `https://bigid.com` (deployment del vendor stesso)
- DataGrail: `https://www.bedbathandbeyond.com` (cliente DataGrail confermato)

Nessun contenuto Consent-O-Matic è stato usato per questi due CMP.
