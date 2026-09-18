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
   - **Max-fill/greedy verdelen** (`verdeelGreedy()`) voor activiteiten die
     per fysieke eenheid geboekt worden (Bowling, X-Cube, Fun Curling,
     X-Wall): elk moment wordt zoveel mogelijk gevuld voordat er een nieuw
     moment bij gepakt wordt (bijv. X-Cube, capaciteit 12 p. per moment: 18
     -> [12, 6], 19 -> [12, 7]) - dit voorkomt dat een groep onnodig meer
     eenheden (en dus meer banen/cubes) nodig heeft dan strikt nodig is.
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
   voor Bowling) of `'per_persoon'` (standaard). Bij `'per_eenheid'`
   rekent de server de prijs per subgroep uit als (naar boven afgeronde)
   aantal eenheden × prijs, en telt dat per subgroep op - dus een gesplitste
   groep kan in totaal meer eenheden kosten dan een ongesplitste, omdat elke
   subgroep apart afgerond wordt.

## Open punten (moet nog live geverifieerd/aangevuld worden)

- **"Game Area" heeft nog geen Recras product-ID.** Staat in
  `products.json` op `actief: false` met een `_todo`-veld. Zodra bekend is
  welk product dit is (en of het tijdgebonden is met een startmomentgroep,
  of bijv. per token werkt) kan dit aangezet worden.
- **Prijs-veldnaam nog niet bevestigd.** `haalPrijsPerPersoon()` in
  `recras.js` probeert een aantal waarschijnlijke veldnamen
  (`verkoopprijs`, `prijs`, etc.) op de Recras-productrespons. Geeft de
  activiteitenpagina "prijs kon niet opgehaald worden" voor een product,
  stuur dan de `details` uit de foutmelding door, dan passen we het juiste
  veld aan.
- **"Eenheden i.p.v. personen"-aanname bij Bowling** is gecorrigeerd naar
  aanleiding van live gedrag (10 personen werd onterecht over tijd gesplitst
  i.p.v. 2 banen tegelijk te boeken) maar nog niet 1-op-1 bevestigd met de
  ruwe Recras-respons. Gebruik `GET /api/debug/beschikbaarheid/bowling?datum=...`
  (tijdelijke debug-route) om te controleren of het "beschikbaarheid"-getal
  inderdaad rond het aantal banen ligt. **X-Cube** is nu ook op deze manier
  geconfigureerd (`per_eenheid_personen: 6`, max. 2 cubes) - nog niet
  live geverifieerd met echte data, gebruik dezelfde debug-route met
  `x-cube-30`/`x-cube-60`.
- **Fun Curling en X-Wall: per persoon of per baan/sessie afgerekend?**
  Voor Bowling is bevestigd dat dit per baan is (`prijs_type: 'per_eenheid'`
  in `products.json`). Voor Fun Curling en X-Wall staat dit nog op
  `'per_persoon'` met een `_prijs_type_todo`-veld - moet nog bevestigd
  worden.
- **X-Wall staat op `aantalbepaling: vast`** in Recras (i.p.v.
  `boekingsgrootte` zoals de rest) - de betekenis van "per 8 personen"
  hierbij is nog niet geverifieerd.
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
- **Huisstijl toegepast, maar niet compleet.** Kleuren (paars `#2c1d49`,
  oranje `#f39313`, beige `#f2ede7`) en het lettertype Rubik (via Google
  Fonts) zitten er nu in. Het handschrift-achtige weergavelettertype
  "Mascot MVB" uit de screenshot is een eigen/betaald font en dus niet via
  Google Fonts te laden - stuur het font-bestand (.woff2/.otf/.ttf) door als
  je dat ook in dit boekproces wilt gebruiken (bijv. voor koppen), dan voeg
  ik het toe via `@font-face`.
- **Mobielvriendelijkheid** is met de huidige CSS redelijk basaal geregeld
  (tegels/mandje passen zich aan), maar nog niet echt getest/verfijnd op
  telefoonformaat - moet nog een aparte ronde krijgen zodra de rest staat.
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
