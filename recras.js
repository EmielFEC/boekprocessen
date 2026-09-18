// Dunne wrapper rond de Recras API (api2/*).
// Alle functies hier gebruiken de Bearer-token authenticatie uit .env.

const fetch = require('node-fetch');

const RECRAS_HOST = process.env.RECRAS_HOST;
const RECRAS_TOKEN = process.env.RECRAS_TOKEN;

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

// Kleine cache (5 minuten) op het RUWE product, zodat we niet bij elke
// paginalading van de activiteitenpagina alle producten opnieuw ophalen bij
// Recras - en zodat prijs én afbeelding uit dezelfde opgehaalde data komen
// i.p.v. 2x hetzelfde product te fetchen.
const productCache = new Map(); // productId -> { product, opgehaaldOp }
const PRODUCT_CACHE_MS = 5 * 60 * 1000;

async function haalProductGecached(productId) {
  const cached = productCache.get(productId);
  if (cached && Date.now() - cached.opgehaaldOp < PRODUCT_CACHE_MS) {
    return cached.product;
  }
  const product = await haalProduct(productId);
  productCache.set(productId, { product, opgehaaldOp: Date.now() });
  return product;
}

/**
 * Bepaalt de prijs per persoon (of per eenheid, zie prijs_type in
 * products.json) van een product, live uit Recras.
 *
 * BEVESTIGD DOOR EMIEL: de prijs die de Recras API teruggeeft (zowel
 * `ProductPrice[0].verkoop` als het top-level `verkoop`-veld) is al
 * INCLUSIEF btw - dit is dus meteen het bedrag dat aan de klant getoond
 * hoort te worden. Eerder rekenden we hier zelf nog een keer btw bovenop,
 * wat de prijzen dubbel zo hoog (te hoog) maakte - die extra berekening is
 * verwijderd.
 */
async function haalPrijsPerPersoon(productId) {
  const product = await haalProductGecached(productId);
  const eerstePrijsregel = Array.isArray(product?.ProductPrice) ? product.ProductPrice[0] : null;

  let verkoop = eerstePrijsregel?.verkoop ?? product?.verkoop;

  if (verkoop == null) {
    // Fallback op oudere gok-veldnamen, voor het geval een ander
    // producttype toch een andere vorm blijkt te hebben.
    const mogelijkeVelden = ['verkoopprijs', 'verkoopprijs_incl_btw', 'prijs', 'prijs_incl_btw', 'prijs_per_persoon'];
    for (const veld of mogelijkeVelden) {
      if (product && product[veld] != null && product[veld] !== '') {
        verkoop = product[veld];
        break;
      }
    }
  }

  if (verkoop == null) {
    const fout = new Error(
      `Kon geen prijsveld vinden op product ${productId} (verwacht: ProductPrice[0].verkoop of verkoop)`
    );
    fout.details = product;
    throw fout;
  }

  return typeof verkoop === 'string' ? parseFloat(verkoop) : verkoop;
}

/**
 * Haalt de afbeelding-URL van een product op (voor de activiteitentegel),
 * uit dezelfde (gecachete) productdata als de prijs - dus geen extra
 * Recras-call als de prijs al net is opgehaald. Geeft `null` terug als er
 * geen afbeelding is (of het ophalen mislukt) - de frontend toont dan
 * gewoon geen foto i.p.v. een kapot plaatje.
 */
async function haalAfbeeldingUrl(productId) {
  try {
    const product = await haalProductGecached(productId);
    return product?.boekproces_afbeelding_href || product?.afbeelding_href || null;
  } catch (err) {
    return null;
  }
}

/**
 * TIJDELIJK (debug): haalt een paar recente boekingen op. Bevestigd door
 * Emiel (obv een export vanuit Recras): het `status`-veld dat bestaande
 * boekingen krijgen is de STRING "definitief" (kleine letters) - onze eigen
 * `status: 'bevestigd'` werd daarom afgewezen. `maakCombinatieBoeking()`
 * gebruikt inmiddels 'definitief' als default.
 *
 * Recras' `/boekingen` endpoint accepteert geen `limit`-query-parameter
 * (gaf "Could not validate extra field" terug) - we halen daarom gewoon
 * alles op en knippen zelf af tot `limit` resultaten.
 */
async function listRecenteBoekingen(limit = 5) {
  const { data } = await recrasRequest('/boekingen');
  return Array.isArray(data) ? data.slice(0, limit) : data;
}

/**
 * Telt `duur_minuten` op bij een ISO-tijdstip om het eindtijdstip van een
 * (sub)groep te berekenen - puur voor WEERGAVE in ons eigen mandje/zijbalk,
 * niet meer voor de boeking-aanmaak zelf (zie maakCombinatieBoeking).
 */
function berekenEind(beginIso, duurMinuten) {
  const d = new Date(beginIso);
  d.setMinutes(d.getMinutes() + (duurMinuten || 0));
  return d.toISOString();
}

// Zet een ISO8601-tijdstip-MET-offset (zoals Recras' eigen 'startmoment',
// bijv. "2026-10-01T14:00:00+02:00") om naar het "YYYY-MM-DD HH:mm:ss"-
// formaat (spatie, geen offset) dat Recras' eigen documentatie-voorbeelden
// voor datetime-velden gebruiken (zie book_products/startmomenten). Dit
// gebeurt met een simpele regex-extractie i.p.v. via een JS Date-object -
// een Date zou de klok-tijd omrekenen naar de tijdzone van de SERVER (op
// Render bijv. UTC), terwijl we exact het wandklok-tijdstip willen behouden
// dat de klant koos (en dat al in de Nederlandse tijdzone stond).
function formatteerVoorRecras(isoTijdstipMetOffset) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(isoTijdstipMetOffset || '');
  if (!match) return isoTijdstipMetOffset;
  const [, jaar, maand, dag, uur, minuut, seconde] = match;
  return `${jaar}-${maand}-${dag} ${uur}:${minuut}:${seconde}`;
}

// Volgt een HATEOAS-link zoals Recras die teruggeeft in `_links`
// (bijv. { href: "/api2/boekingen/51/set_status/definitief", method: "POST" }).
// `recrasRequest()` plakt zelf al BASE_URL (".../api2") ervoor, dus een
// eventueel "/api2"-voorvoegsel in de href wordt hier eerst gestript.
async function volgLink(link) {
  if (!link || !link.href) return null;
  const pad = link.href.startsWith('/api2') ? link.href.slice('/api2'.length) : link.href;
  return recrasRequest(pad, { method: link.method || 'POST' });
}

/**
 * Maakt in ÉÉN keer een boeking aan met (mogelijk meerdere) producten,
 * eventueel voor VERSCHILLENDE producten (bijv. Bowling om 14:00 + Lasergame
 * om 15:00 in dezelfde boeking, of één product gesplitst over meerdere
 * subgroepen/tijden), via `POST /book_products`
 * (https://demo.recras.nl/docs/api/endpoints/book_products.html) - een
 * endpoint dat specifiek voor dit scenario bedoeld is (combi-boekingen met
 * meerdere producten in 1x) en zelf het klant-matchen en de locatie-
 * toewijzing regelt.
 *
 * LET OP: dit vervangt een eerdere aanpak via losse POST+PUT op
 * `/boekingen`, die op live data 2 harde fouten gaf: `ERR_PRODUCT_
 * REQUIRES_LOCATION` (sommige producten, zoals Lasergame, vereisen een
 * `locatie_id` per regel - vandaar dat `regels[].locatie_id` hieronder
 * meegestuurd wordt, afkomstig uit de 'locaties' van de beschikbaarheids-
 * data, zie server.js) en een verplicht maar ontbrekend `ref`-veld op
 * nieuwe boekingsregels. Bij `/book_products` bestaan beide problemen niet:
 * `location_id` is een normaal (optioneel) veld per product-regel, en er is
 * geen `ref`-vereiste voor nieuwe regels.
 *
 * `regels`: [{ product_id, begin (ISO-tijdstip met offset), aantal,
 *              locatie_id? }, ...] (minstens 1 entry)
 * `klant`: { voornaam, achternaam, email, telefoon? }
 */
async function maakCombinatieBoeking({ klant, regels, status = 'definitief' }) {
  if (!Array.isArray(regels) || regels.length === 0) {
    throw new Error('maakCombinatieBoeking heeft minstens 1 regel nodig');
  }

  const payload = {
    status,
    customer: {
      email: klant.email,
      first_name: klant.voornaam,
      last_name: klant.achternaam,
      ...(klant.telefoon ? { phone_number: klant.telefoon } : {}),
    },
    products: regels.map((regel) => ({
      amount: regel.aantal,
      product_id: regel.product_id,
      datetime: formatteerVoorRecras(regel.begin),
      ...(regel.locatie_id != null ? { location_id: regel.locatie_id } : {}),
    })),
    should_invoice: true,
  };

  const { data: boeking } = await recrasRequest('/book_products', {
    method: 'POST',
    body: payload,
  });

  // Voor de zekerheid: als Recras een 'bevestigen'-link teruggeeft en we een
  // definitieve boeking willen, roepen we die ook aan - de documentatie is
  // er niet expliciet over of `status: 'definitief'` in de aanmaak zelf al
  // genoeg is. Dit is niet-blokkerend: als het niet lukt, is de boeking
  // zelf al wel aangemaakt.
  const bevestigLink = boeking?._links?.['recras:booking:set_status:confirmed'];
  if (status === 'definitief' && bevestigLink?.href) {
    try {
      await volgLink(bevestigLink);
    } catch (err) {
      console.error('[boeking] kon status niet expliciet bevestigen:', err.message, err.details ?? '');
    }
  }

  return boeking;
}

module.exports = {
  getBeschikbaarheid,
  haalProduct,
  haalPrijsPerPersoon,
  haalAfbeeldingUrl,
  listRecenteBoekingen,
  maakCombinatieBoeking,
  berekenEind,
};
