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
  const params = new URLSearchParams({ eind });
  if (begin) params.set('begin', begin);

  const { data } = await recrasRequest(
    `/producten/${productId}/beschikbaarheid?${params.toString()}`
  );
  return data;
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
 * Maakt een boeking aan voor een klant, gebaseerd op een los product
 * (zonder package/arrangement). `begin` is het startmoment van de boeking.
 */
async function maakBoeking({
  klant_id,
  product_id,
  book_process_id,
  begin,
  aantal,
  status = 'informatie',
  bijzonderheden,
}) {
  const payload = {
    klant_id,
    begin,
    personen: aantal,
    product_id,
    status,
  };

  if (book_process_id) payload.book_process_id = book_process_id;
  if (bijzonderheden) payload.bijzonderheden = bijzonderheden;

  const { data } = await recrasRequest('/boekingen', {
    method: 'POST',
    body: payload,
  });

  return data;
}

module.exports = {
  getBeschikbaarheid,
  vindOfMaakKlant,
  maakBoeking,
};
