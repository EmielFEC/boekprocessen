# Testboekproces voor Recras (Springkussen)

Een minimale, werkende opzet voor een eigen boekproces bovenop de Recras API,
losstaand van de standaard Recras-widget. Bedoeld als eerste stap richting
een schaalbaar, custom boeksysteem voor de FEC-website.

## Wat dit doet

1. Bezoeker kiest eerst de activiteit en het **aantal personen**.
2. De server leest beschikbaarheid (startmomenten + capaciteit) van dat
   product uit via `GET /api2/producten/{id}/beschikbaarheid` voor de
   gekozen dag, en berekent een boekingsvoorstel:
   - Past de groep in 1 moment? Dan kiest de bezoeker gewoon een tijd, zoals
     bij een normale boeking.
   - Is de groep te groot voor 1 moment (bijv. 22 personen op een activiteit
     met capaciteit 10)? Dan wordt eerst berekend hoe de groep **zo gelijk
     mogelijk verdeeld** wordt (bijv. 8 + 7 + 7), en kiest de bezoeker zelf de
     starttijd van de **eerste** subgroep. Daarna berekent de server
     automatisch het optimale (zo aansluitend mogelijke) vervolgschema voor
     de overige subgroepen, te bevestigen door de bezoeker (zie `planning.js`,
     functies `planBoeking` en `planVervolgSchema`).
3. De zijbalk toont continu een boekingsoverzicht: activiteit, aantal,
   prijsindicatie en - zodra bekend - de voorgestelde tijd(en) per (sub)groep.
4. Bij bevestigen: zoekt of maakt een klant aan via `POST /api2/klanten`
   (Recras dedupliceert zelf op naam + e-mailadres: 201 = nieuwe klant, 200 =
   samengevoegd met bestaande klant). Daarna wordt er **1 boeking** aangemaakt
   met **1 boekingsregel per (sub)groep**, niet meerdere losse boekingen:
   - Eerst een normale `POST /api2/boekingen` voor de eerste subgroep (dit
     levert de boeking en zijn eerste boekingsregel op).
   - Daarna, alleen als er gesplitst is, een `PUT /api2/boekingen/{id}` die
     die eerste regel corrigeert naar de juiste tijd/aantal en de overige
     subgroepen als extra boekingsregels toevoegt. Elke regel krijgt een
     `opmerking` als "Subgroep 2 van 3 (automatisch gesplitst wegens
     groepsgrootte)" zodat het voor de vloer duidelijk is waarom er meerdere
     regels bij 1 boeking staan.
   - Zie `recras.js` (`maakGesplitsteBoeking`) voor de exacte implementatie.

Dit is bewust nog geen "echt" boekproces via de `bookprocesses/book`
Alpha-API (met de form/recap/links-structuur) - dat is stap 2. Deze opzet
praat rechtstreeks tegen de kern-endpoints, wat voor een los product zoals
Springkussen prima werkt en makkelijker te doorgronden is als eerste test.

## Structuur

```
recras-boekproces/
  server.js       Express-server met de API-routes
  recras.js       Alle communicatie met de Recras API (1 plek, herbruikbaar)
  planning.js     Groep-splitsingslogica (los te testen, geen Recras-calls)
  products.json   Koppeling tussen jouw "slugs" en Recras product-ids/prijzen
  public/
    index.html    Testpagina (vanilla HTML/JS, geen framework)
  .env.example    Voorbeeldconfiguratie (kopieer naar .env)
```

## Draaien (zonder installaties op je eigen computer)

Geen adminrechten nodig: dit hele traject verloopt via je browser, met gratis
accounts bij GitHub en Render.com. Dit is bovendien meteen de manier waarop
dit straks ook echt live komt te staan, dus dit is geen weggegooid werk.

### Stap 1: code op GitHub zetten

1. Maak (als je die nog niet hebt) een gratis account op [github.com](https://github.com).
2. Klik rechtsboven op **+** > **New repository**. Geef hem een naam, bijv.
   `recras-boekproces`. Laat "Public" of "Private" staan naar keuze (Private
   kan geen kwaad, maar is niet strikt nodig). Klik **Create repository**.
3. Op de nieuwe, lege repository-pagina: klik **uploading an existing file**
   (of ga naar **Add file > Upload files**).
4. Pak de ZIP die je van mij kreeg uit op je computer. Sleep de **inhoud**
   van die map (dus `server.js`, `recras.js`, `products.json`, de map
   `public`, `package.json`, `package-lock.json`, `README.md`, `.gitignore`,
   `.env.example`) in het uploadvlak. **Upload `.env` NIET** (die zit sowieso
   niet in de ZIP, en moet ook nooit op GitHub komen als je hem later zelf
   maakt).
5. Klik onderaan **Commit changes**.

### Stap 2: hosten op Render.com

1. Maak een gratis account op [render.com](https://render.com), bij voorkeur
   door in te loggen met je GitHub-account (dat scheelt een koppelstap).
2. Klik **New > Web Service**.
3. Kies je zojuist aangemaakte GitHub-repository (`recras-boekproces`).
4. Vul in:
   - **Name**: iets herkenbaars, bijv. `fec-testboekproces`
   - **Region**: Frankfurt (dichtstbij)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Scroll naar **Environment Variables** en voeg toe:
   - `RECRAS_HOST` = `fecsevenum.recras.nl`
   - `RECRAS_TOKEN` = je echte Recras API-token
   - (laat `PORT` weg, Render regelt die zelf)
6. Klik **Create Web Service**. Render installeert en start de app; dit
   duurt de eerste keer 1 tot 2 minuten. Je krijgt een URL zoals
   `https://fec-testboekproces.onrender.com`.
7. Open die URL: dit is dezelfde testpagina als lokaal, maar nu overal
   bereikbaar, ook door collega's.

**Let op (gratis Render-tier)**: een gratis "Web Service" gaat na een periode
van inactiviteit in slaap en heeft dan ~30-50 seconden nodig om weer wakker
te worden bij de eerstvolgende bezoeker. Voor testen is dat geen probleem;
voor de uiteindelijke live website upgrade je naar een betaald plan (vanaf
enkele euro's per maand) zodat hij altijd direct reageert.

### Wijzigingen doorvoeren

Iedere keer dat je een bestand aanpast: upload het opnieuw via **Add file >
Upload files** op GitHub (of leer `git` gebruiken als je dat prettiger
vindt), commit de wijziging, en Render deployt automatisch de nieuwe versie.

## Nieuwe producten toevoegen

Voeg een regel toe aan `products.json`, geen code nodig:

```json
"lasergame": {
  "product_id": 1234,
  "naam": "Lasergame",
  "duur_minuten": 30,
  "locatie_id": null,
  "book_process_id": null,
  "prijs_per_persoon": 12.5
}
```

De slug (`lasergame`) is wat je in de URL en de frontend gebruikt.
`prijs_per_persoon` is puur voor de prijsindicatie in de zijbalk (zie
hieronder waarom dit nog handmatig is) en mag weggelaten worden.

## Hoe de groep-splitsing werkt (en de aannames erachter)

De logica zit in `planning.js`, los van de Recras-communicatie, zodat je 'm
kunt lezen en testen zonder een echte API-verbinding nodig te hebben.

1. De server haalt alle startmomenten van de gekozen dag op, met per moment
   de beschikbare capaciteit.
2. **Volledige capaciteit per moment** wordt afgeleid als de hoogste
   beschikbaarheid die die dag ergens gezien wordt. Dit is een aanname: als
   op de gekozen dag toevallig ieder moment al deels volgeboekt is, wordt de
   werkelijke volledige capaciteit onderschat. Voor een preciezere aanpak zou
   je dit getal per product apart moeten vastleggen (net als
   `prijs_per_persoon` in `products.json`) in plaats van het af te leiden.
3. Past de groep in 1 moment? Dan krijgt de bezoeker gewoon een keuze uit alle
   momenten die groot genoeg zijn (`planBoeking` geeft `status: 'enkel'`).
4. Past de groep niet in 1 moment? Dan wordt het aantal benodigde groepen
   berekend (`Math.ceil(aantal / capaciteit)`) en het aantal personen zo
   gelijk mogelijk verdeeld (bijv. 22 bij capaciteit 10 -> 8 + 7 + 7)
   (`planBoeking` geeft dan `status: 'kies_starttijd'` plus de mogelijke
   starttijden voor de EERSTE subgroep).
5. De bezoeker kiest zelf de starttijd van groep 1. Op basis daarvan berekent
   `planVervolgSchema` het vervolgschema: elke volgende subgroep krijgt het
   eerstvolgende moment ná het gekozen startmoment dat groot genoeg is. Dit
   hoeven **niet per se aaneengesloten tijden** te zijn (als een
   tussenliggend moment toevallig al te vol zit, wordt die overgeslagen) -
   voor de meeste dagen met normale bezetting geeft dit gewoon nette
   opeenvolgende tijden.
6. Past het daarna niet meer (te weinig momenten ná de gekozen starttijd),
   dan krijgt de bezoeker een duidelijke melding en kan die een andere
   starttijd voor groep 1 kiezen, in plaats van een gedeeltelijk voorstel.

Wat dit (bewust) nog niet doet: rekening houden met personeelsbezetting,
sluitingstijden versus laatste startmoment, of een voorkeur voor "zo vroeg
mogelijk op een dag" versus "zo aaneengesloten mogelijk". Dat zijn keuzes die
je het beste maakt nadat je met échte Recras-data hebt getest hoe de
startmomenten er in de praktijk uitzien.

## Wat nog ontbreekt richting een schaalbaar systeem

Dit prototype dekt inmiddels het gelukkige pad inclusief groep-splitsing voor
één los product. Voor productie op de FEC-website (of een subsite) is
minstens dit nog nodig:

- **De boeking-met-meerdere-regels flow is nog niet getest tegen echte
  Recras-data.** De aanpak in `maakGesplitsteBoeking` volgt de Recras-
  documentatie zo precies mogelijk (een nieuwe boekingsregel toevoegen via
  een `PUT` genereert automatisch de bijbehorende kostenregel, aldus de
  docs), maar dit is de meest onzekere plek in deze opzet. **Test dit als
  eerste** zodra je een echte token hebt: boek een groep van bijvoorbeeld 15
  personen en controleer in Recras zelf of de boeking er correct uitziet
  (juiste aantallen per regel, juiste totaalprijs, geen dubbele of
  ontbrekende kostenregels). Krijg je een foutmelding, dan toont het
  testscherm de ruwe Recras-foutmelding (`details` in de JSON-respons),
  stuur die door dan zoeken we het gericht uit.
- **Race conditions.** Tussen het tonen van een voorstel (of vervolgschema)
  en het bevestigen ervan kan iemand anders een van die momenten alsnog
  volboeken - `planVervolgSchema` checkt alleen of het gekozen moment van
  groep 1 op dat moment nog past, niet de vervolgmomenten. Een tijdelijke
  "hold" op een tijdslot terwijl iemand het formulier afrondt is nodig
  voordat dit live gaat, zeker bij een gesplitste groep met meerdere
  momenten tegelijk.
- **Prijsweergave is nog een indicatie.** De prijs komt nu uit het handmatig
  ingevulde `prijs_per_persoon` in `products.json`, niet rechtstreeks uit
  Recras. Zodra een product complexere prijsregels heeft (staffels, dynamic
  pricing, kortingen), klopt dit getal niet meer. De `validate`-stap uit de
  bookprocess-API (of de prijsvelden van het product zelf via de Products-
  endpoint) kan dit later vervangen door een altijd kloppend bedrag.
- **Validatie en foutafhandeling richting de klant.** Nu worden Recras-
  foutmeldingen ruw doorgegeven; voor een klantgerichte site wil je dit
  vertalen naar begrijpelijke Nederlandse meldingen.
- **Beveiliging.** De Recras-token staat nu alleen server-side (goed), maar
  er is nog geen rate limiting, CORS-beleid of bescherming tegen misbruik van
  het boekingsformulier.
- **Deployment.** Dit draait nu lokaal. Voor de website heb je een hosting-
  omgeving nodig (bijv. een kleine Node-hosting, of dit inbedden als
  serverless functions), plus een manier om het in WordPress of een subsite
  te embedden (iframe of los uitgeserveerde pagina/widget).
- **Meerdere producten per boeking / bookprocess-achtige flows** (bijv. eerst
  activiteit kiezen, dan extra's zoals eten): dat vraagt om de stap-voor-stap
  `bookprocesses/book` API in plaats van deze rechtstreekse aanpak, of een
  eigen stappen-wizard die meerdere `boekingsregels` in één boeking bundelt.

## Een geleerde les: hoe Recras' "begin"/"eind" bij beschikbaarheid werkt

Bij `GET /api2/producten/{id}/beschikbaarheid` is `begin` exclusief en `eind`
inclusief - maar "inclusief" betekent hier **inclusief het exacte tijdstip
00:00:00 van die datum**, niet "tot en met het einde van die dag". Om alle
momenten OP een gekozen dag (bijv. 09:00-17:00) op te vragen, gebruik je dus:

```
begin = de gekozen dag zelf       (bijv. 2026-10-01)
eind  = de dag ERNA                (bijv. 2026-10-02)
```

Niet `begin = dag ervoor, eind = de gekozen dag` (dat lijkt logischer gezien
de exclusief/inclusief-namen, maar levert een lege lijst op voor de gekozen
dag zelf). Deze functie zit nu correct in `dagBereik()` in `server.js`.

## API-routes van deze server (voor eigen gebruik/uitbreiding)

- `GET /api/producten` - lijst van geconfigureerde activiteiten
- `GET /api/plan/:slug?datum=YYYY-MM-DD&aantal=N` - stap 1: `enkel` (kies een tijd), `kies_starttijd` (kies de starttijd van groep 1), of `onmogelijk`
- `GET /api/plan-vervolg/:slug?datum=&aantal=&start=<ISO-startmoment>` - stap 2 (alleen bij `kies_starttijd`): berekent het vervolgschema voor de overige subgroepen
- `POST /api/boeking-groep` - maakt de boeking aan op basis van het bevestigde voorstel (1 of meerdere `groepen`)

## Relevante Recras API-referenties

- Beschikbaarheid: `GET /api2/producten/{id}/beschikbaarheid`
- Klant aanmaken/matchen: `POST /api2/klanten`
- Boeking aanmaken: `POST /api2/boekingen`
- Alpha bookprocess-flow (voor later): `/bookprocesses/book`
