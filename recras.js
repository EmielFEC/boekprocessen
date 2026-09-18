// Dunne wrapper rond de Recras API (api2/*).
// Alle functies hier gebruiken de Bearer-token authenticatie uit .env.

const fetch = require('node-fetch');

const RECRAS_HOST = process.env.RECRAS_HOST;
const RECRAS_TOKEN = process.env.RECRAS_TOKEN;
const RECRAS_BEDRIJF_ID = process.env.RECRAS_BEDRIJF_ID
  ? parseInt(process.env.RECRAS_BEDRIJF_ID, 10)
  : undefined;

if (!RECRAS_HOST || !RECRAS_TOKEN) {
  console.warn(
    '[recras] RECRAS_HOST of RECRAS_TOKEN ontbreekt in .env - API-calls zullen falen.'
  );
}

const BASE_URL = `https://${RECRAS_HOST}/api2`;

/**
 * Kleine helper die een request naar de Recras API doet en nette fouten
 * teruggeeft zodat de server-routes daar makkelijk op kunnen reageren.
 */
async function recrasRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RECRAS_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }

  if (!res.ok) {
    const error = new Error(
      `Recras API ${method} ${path} gaf status ${res.status}`
    );
    error.status = res.status;
    error.details = data;
    throw error;
  }

  return { status: res.status, data };
}

/**
 * Beschikbaarheid (startmomenten + capaciteit per locatie) voor een product.
 * `begin` is exclusief, `eind` is inclusief (zoals de Recras API het wil).
 */
async function getBeschikbaarheid(productId, begin, eind) {
  // cache=force_off: negeer Recras' eigen cache. Zonder dit kan een net
  // toegevoegd startmoment nog even niet zichtbaar zijn in dit endpoint.
  const params = new URLSearchParams({ eind, cache: 'force_off' });
  if (begin) params.set('begin', begin);

  const { data } = await recrasRequest(
    `/producten/${productId}/beschikbaarheid?${params.toString()}`
  );
  return data;
}

/**
 * Haalt de ruwe productgegevens van Recras op (voor prijs, naam, etc.).
 */
async function haalProduct(productId) {
  const { data } = await recrasRequest(`/producten/${productId}`);
  return data;
}

// Kleine cache (5 minuten) zodat we niet bij elke paginalading van de
// activiteitenpagina alle producten opnieuw ophalen bij Recras.
const prijsCache = new Map(); // productId -> { prijs, opgehaaldOp }
const PRIJS_CACHE_MS = 5 * 60 * 1000;

/**
 * Bepaalt de prijs per persoon van een product, live uit Recras.
 * Recras' documentatie/response-vorm voor het prijsveld is nog niet 1-op-1
 * bevestigd tegen de echte omgeving; we proberen daarom een aantal
 * waarschijnlijke veldnamen en gooien een duidelijke fout (met de ruwe
 * data erbij) als geen daarvan bestaat, zodat dit snel te debuggen is.
 */
async function haalPrijsPerPersoon(productId) {
  const cached = prijsCache.get(productId);
  if (cached && Date.now() - cached.opgehaaldOp < PRIJS_CACHE_MS) {
    return cached.prijs;
  }

  const product = await haalProduct(productId);
  const mogelijkeVelden = [
    'verkoopprijs',
    'verkoopprijs_incl_btw',
    'prijs',
    'prijs_incl_btw',
    'prijs_per_persoon',
  ];
  let ruw;
  for (const veld of mogelijkeVelden) {
    if (product && product[veld] != null && product[veld] !== '') {
      ruw = product[veld];
      break;
    }
  }

  if (ruw == null) {
    const fout = new Error(
      `Kon geen prijsveld vinden op product ${productId} (geprobeerd: ${mogelijkeVelden.join(', ')})`
    );
    fout.details = product;
    throw fout;
  }

  const prijs = typeof ruw === 'string' ? parseFloat(ruw) : ruw;
  prijsCache.set(productId, { prijs, opgehaaldOp: Date.now() });
  return prijs;
}

/**
 * Zoekt of maakt een klant aan. Recras doet de deduplicatie zelf: als naam +
 * e-mailadres van de contactpersoon al bestaan, geeft de API een 200 terug
 * met de bestaande klant; anders een 201 met een nieuwe klant. Wij hoeven
 * dus niet zelf te zoeken, alleen het resultaat door te geven.
 */
async function vindOfMaakKlant({ naam, voornaam, achternaam, email, telefoon }) {
  const payload = {
    naam: naam || `${voornaam} ${achternaam}`.trim(),
    contactpersonen: [
      {
        voornaam,
        achternaam,
        email1: email,
        telefoon1: telefoon || '',
        hoofdcontact: true,
      },
    ],
  };

  if (RECRAS_BEDRIJF_ID) payload.bedrijf_id = RECRAS_BEDRIJF_ID;

  const { status, data } = await recrasRequest('/klanten', {
    method: 'POST',
    body: payload,
  });

  return { klant: data, nieuweKlant: status === 201 };
}

/**
 * Telt `duur_minuten` op bij een ISO-tijdstip om het eindtijdstip van een
 * boekingsregel te berekenen.
 */
function berekenEind(beginIso, duurMinuten) {
  const d = new Date(beginIso);
  d.setMinutes(d.getMinutes() + (duurMinuten || 0));
  return d.toISOString();
}

/**
 * Maakt EEN boeking aan met een of meerdere boekingsregels, eventueel voor
 * VERSCHILLENDE producten (bijv. Bowling om 14:00 + Lasergame om 15:00 in
 * dezelfde boeking, of één product gesplitst over meerdere subgroepen/tijden).
 *
 * Werkwijze (in 2 stappen, want de create-endpoint van Recras kan maar 1
 * boekingsregel tegelijk aanmaken):
 *  1. POST /boekingen met de eerste regel -> dit levert de boeking én zijn
 *     eerste (automatisch aangemaakte) boekingsregel op.
 *  2. PUT /boekingen/{id} om die eerste regel te corrigeren naar de juiste
 *     product/aantal/tijd, en de overige regels toe te voegen. Volgens de
 *     Recras-documentatie hoeft bij het toevoegen van een nieuwe
 *     boekingsregel geen bijbehorende kostenregel meegestuurd te worden
 *     ("this happens automatically") - we sturen de bestaande
 *     kosten-structuur dus ongewijzigd terug, puur omdat `boekingsregels` en
 *     `kosten` samen meegestuurd moeten worden.
 *
 * `regels`: [{ product_id, begin, duur_minuten, aantal, opmerking }, ...]
 *           (minstens 1 entry)
 */
async function maakCombinatieBoeking({
  klant_id,
  regels,
  status = 'bevestigd',
  bijzonderheden,
}) {
  if (!Array.isArray(regels) || regels.length === 0) {
    throw new Error('maakCombinatieBoeking heeft minstens 1 regel nodig');
  }

  const totaalAantal = regels.reduce((som, r) => som + r.aantal, 0);
  const eersteRegelInput = regels[0];

  const createPayload = {
    klant_id,
    begin: eersteRegelInput.begin,
    personen: totaalAantal,
    product_id: eersteRegelInput.product_id,
    status,
  };
  if (bijzonderheden) createPayload.bijzonderheden = bijzonderheden;

  const { data: boeking } = await recrasRequest('/boekingen', {
    method: 'POST',
    body: createPayload,
  });

  const eersteBoekingsregel = boeking.boekingsregels?.[0];
  if (!eersteBoekingsregel) {
    throw new Error(
      'Onverwacht: Recras gaf geen boekingsregel terug bij het aanmaken van de boeking'
    );
  }

  const nieuweBoekingsregels = regels.map((regel, i) => {
    const basis = {
      product_id: regel.product_id,
      aantal: regel.aantal,
      begin: regel.begin,
      eind: berekenEind(regel.begin, regel.duur_minuten),
      opmerking: regel.opmerking || undefined,
    };
    // De eerste regel hergebruikt de al bestaande boekingsregel (met id),
    // de rest zijn nieuwe regels (zonder id).
    return i === 0 ? { id: eersteBoekingsregel.id, ...basis } : basis;
  });

  const { data: bijgewerkteBoeking } = await recrasRequest(`/boekingen/${boeking.id}`, {
    method: 'PUT',
    body: {
      id: boeking.id,
      boekingsregels: nieuweBoekingsregels,
      kosten: boeking.kosten,
    },
  });

  return bijgewerkteBoeking;
}

module.exports = {
  getBeschikbaarheid,
  haalProduct,
  haalPrijsPerPersoon,
  vindOfMaakKlant,
  maakCombinatieBoeking,
  berekenEind,
};
