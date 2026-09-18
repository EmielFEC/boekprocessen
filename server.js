require('dotenv').config();

const express = require('express');
const path = require('path');
const products = require('./products.json');
const recras = require('./recras');
const { planBoeking } = require('./planning');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Kleine helper: zoek een product op aan de hand van zijn slug uit products.json.
function getProduct(slug) {
  const product = products[slug];
  if (!product || slug === '_comment') return null;
  return product;
}

// Lijst van beschikbare producten/activiteiten voor de frontend (dropdown, etc.)
app.get('/api/producten', (req, res) => {
  const lijst = Object.entries(products)
    .filter(([slug]) => slug !== '_comment')
    .map(([slug, p]) => ({
      slug,
      naam: p.naam,
      duur_minuten: p.duur_minuten,
      prijs_per_persoon: p.prijs_per_persoon ?? null,
    }));
  res.json(lijst);
});

// Beschikbaarheid van een product opvragen: GET /api/beschikbaarheid/springkussen?begin=2026-09-18&eind=2026-09-25
app.get('/api/beschikbaarheid/:slug', async (req, res) => {
  const product = getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  const { begin, eind } = req.query;
  if (!eind) {
    return res.status(400).json({ error: 'Query parameter "eind" is verplicht' });
  }

  try {
    const beschikbaarheid = await recras.getBeschikbaarheid(
      product.product_id,
      begin,
      eind
    );
    res.json(beschikbaarheid);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: 'Kon beschikbaarheid niet ophalen',
      details: err.details,
    });
  }
});

// Planning opvragen: GET /api/plan/springkussen?datum=2026-10-01&aantal=15
// Geeft een boekingsvoorstel terug: 1 moment (als de groep past) of een
// verdeling over meerdere momenten (als de groep te groot is voor 1 moment).
app.get('/api/plan/:slug', async (req, res) => {
  const product = getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  const { datum } = req.query;
  const aantal = parseInt(req.query.aantal, 10);

  if (!datum || !aantal || aantal < 1) {
    return res.status(400).json({
      error: 'Query parameters "datum" (YYYY-MM-DD) en "aantal" (>=1) zijn verplicht',
    });
  }

  // "eind" is exclusief in de vraag hierboven aan de gebruiker, maar Recras'
  // "eind" parameter is inclusief en "begin" exclusief - daarom vragen we de
  // dag zelf tot en met de dag zelf op, met begin op de dag ervoor.
  const vorigeDag = new Date(`${datum}T00:00:00Z`);
  vorigeDag.setUTCDate(vorigeDag.getUTCDate() - 1);
  const begin = vorigeDag.toISOString().slice(0, 10);

  try {
    const momenten = await recras.getBeschikbaarheid(product.product_id, begin, datum);
    const plan = planBoeking(momenten, aantal);

    const prijs_per_persoon = product.prijs_per_persoon ?? null;
    const totale_prijs = prijs_per_persoon != null ? prijs_per_persoon * aantal : null;

    res.json({
      slug: req.params.slug,
      naam: product.naam,
      aantal,
      prijs_per_persoon,
      totale_prijs,
      plan,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: 'Kon planning niet berekenen',
      details: err.details,
    });
  }
});

// Boeking(en) aanmaken: POST /api/boeking-groep
// body: {
//   slug, klant: { voornaam, achternaam, email, telefoon }, bijzonderheden,
//   groepen: [{ aantal, begin }, ...]   // 1 entry = normale boeking, >1 = gesplitste groep
// }
app.post('/api/boeking-groep', async (req, res) => {
  const { slug, klant, groepen, bijzonderheden } = req.body || {};

  const product = getProduct(slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  // Accepteer zowel "begin" als "startmoment" als veldnaam voor het tijdstip,
  // zodat de rechtstreekse output van GET /api/plan (dat "startmoment"
  // gebruikt, dezelfde naam als de Recras-beschikbaarheids-API) meteen
  // doorgestuurd kan worden zonder eerst te hoeven ombouwen.
  const genormaliseerdeGroepen = Array.isArray(groepen)
    ? groepen.map((g) => ({ aantal: g.aantal, begin: g.begin || g.startmoment }))
    : [];

  if (
    !klant || !klant.email || !klant.achternaam ||
    genormaliseerdeGroepen.length === 0 ||
    genormaliseerdeGroepen.some((g) => !g.begin || !g.aantal)
  ) {
    return res.status(400).json({
      error:
        'Verplichte velden ontbreken: klant.voornaam, klant.achternaam, klant.email, en groepen (array met {aantal, begin of startmoment})',
    });
  }

  try {
    // Klant eenmalig zoeken/aanmaken. Recras dedupliceert zelf op naam + e-mail.
    const { klant: klantData, nieuweKlant } = await recras.vindOfMaakKlant(klant);

    // 1 groep = gewone boeking met 1 boekingsregel. Meerdere groepen = EEN
    // boeking met meerdere boekingsregels (1 per subgroep), niet meerdere
    // losse boekingen.
    const boeking =
      genormaliseerdeGroepen.length === 1
        ? await recras.maakBoeking({
            klant_id: klantData.id,
            product_id: product.product_id,
            book_process_id: product.book_process_id,
            begin: genormaliseerdeGroepen[0].begin,
            aantal: genormaliseerdeGroepen[0].aantal,
            bijzonderheden,
          })
        : await recras.maakGesplitsteBoeking({
            klant_id: klantData.id,
            product_id: product.product_id,
            book_process_id: product.book_process_id,
            duur_minuten: product.duur_minuten,
            groepen: genormaliseerdeGroepen,
            bijzonderheden,
          });

    res.status(201).json({ boeking, klant: klantData, nieuweKlant });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: 'Kon boeking niet aanmaken',
      details: err.details,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Testboekproces draait op http://localhost:${PORT}`);
});
