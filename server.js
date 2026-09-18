require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const products = require('./products.json');
const recras = require('./recras');
const {
  planBoeking,
  planVervolgSchema,
  berekenBenodigdeEenheden,
  filterOverlap,
} = require('./planning');

// Maximale groepsgrootte voor dit boekproces (bevestigd door Emiel).
const MAX_GROEPSGROOTTE = 25;

// Prijs voor 1 activiteit-item berekenen, afhankelijk van `prijs_type`:
// 'per_persoon' (standaard) = prijsBasis x aantal personen.
// 'per_eenheid' (bijv. Bowling: prijs per baan) = prijsBasis x aantal
// benodigde eenheden (banen), per subgroep apart afgerond naar boven.
// `groepenOfAantal` is ofwel een enkel aantal (indicatie, nog geen exacte
// subgroepen bekend) of een array van {aantal} (exacte subgroepen).
function berekenSubtotaal(product, prijsBasis, groepenOfAantal) {
  if (prijsBasis == null) return null;
  if (product.prijs_type === 'per_eenheid') {
    const groepen = Array.isArray(groepenOfAantal) ? groepenOfAantal : [{ aantal: groepenOfAantal }];
    return groepen.reduce(
      (som, g) => som + berekenBenodigdeEenheden(g.aantal, product.per_eenheid_personen) * prijsBasis,
      0
    );
  }
  const totaalAantal = Array.isArray(groepenOfAantal)
    ? groepenOfAantal.reduce((som, g) => som + g.aantal, 0)
    : groepenOfAantal;
  return totaalAantal * prijsBasis;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Producten
// ---------------------------------------------------------------------------

function getProduct(slug) {
  const product = products[slug];
  if (!product || slug.startsWith('_')) return null;
  return product;
}

// Recras' "eind" is inclusief tot precies 00:00:00 van die datum, niet tot
// en met het einde van die dag. Om alle momenten OP de gekozen dag te pakken
// (bijv. 09:00-17:00) gebruik je dus begin = de dag zelf en eind = de dag
// erna.
function dagBereik(datum) {
  const volgendeDag = new Date(`${datum}T00:00:00Z`);
  volgendeDag.setUTCDate(volgendeDag.getUTCDate() + 1);
  return { begin: datum, eind: volgendeDag.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Mandje (winkelmandje) - in-memory. Geen echte "hold" op Recras-capaciteit
// (dat kan Recras niet); we controleren beschikbaarheid opnieuw op elk
// belangrijk moment (toevoegen, en nogmaals vlak voor boeken). Een mandje
// dat lang niet gebruikt is, wordt automatisch opgeruimd.
// ---------------------------------------------------------------------------

const mandjes = new Map();
const MANDJE_TTL_MS = 45 * 60 * 1000; // 45 minuten inactiviteit

function nieuwMandje(aantal, datum) {
  return {
    aantal,
    datum,
    items: [],
    laatstActief: Date.now(),
  };
}

function haalMandje(mandjeId) {
  if (!mandjeId) return null;
  const mandje = mandjes.get(mandjeId);
  if (!mandje) return null;
  if (Date.now() - mandje.laatstActief > MANDJE_TTL_MS) {
    mandjes.delete(mandjeId);
    return null;
  }
  return mandje;
}

function raakMandjeAan(mandje) {
  mandje.laatstActief = Date.now();
}

function berekenTotaal(mandje) {
  return mandje.items.reduce((som, item) => som + (item.subtotaal || 0), 0);
}

function mandjeResponse(mandjeId, mandje) {
  return {
    mandjeId,
    aantal: mandje.aantal,
    datum: mandje.datum,
    items: mandje.items,
    totaalPrijs: berekenTotaal(mandje),
  };
}

// Alle reeds in het mandje bezette tijdsintervallen (over alle producten
// heen), zodat een nieuwe activiteit niet kan overlappen. Simplificatie:
// we gaan er (voorlopig) van uit dat de hele bezoekersgroep gelijktijdig
// steeds maar 1 activiteit doet, ook als een deel van de groep die
// activiteit doet ("deelgroep") - zie README voor waarom dit een bewuste
// vereenvoudiging is richting een latere uitbreiding.
function bezetteIntervallen(mandje, exclusiefItemId) {
  const intervallen = [];
  for (const item of mandje.items) {
    if (item.id === exclusiefItemId) continue;
    for (const groep of item.groepen) {
      intervallen.push({ begin: groep.begin, eind: groep.eind });
    }
  }
  return intervallen;
}

async function haalBeschikbareMomenten(product, datum, mandje, exclusiefItemId) {
  const { begin, eind } = dagBereik(datum);
  const ruweMomenten = await recras.getBeschikbaarheid(product.product_id, begin, eind);
  const bezet = bezetteIntervallen(mandje, exclusiefItemId);
  return filterOverlap(ruweMomenten, product.duur_minuten, bezet);
}

// Personen-capaciteit van 1 moment: bij per-baan/tafel-producten (per_eenheid_personen
// > 1) gaan we ervan uit dat Recras 'beschikbaarheid' als aantal vrije EENHEDEN
// (banen) teruggeeft, dus vermenigvuldigen we hiermee (zie planning.js/README).
function personenCapaciteitVoorMoment(moment, product) {
  const eenheden = moment?.locaties?.[0]?.beschikbaarheid ?? 0;
  return eenheden * (product.per_eenheid_personen || 1);
}

// ---------------------------------------------------------------------------
// Producten-lijst (voor de activiteitenpagina)
// ---------------------------------------------------------------------------

app.get('/api/producten', async (req, res) => {
  const lijst = Object.entries(products)
    .filter(([slug, p]) => !slug.startsWith('_') && p.actief && p.product_id)
    .sort((a, b) => (a[1].volgorde || 0) - (b[1].volgorde || 0));

  // Als er een mandje is (aantal + datum al bekend), checken we ook meteen
  // of de activiteit die dag überhaupt nog iets vrij heeft, zodat de
  // activiteitenpagina volgeboekte/niet-beschikbare activiteiten grijs kan
  // tonen in plaats van gewoon een (niet-kloppende) prijs te laten zien.
  const mandje = haalMandje(req.query.mandjeId);

  const resultaat = await Promise.all(
    lijst.map(async ([slug, p]) => {
      let prijs_per_persoon = null;
      let prijs_fout = null;
      try {
        prijs_per_persoon = await recras.haalPrijsPerPersoon(p.product_id);
      } catch (err) {
        prijs_fout = err.message;
        console.error(`[prijs] ${slug} (product ${p.product_id}):`, err.message, err.details ?? '');
      }

      let heeftStartmomenten = null;
      let vandaagVol = null;
      if (mandje) {
        try {
          const momenten = await haalBeschikbareMomenten(p, mandje.datum, mandje);
          heeftStartmomenten = momenten.length > 0;
          vandaagVol = heeftStartmomenten && !momenten.some((m) => personenCapaciteitVoorMoment(m, p) > 0);
        } catch (err) {
          console.error(`[beschikbaarheid overzicht] ${slug}:`, err.message);
        }
      }

      return {
        slug,
        naam: p.naam,
        duur_minuten: p.duur_minuten,
        per_eenheid_personen: p.per_eenheid_personen,
        eenheid_naam: p.eenheid_naam,
        prijs_type: p.prijs_type || 'per_persoon',
        toestaan_deelgroep: p.toestaan_deelgroep,
        prijs_per_persoon,
        prijs_fout,
        heeftStartmomenten,
        vandaagVol,
      };
    })
  );

  res.json(resultaat);
});

// ---------------------------------------------------------------------------
// Mandje instellen (stap 1: aantal personen + datum voor het hele bezoek)
// ---------------------------------------------------------------------------

app.post('/api/mandje/instellen', (req, res) => {
  let { mandjeId, aantal, datum } = req.body || {};
  aantal = parseInt(aantal, 10);

  if (!datum || !aantal || aantal < 1) {
    return res.status(400).json({ error: 'Verplicht: "aantal" (>=1) en "datum" (YYYY-MM-DD)' });
  }
  if (aantal > MAX_GROEPSGROOTTE) {
    return res.status(400).json({ error: `Dit boekproces ondersteunt groepen tot maximaal ${MAX_GROEPSGROOTTE} personen. Neem voor grotere groepen contact op.` });
  }

  let mandje = haalMandje(mandjeId);
  if (!mandje || mandje.aantal !== aantal || mandje.datum !== datum) {
    // Nieuw bezoek (of aantal/datum gewijzigd): mandje leegmaken, want
    // bestaande items horen bij de oude instelling.
    mandjeId = mandjeId || crypto.randomUUID();
    mandje = nieuwMandje(aantal, datum);
    mandjes.set(mandjeId, mandje);
  } else {
    raakMandjeAan(mandje);
  }

  res.json(mandjeResponse(mandjeId, mandje));
});

app.get('/api/mandje/:mandjeId', (req, res) => {
  const mandje = haalMandje(req.params.mandjeId);
  if (!mandje) return res.status(404).json({ error: 'Mandje niet gevonden of verlopen' });
  res.json(mandjeResponse(req.params.mandjeId, mandje));
});

// ---------------------------------------------------------------------------
// Planning per activiteit (rekening houdend met de rest van het mandje)
// ---------------------------------------------------------------------------

app.get('/api/activiteit/:slug/plan', async (req, res) => {
  const product = getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  const mandje = haalMandje(req.query.mandjeId);
  if (!mandje) return res.status(404).json({ error: 'Mandje niet gevonden of verlopen - stel eerst aantal en datum in' });

  let aantal = mandje.aantal;
  if (req.query.aantal != null) {
    const gevraagd = parseInt(req.query.aantal, 10);
    if (!gevraagd || gevraagd < 1) {
      return res.status(400).json({ error: '"aantal" moet >=1 zijn' });
    }
    if (gevraagd > mandje.aantal) {
      return res.status(400).json({ error: `"aantal" kan niet groter zijn dan de totale bezoekersgroep (${mandje.aantal})` });
    }
    if (gevraagd !== mandje.aantal && !product.toestaan_deelgroep) {
      return res.status(400).json({ error: `${product.naam} kan niet door een deel van de groep gedaan worden - vul het volledige aantal (${mandje.aantal}) in` });
    }
    aantal = gevraagd;
  }

  try {
    const momenten = await haalBeschikbareMomenten(product, mandje.datum, mandje);
    const plan = planBoeking(momenten, aantal, product.per_eenheid_personen);
    const benodigdeEenheden = berekenBenodigdeEenheden(aantal, product.per_eenheid_personen);

    let prijs_per_persoon = null;
    try {
      prijs_per_persoon = await recras.haalPrijsPerPersoon(product.product_id);
    } catch (err) {
      // Prijs kon niet opgehaald worden - plannen kan alsnog doorgaan.
    }
    // Indicatie: exacte subgroepen (en dus exacte eenheden bij per-baan-
    // producten) zijn pas bekend na het kiezen van een tijd/vervolgschema.
    const totale_prijs = berekenSubtotaal(product, prijs_per_persoon, aantal);

    res.json({
      slug: req.params.slug,
      naam: product.naam,
      aantal,
      prijs_per_persoon,
      prijs_type: product.prijs_type || 'per_persoon',
      totale_prijs,
      per_eenheid_personen: product.per_eenheid_personen,
      eenheid_naam: product.eenheid_naam,
      benodigdeEenheden,
      plan,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: 'Kon planning niet berekenen', details: err.details });
  }
});

app.get('/api/activiteit/:slug/plan-vervolg', async (req, res) => {
  const product = getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  const mandje = haalMandje(req.query.mandjeId);
  if (!mandje) return res.status(404).json({ error: 'Mandje niet gevonden of verlopen' });

  const aantal = parseInt(req.query.aantal, 10);
  const { start } = req.query;
  if (!aantal || aantal < 1 || !start) {
    return res.status(400).json({ error: 'Query parameters "aantal" en "start" zijn verplicht' });
  }

  try {
    const momenten = await haalBeschikbareMomenten(product, mandje.datum, mandje);

    const stap1 = planBoeking(momenten, aantal, product.per_eenheid_personen);
    if (stap1.status !== 'kies_starttijd') {
      return res.status(400).json({ error: 'Deze groep vereist geen (of geen geldige) starttijdkeuze meer - vraag de planning opnieuw op.' });
    }

    const plan = planVervolgSchema(momenten, stap1.groepsgroottes, start, product.per_eenheid_personen);

    let prijs_per_persoon = null;
    try {
      prijs_per_persoon = await recras.haalPrijsPerPersoon(product.product_id);
    } catch (err) {
      // negeren, prijs is niet blokkerend voor plannen
    }
    // Bij een geslaagd vervolgschema zijn de exacte subgroepen bekend -
    // gebruik die voor een nauwkeurige prijs (belangrijk bij per-eenheid
    // producten, waar elke subgroep apart naar boven afgerond wordt).
    const totale_prijs = berekenSubtotaal(
      product,
      prijs_per_persoon,
      plan.status === 'gesplitst' ? plan.groepen : aantal
    );

    res.json({
      slug: req.params.slug,
      naam: product.naam,
      aantal,
      prijs_per_persoon,
      prijs_type: product.prijs_type || 'per_persoon',
      totale_prijs,
      per_eenheid_personen: product.per_eenheid_personen,
      eenheid_naam: product.eenheid_naam,
      plan,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: 'Kon vervolgschema niet berekenen', details: err.details });
  }
});

// ---------------------------------------------------------------------------
// Item toevoegen aan / verwijderen uit het mandje
// ---------------------------------------------------------------------------

app.post('/api/mandje/:mandjeId/toevoegen', async (req, res) => {
  const mandje = haalMandje(req.params.mandjeId);
  if (!mandje) return res.status(404).json({ error: 'Mandje niet gevonden of verlopen' });

  const { slug, aantal, groepen } = req.body || {};
  const product = getProduct(slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });

  const gevraagdAantal = parseInt(aantal, 10);
  if (!gevraagdAantal || gevraagdAantal < 1) {
    return res.status(400).json({ error: '"aantal" is verplicht en moet >=1 zijn' });
  }
  if (gevraagdAantal > mandje.aantal) {
    return res.status(400).json({ error: `"aantal" kan niet groter zijn dan de totale bezoekersgroep (${mandje.aantal})` });
  }
  if (gevraagdAantal !== mandje.aantal && !product.toestaan_deelgroep) {
    return res.status(400).json({ error: `${product.naam} kan niet door een deel van de groep gedaan worden` });
  }

  const genormaliseerdeGroepen = Array.isArray(groepen)
    ? groepen.map((g) => ({ aantal: g.aantal, begin: g.begin || g.startmoment }))
    : [];
  if (genormaliseerdeGroepen.length === 0 || genormaliseerdeGroepen.some((g) => !g.begin || !g.aantal)) {
    return res.status(400).json({ error: '"groepen" moet een array zijn met minstens 1 entry {aantal, begin}' });
  }

  try {
    // Server-side herchecken: haal verse beschikbaarheid op (rekening
    // houdend met de rest van het mandje) en controleer dat elk gekozen
    // moment er nog steeds in staat met genoeg ruimte. Zo voorkomen we dat
    // een client verouderde of gemanipuleerde tijden doorstuurt.
    const momenten = await haalBeschikbareMomenten(product, mandje.datum, mandje);
    for (const groep of genormaliseerdeGroepen) {
      const gevonden = momenten.find((m) => m.startmoment === groep.begin);
      const personenCapaciteit = gevonden ? personenCapaciteitVoorMoment(gevonden, product) : 0;
      if (!gevonden || personenCapaciteit < groep.aantal) {
        return res.status(409).json({
          error: `Het gekozen moment (${groep.begin}) is niet meer beschikbaar voor ${groep.aantal} personen. Ververs de tijden en kies opnieuw.`,
        });
      }
    }

    let prijs_per_persoon = null;
    try {
      prijs_per_persoon = await recras.haalPrijsPerPersoon(product.product_id);
    } catch (err) {
      // Boeking mag doorgaan zonder prijsindicatie; het echte bedrag volgt uit Recras.
    }

    const groepenMetEind = genormaliseerdeGroepen.map((g) => ({
      aantal: g.aantal,
      begin: g.begin,
      eind: recras.berekenEind(g.begin, product.duur_minuten),
    }));

    const item = {
      id: crypto.randomUUID(),
      slug,
      naam: product.naam,
      aantal: gevraagdAantal,
      deelgroep: gevraagdAantal !== mandje.aantal,
      groepen: groepenMetEind,
      benodigdeEenheden: berekenBenodigdeEenheden(gevraagdAantal, product.per_eenheid_personen),
      eenheid_naam: product.eenheid_naam,
      prijs_type: product.prijs_type || 'per_persoon',
      prijs_per_persoon,
      subtotaal: berekenSubtotaal(product, prijs_per_persoon, genormaliseerdeGroepen),
      toegevoegdOp: Date.now(),
    };

    mandje.items.push(item);
    raakMandjeAan(mandje);

    res.status(201).json(mandjeResponse(req.params.mandjeId, mandje));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: 'Kon activiteit niet toevoegen aan mandje', details: err.details });
  }
});

app.delete('/api/mandje/:mandjeId/items/:itemId', (req, res) => {
  const mandje = haalMandje(req.params.mandjeId);
  if (!mandje) return res.status(404).json({ error: 'Mandje niet gevonden of verlopen' });

  const voorLengte = mandje.items.length;
  mandje.items = mandje.items.filter((i) => i.id !== req.params.itemId);
  if (mandje.items.length === voorLengte) {
    return res.status(404).json({ error: 'Item niet gevonden in mandje' });
  }
  raakMandjeAan(mandje);
  res.json(mandjeResponse(req.params.mandjeId, mandje));
});

// ---------------------------------------------------------------------------
// Boeking afronden: alles in het mandje wordt EEN Recras-boeking, met per
// (sub)groep per activiteit een eigen boekingsregel.
// ---------------------------------------------------------------------------

app.post('/api/mandje/:mandjeId/boeken', async (req, res) => {
  const mandje = haalMandje(req.params.mandjeId);
  if (!mandje) return res.status(404).json({ error: 'Mandje niet gevonden of verlopen' });

  if (mandje.items.length === 0) {
    return res.status(400).json({ error: 'Het mandje is leeg' });
  }

  const { klant, bijzonderheden } = req.body || {};
  if (!klant || !klant.email || !klant.achternaam) {
    return res.status(400).json({ error: 'Verplichte klantvelden ontbreken: voornaam, achternaam, email' });
  }

  // Alles opnieuw verifiëren vlak voor het boeken: iemand anders kan
  // ondertussen dezelfde plek(ken) hebben ingenomen.
  for (const item of mandje.items) {
    const product = getProduct(item.slug);
    if (!product) continue; // zou niet moeten kunnen gebeuren
    try {
      const momenten = await haalBeschikbareMomenten(product, mandje.datum, mandje, item.id);
      for (const groep of item.groepen) {
        const gevonden = momenten.find((m) => m.startmoment === groep.begin);
        const personenCapaciteit = gevonden ? personenCapaciteitVoorMoment(gevonden, product) : 0;
        if (!gevonden || personenCapaciteit < groep.aantal) {
          return res.status(409).json({
            error: `${item.naam} om ${groep.begin} is niet meer beschikbaar. Kies een nieuw tijdstip voor deze activiteit.`,
            ongeldigItemId: item.id,
          });
        }
      }
    } catch (err) {
      console.error(err);
      return res.status(err.status || 500).json({ error: `Kon beschikbaarheid van ${item.naam} niet herverifiëren`, details: err.details });
    }
  }

  // Alle regels van alle activiteiten samenvoegen tot 1 lijst voor 1 boeking.
  const regels = [];
  for (const item of mandje.items) {
    const product = getProduct(item.slug);
    const meerdereGroepen = item.groepen.length > 1;
    item.groepen.forEach((groep, i) => {
      const delen = [];
      if (meerdereGroepen) delen.push(`subgroep ${i + 1} van ${item.groepen.length}`);
      if (item.deelgroep) delen.push(`deel van de groep: ${item.aantal} van ${mandje.aantal}`);
      regels.push({
        product_id: product.product_id,
        begin: groep.begin,
        duur_minuten: product.duur_minuten,
        aantal: groep.aantal,
        opmerking: `${item.naam}${delen.length ? ' (' + delen.join(', ') + ')' : ''}`,
      });
    });
  }

  try {
    const { klant: klantData, nieuweKlant } = await recras.vindOfMaakKlant(klant);
    const boeking = await recras.maakCombinatieBoeking({
      klant_id: klantData.id,
      regels,
      status: 'bevestigd',
      bijzonderheden,
    });

    // Mandje leegmaken na succesvolle boeking.
    mandjes.delete(req.params.mandjeId);

    res.status(201).json({ boeking, klant: klantData, nieuweKlant });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: 'Kon boeking niet aanmaken', details: err.details });
  }
});

// ---------------------------------------------------------------------------
// TIJDELIJK - debug-route om de ruwe Recras-productdata te bekijken, zodat we
// het juiste prijsveld kunnen bevestigen (zie README "Open punten"). Roep op
// als GET /api/debug/product/194 en stuur de output door. Verwijderen zodra
// haalPrijsPerPersoon() het juiste veld gebruikt.
// ---------------------------------------------------------------------------
app.get('/api/debug/product/:productId', async (req, res) => {
  try {
    const data = await recras.haalProduct(parseInt(req.params.productId, 10));
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Kon product niet ophalen', details: err.details });
  }
});

// TIJDELIJK - debug-route om de ruwe beschikbaarheid van een product op een
// dag te bekijken, om de "eenheden vs. personen"-aanname te verifiëren (zie
// README). Bijv. GET /api/debug/beschikbaarheid/bowling?datum=2026-10-01
app.get('/api/debug/beschikbaarheid/:slug', async (req, res) => {
  const product = getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'Onbekend product' });
  const { datum } = req.query;
  if (!datum) return res.status(400).json({ error: 'Query parameter "datum" (YYYY-MM-DD) is verplicht' });
  try {
    const { begin, eind } = dagBereik(datum);
    const momenten = await recras.getBeschikbaarheid(product.product_id, begin, eind);
    res.json({ product: { slug: req.params.slug, per_eenheid_personen: product.per_eenheid_personen }, momenten });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Kon beschikbaarheid niet ophalen', details: err.details });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Boekproces draait op http://localhost:${PORT}`);
});
