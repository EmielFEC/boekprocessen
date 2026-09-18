# Testboekproces voor Recras (Springkussen)

Een minimale, werkende opzet voor een eigen boekproces bovenop de Recras API,
losstaand van de standaard Recras-widget. Bedoeld als eerste stap richting
een schaalbaar, custom boeksysteem voor de FEC-website.

## Wat dit doet

1. Leest beschikbaarheid (startmomenten + capaciteit) van een product uit via
   `GET /api2/producten/{id}/beschikbaarheid`.
2. Laat een bezoeker een tijdstip en zijn gegevens invullen.
3. Zoekt of maakt een klant aan via `POST /api2/klanten` (Recras dedupliceert
   zelf op naam + e-mailadres: 201 = nieuwe klant, 200 = samengevoegd met
   bestaande klant).
4. Maakt de boeking aan via `POST /api2/boekingen`.

Dit is bewust nog geen "echt" boekproces via de `bookprocesses/book`
Alpha-API (met de form/recap/links-structuur) - dat is stap 2. Deze opzet
praat rechtstreeks tegen de kern-endpoints, wat voor een los product zoals
Springkussen prima werkt en makkelijker te doorgronden is als eerste test.

## Structuur

```
recras-boekproces/
  server.js       Express-server met de API-routes
  recras.js       Alle communicatie met de Recras API (1 plek, herbruikbaar)
  products.json   Koppeling tussen jouw "slugs" en Recras product-ids
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
  "book_process_id": null
}
```

De slug (`lasergame`) is wat je in de URL en de frontend gebruikt.

## Wat nog ontbreekt richting een schaalbaar systeem

Dit prototype dekt het gelukkige pad voor één los product. Voor productie op
de FEC-website (of een subsite) is minstens dit nog nodig:

- **Groep-splitsing bij overboeking.** Recras zelf heeft dit niet ingebouwd
  (het weigert simpelweg boven capaciteit). De logica om bijvoorbeeld 30
  personen op lasergame (capaciteit 20) te splitsen in twee groepen van 15
  met een voorgesteld tijdschema, moet in deze laag gebouwd worden: kijk naar
  de bestaande bowling-baantoewijzingstool voor het soort algoritme
  (grootste eerst, capaciteit per tijdslot, compact plannen).
- **Race conditions.** Twee gelijktijdige boekingen op hetzelfde tijdslot
  kunnen elkaar nu nog inhalen. Een tijdelijke "hold" op een tijdslot terwijl
  iemand het formulier afrondt is nodig voordat dit live gaat.
- **Prijsweergave.** Deze opzet toont nog geen prijs. De `validate`-stap uit
  de bookprocess-API (of de prijsvelden van het product zelf) kan hiervoor
  gebruikt worden, zodat de weergegeven prijs altijd matcht met Recras.
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

## Relevante Recras API-referenties

- Beschikbaarheid: `GET /api2/producten/{id}/beschikbaarheid`
- Klant aanmaken/matchen: `POST /api2/klanten`
- Boeking aanmaken: `POST /api2/boekingen`
- Alpha bookprocess-flow (voor later): `/bookprocesses/book`
