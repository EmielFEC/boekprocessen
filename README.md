# Boekproces voor Recras - FEC Sevenum

Een eigen boekproces bovenop de Recras API, losstaand van de standaard
Recras-widget. Bezoekers stellen eerst hun bezoek in (aantal personen +
datum), kiezen daarna een of meerdere losse activiteiten in een
winkelmandje, en ronden af met één Recras-boeking voor het hele bezoek.

## Wat dit doet

1. **Bezoek instellen**: de klant vult eenmalig het **aantal personen** en de
   **datum** van het bezoek in. Dit geldt voor de rest van het bezoek.
2. **Activiteiten kiezen**: een overzichtspagina toont de losse activiteiten
   (Bowling, Lasergame, American Golf, Fun Curling, X-Cube, X-Wall, ...) in
   een vaste volgorde, plus placeholders voor Combideals en
   Activiteitendeals ("binnenkort beschikbaar" - die komen later).
3. Per activiteit opent een boekproces:
   - Als de activiteit dat toestaat, kan de klant aanvinken dat **een deel
     van de groep** deze activiteit doet (bijv. bij Lasergame), en een kleiner
     aantal invullen dan het totale bezoekersaantal.
   - De server leest de beschikbaarheid van die dag uit
     (`GET /api2/producten/{id}/beschikbaarheid`), sluit tijden uit die al
     overlappen met iets anders in het mandje, en berekent een
     boekingsvoorstel:
     - Past de groep in 1 moment? Dan kiest de klant een tijd.
     - Is de groep te groot voor 1 moment? Dan kiest de klant de starttijd
       van de eerste subgroep, en berekent de server automatisch het
       optimale vervolgschema voor de rest (zie `planning.js`).
   - Voor activiteiten die per baan/tafel/sessie geboekt worden (Bowling,
     Fun Curling, X-Wall) berekent de server hoeveel eenheden nodig zijn
     (bijv. 22 personen bowlen -> 4 banen), als **1 boekingsregel op
     hetzelfde moment** - dit is dus geen "groep-splitsing" over tijd, dat
     is voorbehouden aan het geval waarin een groep letterlijk niet
     tegelijk in 1 moment past.
   - "Toevoegen aan planning" plaatst de activiteit in het winkelmandje.
4. Het **boekingsoverzicht (mandje)** staat continu in de zijbalk zodra de
   klant voorbij de eerste stap is: gekozen activiteiten, aantallen, tijden
   en een lopend totaalbedrag (prijzen worden live uit Recras opgehaald, zie
   verderop).
5. De klant kan een volgende activiteit toevoegen (die dan geen tijden meer
   toont die al bezet zijn door iets anders in het mandje) of de boeking
   afronden.
6. Bij afronden: zoekt of maakt een klant aan via `POST /api2/klanten`
   (Recras dedupliceert zelf op naam + e-mailadres). Daarna wordt **alles in
   het mandje in 1 Recras-boeking** gezet, met 1 boekingsregel per
   (sub)groep per activiteit, status **bevestigd**. Zie `recras.js`
   (`maakCombinatieBoeking`).

Dit is bewust nog geen "echt" boekproces via de `bookprocesses/book`
Alpha-API - deze opzet praat rechtstreeks tegen de kern-endpoints.

## Structuur

```
recras-boekproces/
  server.js       Express-server: API-routes + het mandje (winkelmandje)
  recras.js       Alle communicatie met de Recras API (1 plek, herbruikbaar)
  planning.js     Groep-splitsing + overlap-logica (los te testen, geen Recras-calls)
  products.json   Koppeling tussen "slugs" en Recras product-ids/instellingen
  public/
    index.html    De boekpagina (vanilla HTML/JS, geen framework)
  .env.example    Voorbeeldconfiguratie (kopieer naar .env)
```

## Draaien (zonder installaties op je eigen computer)

Geen adminrechten nodig: dit hele traject verloopt via je browser, met gratis
accounts bij GitHub en Render.com. Dit is bovendien meteen de manier waarop
dit straks ook echt live komt te staan.

### Stap 1: code op GitHub zetten

1. Maak (als je die nog niet hebt) een gratis account op [github.com](https://github.com).
2. Ga naar je bestaande repository (of maak een nieuwe aan via **+ > New
   repository**).
3. Ga naar **Add file > Upload files**, en upload de gewijzigde bestanden
   opnieuw: `server.js`, `recras.js`, `planning.js`, `products.json`,
   `public/index.html`, `README.md`. Upload `.env` NIET.
4. Klik onderaan **Commit changes**.

### Stap 2: Render.com deployt automatisch

Als je Web Service al draait, pakt Render de wijziging vanzelf op zodra je
commit op GitHub staat (duurt 1-2 minuten). Omgevingsvariabelen
(`RECRAS_HOST`, `RECRAS_TOKEN`) hoef je niet opnieuw in te stellen, die
blijven staan.

**Let op (gratis Render-tier)**: een gratis "Web Service" gaat na inactiviteit
in slaap en heeft dan ~30-50 seconden nodig om wakker te worden. Voor de
uiteindelijke live website upgrade je naar een betaald plan.

## Nieuwe activiteiten toevoegen

Voeg een regel toe aan `products.json`, geen code nodig:

```json
"nieuwe-activiteit": {
  "product_id": 1234,
  "naam": "Nieuwe activiteit",
  "duur_minuten": 30,
  "per_eenheid_personen": 1,
  "eenheid_naam": null,
  "toestaan_deelgroep": true,
  "volgorde": 9,
  "actief": true,
  "locatie_id": null,
  "book_process_id": null
}
```

- `per_eenheid_personen`: hoeveel personen passen er in 1 "eenheid" (baan/
  tafel/sessie)? Voor een puur per-persoon activiteit is dit `1`. Voor
  Bowling (7 p.p. baan) of Fun Curling (6 p.p. baan) staat dit hoger - de
  server berekent dan zelf hoeveel eenheden nodig zijn en boekt dat als 1
  regel op hetzelfde moment (geen tijdsplitsing).
- `toestaan_deelgroep`: mag een klant een kleiner aantal opgeven dan de
  totale bezoekersgroep voor deze activiteit?
- `actief: false` verbergt de activiteit (gebruikt nu voor "Game Area",
  waarvan het Recras product-ID nog niet bekend is - zie open punten
  hieronder).
- Prijzen worden **niet** meer hier beheerd: die worden live opgehaald via
  `recras.haalPrijsPerPersoon()`. Zie open punten voor de aanname die dat
  vereist.

## Hoe de groep-splitsing en het mandje werken (en de aannames erachter)

De logica in `planning.js` is los van de Recras-communicatie, zodat je 'm
kunt lezen/testen zonder een echte API-verbinding.

1. **Capaciteit per moment**: bij baan/tafel-producten (Bowling, Fun
   Curling, X-Wall) blijkt Recras' `beschikbaarheid` het aantal vrije
   **eenheden** (banen) terug te geven, niet al personen. De server
   vermenigvuldigt dit daarom met `per_eenheid_personen` om de echte
   personen-capaciteit van een moment te krijgen (`personenCapaciteitVoorMoment()`
   in `server.js`, `leesMomenten()` in `planning.js`). Zo boekt een groep van
   10 op Bowling (7 p.p. baan) gewoon 2 banen tegelijk op 1 moment, in plaats
   van ten onrechte over meerdere tijden gesplitst te worden. "Capaciteit per
   moment" (voor de vraag of een groep in 1 moment past) is daarna de
   hoogste personen-capaciteit die op de gekozen dag ergens gezien wordt.
2. Past de groep in 1 moment? -> `status: 'enkel'`, kies een tijd.
3. Past de groep niet in 1 moment? -> de groep wordt over meerdere momenten
   verdeeld; de klant kiest de starttijd van groep 1, waarna
   `planVervolgSchema` het optimale (zo aansluitend mogelijke) vervolgschema
   voor de rest berekent. Een tussenliggend vol moment wordt overgeslagen
   (dus niet per se strak aaneengesloten); pas als er na de gekozen
   starttijd geen ruimte meer over is voor alle subgroepen, krijgt de klant
   een melding en kan die een andere starttijd voor groep 1 kiezen. Er zijn
   twee verdeelstrategieën, gekozen op basis van `per_eenheid_personen`:
   - **Gelijk verdelen** (`verdeel()`) voor pure per-persoon-activiteiten
     (Lasergame, American Golf): de groep wordt zo eerlijk mogelijk over de
     benodigde momenten verdeeld (bijv. 22 -> 8+7+7).
   - **Verdelen over eenheden** (`verdeelOverEenheden()`) voor activiteiten
     die per fysieke eenheid geboekt worden (Bowling, X-Cube, Fun Curling,
     X-Wall). Volgorde (expliciet zo bevestigd door Emiel, na een eerdere
     "max-fill"-versie die juist ONgelijke groepen opleverde):
     1. Bereken hoeveel eenheden er in totaal nodig zijn (naar boven
        afgerond, zoals Recras' eigen `per_x_personen_afronding: boven`).
     2. Verdeel het totale aantal personen zo GELIJK mogelijk over die
        eenheden.
     3. Bundel die gelijk-verdeelde eenheden tot zo min mogelijk, zo vol
        mogelijke momenten (want er passen maar een beperkt aantal eenheden
        tegelijk op 1 moment).

     Voorbeeld X-Cube (6 p.p., max. 2 tegelijk -> capaciteit 12 p. per
     moment): 18 -> eenheden [6,6,6] -> momenten **[12, 6]**; 19 -> eenheden
     [5,5,5,4] -> momenten **[10, 9]** (beide subgroepen hebben dan 2 cubes
     nodig - "2x2 X-Cubes"). Voorbeeld X-Wall (8 p.p., maar 1 wall tegelijk
     -> capaciteit 8 p. per moment): 18 -> eenheden [6,6,6] -> momenten
     **[6, 6, 6]** (niet het eerder foutieve [8, 8, 2], dat ontstond doordat
     de oude strategie momenten eerst maximaal probeerde te vullen in plaats
     van de groep eerlijk over de benodigde eenheden te verdelen).
4. **Overlap tussen activiteiten**: `annoteerOverlap()` verwijdert GEEN
   startmomenten meer uit de lijst - elk moment blijft zichtbaar en wordt
   geannoteerd met hoeveel personen er dan al (via andere mandje-items)
   elders bezig zijn (`overlapLast`/`overlapItems`). Pas als die
   overlappende personen plus de nieuwe aanvraag de totale bezoekersgroep
   zou overschrijden, is er een echt conflict (`heeftConflict()`,
   `conflict: true` op de optie). Dit lost twee dingen tegelijk op:
   - **Legitieme parallelle deelgroepen mogen wél tegelijk**: als een
     deelgroep van bijv. 10 van de 20 Lasergame doet, kan de andere 10 op
     hetzelfde moment een andere activiteit boeken (10 + 10 = 20, dus geen
     conflict) - zonder dat er ooit meer dan de totale groep tegelijk "in
     gebruik" is.
   - **Echte conflicten worden getoond, niet verborgen**: in de UI worden
     conflict-momenten rood omlijnd getoond met een tooltip die vermeldt
     welke andere activiteit(en) het betreft; klikken op zo'n moment
     verwijdert die conflicterende activiteit(en) uit het mandje en opent ze
     meteen opnieuw, zodat de klant er een nieuwe tijd voor kan kiezen (zie
     `klikOpConflictSlot()` in `public/index.html`). De server wijst een
     conflicterende poging tot toevoegen/boeken ook hard af (409, met
     `conflict: true` en `overlapItems`) als een race conditie de
     UI-controle zou omzeilen.
5. **Winkelmandje / "hold"**: Recras zelf heeft geen reserverings-mechanisme,
   dus er wordt geen plek écht vastgehouden zolang iemand aan het boeken is.
   In plaats daarvan:
   - Het mandje leeft server-side (in het geheugen) onder een `mandjeId`, en
     wordt na 45 minuten inactiviteit automatisch opgeruimd.
   - Bij het toevoegen van een activiteit wordt de beschikbaarheid opnieuw
     gecontroleerd (niet blind vertrouwd op wat de klant eerder zag).
   - Vlak vóór het definitief boeken wordt **alles in het mandje nogmaals
     herverifieerd**. Blijkt een moment ondertussen niet meer beschikbaar
     (iemand anders was sneller), dan geeft de server een duidelijke fout
     terug met welke activiteit het betreft; de frontend verwijdert dat item
     en stuurt de klant terug naar het overzicht om een nieuw tijdstip te
     kiezen, zonder de rest van het mandje kwijt te raken.
6. **Volgeboekte tijden/activiteiten blijven zichtbaar, maar grijs.** Een
   tijdstip zonder genoeg capaciteit wordt getoond als niet-klikbaar in
   plaats van weggelaten (`beschikbaar: false` op elke `optie` in
   `planning.js`). Hetzelfde geldt op de activiteitenoverzicht-pagina: een
   activiteit die die dag wel startmomenten heeft maar overal vol zit, of
   die dag helemaal geen startmomenten heeft, wordt getoond als
   uitgeschakelde tegel ("Vandaag volgeboekt" / "Niet beschikbaar op deze
   dag") in plaats van verborgen te worden.
7. **Maximale groepsgrootte is 25 personen** (`MAX_GROEPSGROOTTE` in
   `server.js`), zowel server- als clientside gevalideerd bij het instellen
   van het bezoek.
8. **Prijs per baan/eenheid vs. per persoon.** Sommige activiteiten worden
   per baan/tafel afgerekend in plaats van per persoon. Dit staat per
   product in `products.json` als `prijs_type: 'per_eenheid'` (bevestigd
   voor Bowling, Fun Curling en X-Wall) of `'per_persoon'` (standaard, voor
   Lasergame/American Golf/X-Cube). Bij `'per_eenheid'` rekent de server de
   prijs per subgroep uit als (naar boven afgeronde) aantal eenheden ×
   prijs, en telt dat per subgroep op - dus een gesplitste groep kan in
   totaal meer eenheden kosten dan een ongesplitste, omdat elke subgroep
   apart afgerond wordt.
9. **Fysieke bovengrens aan gelijktijdige eenheden.** Sommige producten
   hebben een harde grens aan hoeveel eenheden er TEGELIJK (op 1 moment)
   ingezet kunnen worden, die niet vanzelf uit Recras' `beschikbaarheid`
   blijkt (bijv. X-Cube: max. 2 tegelijk, maar Recras rapporteerde op een
   moment 3 vrije eenheden). `max_eenheden_per_moment` in `products.json`
   dwingt dit hard af (`begrensEenheden()` in `server.js`), vóórdat de rest
   van de planning ermee rekent.

## Prijzen: bevestigde vorm en btw

Bevestigd tegen echte productdata (Bowling, product 194):

```json
{
  "ProductPrice": [{ "btw": 9, "verkoop": 34.5 }],
  "verkoop": 34.5,
  "aantalbepaling": "per_x_personen",
  "per_x_personen": 7,
  "per_x_personen_afronding": "boven"
}
```

Twee dingen zijn hiermee bevestigd:

- **Het prijsveld is `ProductPrice[0].verkoop`** (met het top-level
  `verkoop`-veld als kopie/fallback), en dit bedrag is **AL INCLUSIEF btw**
  (bevestigd door Emiel). `recras.js` (`haalPrijsPerPersoon()`) geeft dit
  bedrag daarom ongewijzigd door. **Let op:** een eerdere versie rekende
  hier zelf nog een keer btw overheen (in de veronderstelling dat `verkoop`
  excl. btw was), waardoor klanten een prijs te zien kregen die btw dubbel
  meetelde (te hoog) - die extra berekening is verwijderd.
- **Recras' eigen `per_x_personen: 7` bevestigt de eerder aangenomen
  "eenheden i.p.v. personen"-hypothese** voor Bowling: het product is zelf
  al geconfigureerd als "7 personen per eenheid, naar boven afronden" -
  precies wat `per_eenheid_personen: 7` in `products.json` aannam.

## Open punten (moet nog live geverifieerd/aangevuld worden)

- **"Game Area" heeft nog geen Recras product-ID.** Staat in
  `products.json` op `actief: false` met een `_todo`-veld. Zodra bekend is
  welk product dit is (en of het tijdgebonden is met een startmomentgroep,
  of bijv. per token werkt) kan dit aangezet worden.
- **OPGELOST: boeking-status.** "bevestigd" werd door Recras afgewezen; via
  een export van bestaande boekingen (door Emiel aangeleverd) is bevestigd
  dat de correcte waarde de STRING `"definitief"` (kleine letters) is.
  `maakCombinatieBoeking()` in `recras.js` gebruikt dit nu als default
  status, en `server.js` geeft dit ook expliciet mee bij
  `POST /api/mandje/:mandjeId/boeken`. De tijdelijke debug-route
  `GET /api/debug/boekingen?limit=` bleek zelf ook een bug te hebben: Recras'
  `/boekingen`-endpoint accepteert geen `limit`-query-parameter (gaf "Could
  not validate extra field" terug) - `listRecenteBoekingen()` haalt nu alle
  boekingen op en knipt zelf af tot `limit` resultaten.
- **"Eenheden i.p.v. personen"-aanname bij Bowling** is bevestigd, zie
  "Prijzen: bevestigde vorm en btw" hierboven. Voor **X-Cube** is dezelfde
  aanname nog niet met live data bevestigd (en Recras leek op enig moment 3
  vrije eenheden te tonen terwijl er maar 2 X-Cubes zijn - zie punt 9
  hierboven over `max_eenheden_per_moment`); gebruik
  `GET /api/debug/product/189` en `GET /api/debug/beschikbaarheid/x-cube-30?datum=...`
  om dit te controleren. Voor **X-Wall** (dat op `aantalbepaling: vast`
  staat i.p.v. `per_x_personen`) is de betekenis van "per 8 personen" ook
  nog niet geverifieerd met live data.
- **Fun Curling en X-Wall zijn nu bevestigd per baan/sessie afgerekend**
  (`prijs_type: 'per_eenheid'`), net als Bowling.
- **Boeking-met-meerdere-regels tegen echte data.** Test een boeking met
  minstens 2 activiteiten en 1 gesplitste groep, en controleer in Recras
  zelf: juiste aantallen per regel, juiste totaalprijs, geen ontbrekende
  kostenregels.
- **Race conditions** zijn verkleind (herverificatie bij toevoegen én bij
  boeken) maar niet volledig uitgesloten tussen die twee momenten.
- **Mixen van subgroepen over verschillende activiteiten** (een deel van de
  groep bowlt, een deel doet lasergame, **tegelijkertijd**) werkt nu wel: de
  overlap-check kijkt per moment naar de SOM van personen uit overlappende
  mandje-items t.o.v. de totale bezoekersgroep (zie punt 4 hierboven), niet
  meer naar "is er al iets, ja/nee". Nog niet gebouwd: een harde controle
  dat dezelfde deelgroep niet zichzelf dubbel inplant op twee activiteiten
  tegelijk (er wordt alleen op totaalaantallen gerekend, niet op wie precies
  waar zit) - voor nu is dat de verantwoordelijkheid van de klant/het
  overzicht in de zijbalk.
- **X-Cube: max. 2 cubes** wordt niet apart afgedwongen in de code, maar
  volgt automatisch uit wat Recras zelf als vrije eenheden teruggeeft op
  `beschikbaarheid` (net als bij Bowling) - als Recras daar nooit meer dan 2
  laat zien, kan de server ook nooit meer dan 2 cubes inplannen.
- **Combideals en Activiteitendeals** staan als placeholder op de
  activiteitenpagina ("binnenkort beschikbaar") en doen nog niets.
- **Dynamische prijzen** zijn nog niet meegenomen; de huidige live-prijs is
  de standaard verkoopprijs van het product.
- **Betaalmethode** (Mollie / op locatie) is nog niet gebouwd; elke boeking
  komt nu direct op status "bevestigd" te staan zonder betaalstap.
- **Beelden per activiteit** ontbreken nog (tegels tonen alleen naam, duur
  en prijs).
- **Validatie/foutafhandeling richting de klant** is functioneel maar nog
  niet vertaald naar vriendelijke, klantgerichte Nederlandse teksten voor
  elk mogelijk foutscenario.
- **Beveiliging/schaalbaarheid van het mandje**: dit staat nu in het
  geheugen van 1 serverinstantie. Prima voor testen; bij meer verkeer of
  meerdere serverinstanties (Render kan opschalen) moet dit naar een
  gedeelde opslag (bijv. Redis) verhuizen.
- **Huisstijl toegepast, met paars nu als dominante kleur** (op verzoek, met
  een display-bord-screenshot als vormgevingsvoorbeeld). De pagina-
  achtergrond en alle kaarten/tegels zijn nu donkerpaars (`--paars-donker`/
  `--paars-kaart`), met oranje (`#f39313`) als accentkleur voor knoppen en
  prijzen. Tijdstip-knoppen tonen live vrije capaciteit ("3 banen vrij", "6
  plekken vrij"; de eerder toegevoegde "Bijna vol!"/"Laatste baan!"-badges
  zijn op verzoek weer verwijderd - dat was voorlopig te veel). Activiteiten-
  tegels tonen (indien beschikbaar) de echte productfoto uit Recras
  (`afbeelding_href`/`boekproces_afbeelding_href`, met een stille fallback
  naar geen foto als het laden mislukt), nu vierkant (`aspect-ratio: 1/1`)
  en met 3 activiteiten naast elkaar (`.activiteiten-grid`, met een
  mobiele fallback naar 2 resp. 1 kolom(men) op kleinere schermen).
  **Lettertypes:** het echte "Mascot MVB"-fontbestand (`.otf`, door Emiel
  aangeleverd) staat nu in `public/fonts/MVB-Mascot.otf` en wordt via
  `@font-face` geladen - dit wordt ALLEEN gebruikt voor de grote
  schermtitels (`h1`, `h2.schermtitel`), in wit met een oranje
  slagschaduw (`text-shadow`), zoals gevraagd. Alle overige tekst
  (activiteitnamen, mandje-item-namen, sectiekoppen, de titel van de
  zijbalk, enz.) gebruikt gewoon Rubik, met oranje toegestaan als kleur.
  De eerdere tijdelijke vervanger "Caveat" is hiermee vervallen.
- **Mobielvriendelijkheid** is met de huidige CSS redelijk basaal geregeld
  (tegels/mandje passen zich aan), maar nog niet echt getest/verfijnd op
  telefoonformaat - moet nog een aparte ronde krijgen zodra de rest staat.
  De kalender (zie hieronder) is ook nog niet specifiek op klein scherm
  getest.
- **Datumkeuze is nu een altijd-zichtbare kalender** (maandweergave,
  vorige/volgende-maand-knoppen) i.p.v. een in te klappen datumveld. Dagen
  in het verleden en dagen zonder ENKELE beschikbare activiteit (via
  `GET /api/dagen-beschikbaarheid`) worden grijs/niet-klikbaar getoond. Dit
  kijkt nog niet naar het gekozen aantal personen (dat wordt pas per
  activiteit exact gecheckt) - een dag met bijvoorbeeld maar 1 vrije plek
  ergens telt dus al als "wel beschikbaar".
  - **OPGELOST: tijdzone-bug (verkeerde dag geselecteerd, en de lopende
    maand leek nergens capaciteit te hebben).** De kalender zette dagen om
    naar `YYYY-MM-DD` met `date.toISOString().slice(0,10)`. Dat rekent een
    lokale datum eerst om naar UTC, en met de Nederlandse tijdzone
    (UTC+1/+2) schuift een lokale middernacht dan naar de VORIGE dag
    (bijv. "maandag 16 november" werd `2026-11-15`). Alle datum-naar-tekst
    omzettingen gebruiken nu een nieuwe `ymdLocal()`-helper die met de
    lokale jaar/maand/dag-onderdelen werkt i.p.v. via UTC om te rekenen.
    Dit loste ook (een deel van) het probleem op dat de huidige maand
    (deels al verstreken) leek te laten zien dat er nergens capaciteit was:
    `laadDagenBeschikbaarheid()` vraagt nu bovendien nooit meer
    beschikbaarheid op voor dagen die al voorbij zijn (het `vanaf` wordt
    geclamped op vandaag), en `/api/dagen-beschikbaarheid` geeft een
    fout-status terug (i.p.v. een misleidende lege lijst) als het ophalen
    voor ALLE actieve producten mislukt - de kalender grijst dan bewust
    niets ("fail-open") i.p.v. per ongeluk elke dag te blokkeren.
  - **Trager laden van een nieuwe maand:** een hele maand beschikbaarheid
    per product opvragen bij Recras kan merkbaar tijd kosten. Naast de
    resultaten per maand cachen (zoals al gebeurde) haalt de kalender nu ook
    steeds de vorige/volgende maand alvast op de achtergrond op zodra een
    maand getoond is (`prefetchBuurmaanden()`), zodat doorklikken meestal al
    uit de cache komt in plaats van te moeten wachten.
- **Eigen pop-up en tooltip i.p.v. de browser-standaard.** De
  bevestigingsvraag bij het oplossen van een tijd-conflict en de melding bij
  een niet meer beschikbaar tijdstip gebruiken nu een eigen modal in
  FEC-huisstijl (`toonBevestiging()`/`toonMelding()` in `public/index.html`)
  in plaats van `confirm()`/`alert()`. De hover-uitleg bij een rood
  conflict-tijdstip is een eigen CSS-"spraakballonnetje" (`data-tooltip` +
  `::after`/`::before`) in plaats van de standaard browser-tooltip.
- **OPGELOST: tijdstip-knoppen sprongen van breedte** (verspringende layout
  al naargelang de lengte van de capaciteitstekst). `.slot` heeft nu een
  vaste `width: 108px` i.p.v. een `min-width` die met de inhoud meegroeide.
- **OPGELOST: klikken op "OK" bij een tijd-conflict voegde de nieuwe
  activiteit niet toe.** Na het bevestigen dat de conflicterende activiteit
  verwijderd wordt, stuurde de code de klant naar de VERWIJDERDE activiteit
  om die opnieuw in te plannen - de oorspronkelijk gekozen activiteit/tijd
  (waar de klant net op geklikt had) werd daarbij nooit toegevoegd.
  `klikOpConflictSlot()` rondt nu, na het verwijderen van de conflicterende
  activiteit(en), de oorspronkelijke actie gewoon af: bij een los moment
  wordt de nieuwe activiteit direct toegevoegd, bij een gesplitste boeking
  gaat het vervolgschema gewoon verder vanaf het gekozen startmoment.
- **OPGELOST: het boekingsoverzicht (zijbalk) stond te ver naar onderen.**
  `.layout` had `flex-wrap: wrap-reverse` staan (waarschijnlijk ooit bedoeld
  om de zijbalk op mobiel bovenaan te tonen) - dit blijkt ook de betekenis
  van `align-items: flex-start` om te draaien (bij `wrap-reverse` betekent
  "flex-start" de ONDERKANT van de kruisas, niet de bovenkant), waardoor de
  zijbalk zich aan de onderkant van de (veel langere) activiteitenkolom
  uitlijnde in plaats van de bovenkant. Nu staat dit gewoon op
  `flex-wrap: wrap`, waarmee de zijbalk weer normaal bovenaan begint en
  vervolgens (dankzij `position: sticky; top: 24px`) netjes vlak onder de
  bovenrand van het scherm blijft hangen terwijl je door de activiteitenlijst
  scrolt, en meescrollt zodra het einde van die lijst in beeld komt.
- **Meertaligheid (DE/EN)** komt later; er is nog geen voorbereiding voor
  vertaalde teksten in de code.
- Annuleren/wijzigen na het boeken, bevestigingsmails en een intern
  boekingenoverzicht zijn **bewust niet gebouwd**: dat loopt straks via
  Recras' eigen klantportaal, Recras' e-mailinstellingen, en de normale
  Recras-agenda.

## Een geleerde les: hoe Recras' "begin"/"eind" bij beschikbaarheid werkt

Bij `GET /api2/producten/{id}/beschikbaarheid` is `begin` exclusief en `eind`
inclusief - maar "inclusief" betekent hier **inclusief het exacte tijdstip
00:00:00 van die datum**, niet "tot en met het einde van die dag". Om alle
momenten OP een gekozen dag op te vragen, gebruik je dus:

```
begin = de gekozen dag zelf       (bijv. 2026-10-01)
eind  = de dag ERNA                (bijv. 2026-10-02)
```

Deze functie zit in `dagBereik()` in `server.js`.

## API-routes van deze server

- `GET /api/producten` - actieve activiteiten incl. live prijs
- `GET /api/dagen-beschikbaarheid?vanaf=&tot=` - per dag in een bereik of er ÜBERHAUPT iets boekbaar is (voor de kalender op stap 1); `tot` is exclusief, net als bij beschikbaarheid
- `POST /api/mandje/instellen` `{aantal, datum, mandjeId?}` - start/wijzigt het bezoek
- `GET /api/mandje/:mandjeId` - huidige mandje-inhoud + totaalprijs
- `GET /api/activiteit/:slug/plan?mandjeId=&aantal=` - planningsvoorstel, overlap-aware
- `GET /api/activiteit/:slug/plan-vervolg?mandjeId=&aantal=&start=` - vervolgschema bij splitsing
- `POST /api/mandje/:mandjeId/toevoegen` `{slug, aantal, groepen}` - activiteit aan mandje toevoegen
- `DELETE /api/mandje/:mandjeId/items/:itemId` - activiteit uit mandje verwijderen
- `POST /api/mandje/:mandjeId/boeken` `{klant, bijzonderheden}` - herverifieert alles en maakt de Recras-boeking

## Relevante Recras API-referenties

- Beschikbaarheid: `GET /api2/producten/{id}/beschikbaarheid`
- Product ophalen (prijs): `GET /api2/producten/{id}`
- Klant aanmaken/matchen: `POST /api2/klanten`
- Boeking aanmaken/bijwerken: `POST /api2/boekingen`, `PUT /api2/boekingen/{id}`
- Alpha bookprocess-flow (voor later): `/bookprocesses/book`
