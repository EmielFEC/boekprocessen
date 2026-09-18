require('dotenv').config();

const express = require('express');
const path = require('path');
const products = require('./products.json');
const recras = require('./recras');

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

// Boeking aanmaken: POST /api/boeking
// body: { slug, begin, aantal, klant: { voornaam, achternaam, email, telefoon }, locatie_id? }
app.post('/api/boeking', async (req, res) => {
  const { slug, begin, aantal, klant, bijzonderheden } = req.body || {};

  const product = getProduct(slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  if (!begin || !aantal || !klant || !klant.email || !klant.achternaam) {
    return res.status(400).json({
      error:
        'Verplichte velden ontbreken: begin, aantal, klant.voornaam, klant.achternaam, klant.email',
    });
  }

  try {
    // Stap 1: klant zoeken/aanmaken. Recras dedupliceert zelf op naam + e-mail.
    const { klant: klantData, nieuweKlant } = await recras.vindOfMaakKlant(klant);

    // Stap 2: boeking aanmaken voor het gekozen product en tijdstip.
    const boeking = await recras.maakBoeking({
      klant_id: klantData.id,
      product_id: product.product_id,
      book_process_id: product.book_process_id,
      begin,
      aantal,
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
