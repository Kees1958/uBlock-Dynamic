# `$popup`/`$popunder` via ABP-import — status en herzien voorstel

**Project:** uBlock-Stripped (Kees1958-fork van uBOL)
**Scope:** ongewijzigd — deze functie wordt uitsluitend geactiveerd via de
client-side "Import ABP rules"-pipeline (sandbox-tekst). De vooraf
gebundelde standaardfilterlijsten blijven buiten scope; die lopen via
`tools/build-rulesets.mjs`, dat `$popup`/`$popunder` al langer bewust
negeert.

---

## Status: de crashbug is verholpen (v8.6.5) — de feature zelf niet

Dit document was oorspronkelijk één voorstel voor zowel een bugfix als
een volledige feature-implementatie. Na evaluatie zijn die twee bewust
uit elkaar getrokken: de bug had een acuut, geverifieerd
gebruikersimpact dat losstaat van de vraag of iemand popup-blokkering
als functie wil; de volledige implementatie heeft een eigen,
onafgeronde architectuurvraag die niet gehaast moest worden opgelost
alleen om de bug te dichten.

---

## Deel 1 — de bug (opgelost, v8.6.5)

### Wat er mis was

`js/ui/ubo-parser.js` verwerkte `$popup`/`$popunder` (en, bleek bij
nader onderzoek, ook `$inline-font`/`$inline-script`/`$webrtc` — exact
dezelfde code-path) via:

```js
case sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER:
case sfp.NODE_TYPE_NET_OPTION_NAME_POPUP:
    processResourceType('', type);
    break;
```

Dit voegde een lege string toe aan de interne `resourceTypes`-Set. Die
lege string werd verderop wél weer weggefilterd
(`.filter(a => a !== '')`), maar had daarvóór al meegeteld bij een
`resourceTypes.size === 0`-check die bepaalt of Chrome's eigen
default-resourcetypes worden toegepast. Resultaat: een regel die
**uitsluitend** `$popup` als modifier had (geen enkele andere
type-beïnvloedende optie) kreeg `condition.resourceTypes: []` — een
ongeldige DNR-conditie.

### Waarom dit ernstiger was dan het leek

`ruleset-manager.js`'s `updateUserRules()` stuurt alle sandbox-regels in
**één atomaire aanroep** naar `dnr.updateDynamicRules({ addRules })`.
Chrome valideert die hele batch in één keer: is één regel ongeldig, dan
wordt de **volledige aanroep** afgewezen. Concreet: een gebruiker die
een publieke filterlijst importeert met daarin ook maar één losse
`$popup`-regel (AdGuard's eigen Popups-filter bevat er meerdere) zag
**geen van zijn geïmporteerde regels** actief worden — stil, zonder
aanwijzing welke regel de oorzaak was.

### De fix

```js
case sfp.NODE_TYPE_NET_OPTION_NAME_INLINEFONT:
case sfp.NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT:
case sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER:
case sfp.NODE_TYPE_NET_OPTION_NAME_POPUP:
case sfp.NODE_TYPE_NET_OPTION_NAME_WEBRTC:
    // geen van deze vijf heeft een DNR-resourceType-equivalent —
    // niets doen, val terug op defaultResourceTypes, exact zoals
    // build-rulesets.mjs deze zelfde vijf al langer negeert.
    break;
```

Alle vijf modifiers tegelijk gefixt, niet alleen `$popup`/`$popunder` —
ze deelden letterlijk dezelfde defecte regel code; een fix die er drie
van de vijf had laten liggen was een inconsistente halve fix van
precies hetzelfde defect geweest.

### Verificatie

- Getest tegen de twee echte filterregels die dit voorstel zelf citeert
  (`||dwlv.xyz^$popup`, `||start.parimatch.com^$popunder`) — beide
  leveren nu een geldige regel op zonder `resourceTypes`-sleutel.
- Gecombineerd geval (`$popup,script`) bevestigd ongewijzigd — de fix
  raakt alleen het "uitsluitend deze vijf modifiers"-geval.
- Volledige `tools/complete-check.mjs`-suite (16 checks, inclusief de
  JSDOM live-executiepas) draait schoon.
- Versie: `manifest.json` 8.6.4 → 8.6.5, CHANGELOG-entry toegevoegd.

**Wat dit NIET oplost:** popup/popunder-blokkering zelf werkt nog
steeds niet. `prevent-popup.js`/`prevent-popup-target.js` blijven
ongeregistreerde, dode code — exact zoals voor deze fix. Deze fix
voorkomt alleen dat een import crasht; hij voegt geen functionaliteit
toe.

---

## Deel 2 — de feature zelf (bewust nog niet geïmplementeerd)

### Waarom uitgesteld, niet afgewezen

De oorspronkelijke Sectie 4-schets (registratiefunctie) bleek bij
vergelijking met het bestaande `register*ContentScripts()`-patroon in
`scripting-manager.js` een concreet, verifieerbaar gat te hebben:

| | Oorspronkelijke schets | Bestaand patroon (elke `register*ContentScripts`) |
|---|---|---|
| Site-mode gating | `matches: ['<all_urls>']`, genegeerd site-instellingen | `buildSiteModeMatchScope()` |
| Concurrency guard | Geen | `withRegistrationLock()` |
| World | Niet gespecificeerd | Expliciet (`MAIN` voor vergelijkbare gevallen) |
| allFrames | Niet gespecificeerd | Expliciet `true` |

Het ontbreken van site-mode gating is het zwaarste punt: zoals
geschetst zou dit content script draaien op elke site, ook waar de
gebruiker filtering expliciet heeft uitgezet — precies de bugklasse
waarvoor dit project een eigen geautomatiseerde check heeft
(`tools/check-scripting-site-mode-gating.mjs`, C25). Het ontbreken van
`withRegistrationLock()` is evenmin een stijlkeuze: die guard bestaat
omdat een eerdere, ongelockte versie van precies dit
registratiepatroon al eens een race-conditie veroorzaakte in dit
project.

Dit zijn geen redenen om de feature af te wijzen — wel redenen om hem
niet te implementeren door de oorspronkelijke schets letterlijk over
te nemen.

### Wat nodig is vóór implementatie (niet meer dan dit, niet minder)

1. **`js/scripting/prevent-popup.js` en `prevent-popup-target.js`
   inspecteren** — welke `world`/`allFrames`-instellingen vereisen ze
   daadwerkelijk? Nog niet onderzocht.
2. **Registratiefunctie herschrijven** naar het bestaande
   publiek/`Impl`-tweeledige patroon, mét `buildSiteModeMatchScope()`
   en `withRegistrationLock()` — geen nieuw patroon, hergebruik van het
   bestaande (project-eigen C21-principe: hergebruik een bewezen
   oplossing, verzin er geen nieuwe naast).
3. **UI-vraag beslissen** — er is geen toggle voor deze feature
   (in tegenstelling tot de originele uBOL's `popupBlockMode`). Moet
   die er komen, of blijft dit een altijd-aan gedrag zodra een
   geïmporteerde `$popup`-regel matcht? Nog geen keuze gemaakt.
4. **`POPUP_RULES_MAX`-locatie heroverwegen** — oorspronkelijk voorstel
   plaatste dit in `dnr-budgets.js`, naast cross-module budgetten. Het
   precedent van `cookie-clicker-rules.js` (eigen lokale `RULES_MAX`,
   alleen ge-re-exporteerd) is minstens zo verdedigbaar voor een nieuw,
   op zichzelf staand subsysteem. Geen foute keuze in het origineel,
   wel een niet-vanzelfsprekende.

De rest van het oorspronkelijke voorstel (Secties 1 en 3: de
limiet-constante zelf, en `compiled-filters.js`'s
detectie/verwerkingslaag met `splitPopupRules()`/`processPopupRules()`)
blijft inhoudelijk overeind — die architectuur is geverifieerd
consistent met bestaande patronen (`sandboxFilters.*`-sleutelconventie,
`updateCompiledFilters()`-aanroeppad) en hoeft niet te worden herzien
wanneer dit werk wordt opgepakt.

### Performance-analysis (ongewijzigd, blijft geldig)

De rekenkundige onderbouwing uit het oorspronkelijke voorstel
(payload-grootte, binary-search-kosten, vergelijkingstabel
met/zonder limiet) is gecontroleerd en correct. Die analyse hoeft niet
opnieuw te worden gedaan wanneer dit werk wordt opgepakt.

---

## Deel 3 — definitief besluit: NIET implementeren, dode code verwijderd (v8.6.7)

Na verder onderzoek — een echte, systematische classificatie van elke
`$popup`/`$popunder`-regel in zowel de volledige uAssets-repository
(123 unieke regels) als AdGuard's Base filter (3.051 unieke regels) —
bleek de daadwerkelijke syntax structureel in twee, fundamenteel
verschillende vormen te vallen, geen van beide overeenkomend met wat
`prevent-popup.js`/`prevent-popup-target.js` daadwerkelijk doen:

1. **Site-scoped, geen bestemming** (`*$popup,domain=X`) — ~25% in
   uAssets, een kleine minderheid (3 actieve regels, ~148 domeinen) in
   AG Base. Beschrijft "dit sites eigen JS misdraagt zich", zonder een
   specifiek te matchen bestemmings-domein. **Geen van beide
   voorgestelde mechanismen (content-script hostname-matching, CSP-
   sandbox) kan dit type regel structureel afhandelen** — er is
   simpelweg geen hostname om tegen te matchen. Zou een volledig ander
   mechanisme vereisen (een `window.open`-override scriptlet,
   MAIN-world, hergebruik makend van het al bestaande, bewezen
   scriptlet-registratiepatroon) — nieuw te schrijven werk, niet iets
   dat deze twee bestanden alsnog bruikbaar maakt.
2. **Bestemming-gebaseerd** (`||host^$popup`, regex) — de meerderheid
   in beide corpora (~69% uAssets, ~97% AG Base regels). De meeste
   dragen een `doc`-modifier — dit matcht de top-level-navigatie van
   het POPUP-VENSTER ZELF naar zijn bestemming, niet een advertentie-
   iframe op de bezochte pagina. Chrome's DNR blokkeert al netwerk-
   requests op het netwerklaag-niveau, ongeacht wat de navigatie
   triggerde (`window.open()` inbegrepen) — de al bestaande (sinds
   v8.6.5) coarse-domain-block-fallback dekt dit type regel dus
   vermoedelijk al grotendeels af. (Inferentie op basis van DNR's
   gedocumenteerde architectuur, niet met een live popup getest —
   expliciet zo benoemd, niet als bevestigd gepresenteerd.)

**Conclusie:** de unieke waarde die `prevent-popup.js`/
`prevent-popup-target.js` zouden toevoegen bovenop de al bestaande
DNR-fallback is smal — vooral `about:blank`-achtige popups zonder
navigeerbare bestemmings-URL. Die smalle marginale waarde weegt niet op
tegen de volledige registratie-complexiteit (world/allFrames/runAt-
keuzes, storage-reader-injectie-timing, de binary-search sorteer-
invariant-valkuil in `prevent-popup.js` zelf) die nodig zou zijn om ze
daadwerkelijk aan te sluiten. Per dit project se eigen C13b
(dode-code-audit): "if a guard, branch, or data structure cannot be
demonstrated to affect observable behaviour in the current codebase,
it is dead code and must be removed. Do not preserve it 'for future
use.'" — van toepassing hier.

**Wat WEL is gedaan (v8.6.7):**
- `js/scripting/prevent-popup.js` en `prevent-popup-target.js`
  verwijderd — waren al 100% dode code (nul referenties elders,
  bevestigd), blijven dat, en zouden dat blijven zonder de hierboven
  afgewezen registratie-inspanning.
- Categorie-1 (site-scoped) blijft een apart, kleiner, mogelijk de
  moeite waard idee — een `window.open`-override scriptlet — maar is
  NIET geïmplementeerd in deze pas en is niet geblokkeerd door deze
  verwijdering.
- Deze investigatie (de daadwerkelijke regel-classificatie, de
  AG-Base/uAssets-cijfers, de CSP-sandbox-afweging) blijft hier
  bewaard als besluitvormingsrecord, per dit project se eigen
  "declared, not reconstructed from memory"-conventie — niet
  verwijderd samen met de code.

---

## Deel 4 — correctie op Deel 3 en besluit `$all` (10.7.2)

**De aanname in Deel 3 klopte niet.** Deel 3 ging ervan uit (expliciet als niet-getest benoemd) dat de gewone
domeinblokkade bestemming-gebaseerde popups "vermoedelijk al grotendeels" afdekt. Dat is niet zo: Chrome's DNR past
een regel alleen toe op een top-level pagina (tabblad of popup-venster) als `main_frame` in `resourceTypes` staat, en
geen enkele host-regel uit de lijsten heeft dat. Echte melding: een pagina opende s.pemsrv.com als popup-tabblad,
terwijl pemsrv.com in vijf meegeleverde regels stond.

**Wat de lijsten zelf bedoelen.** AdGuard Base markeert zulke hosts met `$all` (alles, de pagina zelf inbegrepen),
bv. `||s.pemsrv.com^$all` — niet met `$popup`. De build kende `all` niet en liet al die regels vallen (302 in AG Base).

**Besluit (eigenaar):**
1. `$all` wordt gecompileerd naar alle types inclusief `main_frame` (build; de import-parser deed dit al). 514
   paginaregels erbij na de volledige refresh; geen regex, geen extra code in pagina's.
2. `$popup` wordt NIET gecompileerd. Gebouwd en gemeten (633 paginaregels, waarvan 539 uit AdGuard French, 236
   zonder third-party- of site-voorwaarde), daarna teruggedraaid: DNR kan een popup niet onderscheiden van een
   gewone klik op een link of een getypt adres, dus echte sites die regionale lijsten met `$popup` markeren
   (iqoption.com, olybet.lv, optibet.lv, …) zouden via links onbereikbaar worden. In AG Base zelf staan maar 21
   host-only `$popup`-regels; pemsrv.com zit daar niet bij.
3. `$popunder` blijft vallen: een popunder stuurt het OORSPRONKELIJKE tabblad naar de advertentie, wat DNR niet kan
   uitsplitsen; een `$all`-regel op dezelfde host blokkeert die pagina alsnog. AG Base bevat 0 `$popunder`-regels.
4. De import-parser (`ubo-parser.js`) laat `$popup`/`$popunder` nu ook vallen, gelijk aan de build. Sinds 8.6.5
   vielen ze terug op de standaardtypes, waardoor `*$popup,domain=site` ALLES op die site blokkeerde.

**Bekende beperking (10.7.2):** het popup-tabblad zelf ging nog open (Chrome toonde er zijn "geblokkeerd"-pagina in).
**Opgelost in 10.7.3 (besluit eigenaar):** `js/core/blocked-popup-closer.js` sluit een tabblad dat een pagina opende
zodra Chrome het laden ervan blokkeert (ook "eerst leeg, dan doorsturen"), binnen 5 s na openen. Geen eigen
domeinlijst: de DNR-regels beslissen; niets draait bij het laden van pagina's.

