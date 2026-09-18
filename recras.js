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
 * Maakt EEN boeking aan met MEERDERE boekingsregels voor hetzelfde product,
 * voor een groep die over meerdere startmomenten verdeeld is (bijv. 22
 * personen -> regels van 7, 7 en 8 personen op verschillende tijden).
 *
 * Werkwijze (in 2 stappen, want de create-endpoint van Recras kan maar 1
 * boekingsregel tegelijk aanmaken):
 *  1. POST /boekingen met de eerste subgroep -> dit levert de boeking én
 *     zijn eerste (automatisch aangemaakte) boekingsregel op.
 *  2. PUT /boekingen/{id} om die eerste regel te corrigeren naar de juiste
 *     aantal/tijd, en de overige subgroepen als nieuwe boekingsregels toe te
 *     voegen. Volgens de Recras-documentatie hoeft bij het toevoegen van een
 *     nieuwe boekingsregel geen bijbehorende kostenregel meegestuurd te
 *     worden ("this happens automatically") - we sturen de bestaande
 *     kosten-structuur dus ongewijzigd terug, puur omdat `boekingsregels` en
 *     `kosten` samen meegestuurd moeten worden.
 */
async function maakGesplitsteBoeking({
  klant_id,
  product_id,
  book_process_id,
  duur_minuten,
  groepen, // [{ aantal, begin }, ...] - minstens 2 entries
  status = 'informatie',
  bijzonderheden,
}) {
  const totaalAantal = groepen.reduce((som, g) => som + g.aantal, 0);
  const eersteGroep = groepen[0];

  const createPayload = {
    klant_id,
    begin: eersteGroep.begin,
    personen: totaalAantal,
    product_id,
    status,
  };
  if (book_process_id) createPayload.book_process_id = book_process_id;
  if (bijzonderheden) createPayload.bijzonderheden = bijzonderheden;

  const { data: boeking } = await recrasRequest('/boekingen', {
    method: 'POST',
    body: createPayload,
  });

  const eersteRegel = boeking.boekingsregels?.[0];
  if (!eersteRegel) {
    throw new Error(
      'Onverwacht: Recras gaf geen boekingsregel terug bij het aanmaken van de boeking'
    );
  }

  const totaalGroepen = groepen.length;
  const nieuweBoekingsregels = groepen.map((groep, i) => {
    const basis = {
      aantal: groep.aantal,
      begin: groep.begin,
      eind: berekenEind(groep.begin, duur_minuten),
      opmerking: `Subgroep ${i + 1} van ${totaalGroepen} (automatisch gesplitst wegens groepsgrootte)`,
    };
    // De eerste subgroep hergebruikt de al bestaande boekingsregel (met id),
    // de rest zijn nieuwe regels (zonder id, met product_id erbij).
    return i === 0 ? { id: eersteRegel.id, ...basis } : { product_id, ...basis };
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

/**
 * TIJDELIJKE DIAGNOSE-FUNCTIE. Haalt de ruwe startmomenten van 1 specifieke
 * startmomentgroep op (met paginering, want /startmomenten geeft alles terug
 * zonder filter-parameter), zodat we kunnen zien of
 * `percentage_materiaal_online_boeking` misschien leeg staat - wat de
 * online/API-beschikbaarheid zou kunnen blokkeren terwijl de startmomenten
 * wel gewoon in de Recras-kalender zichtbaar zijn.
 */
async function getStartmomentenVoorGroep(groepId, { maxPaginas = 15 } = {}) {
  let pad = '/startmomenten';
  const gevonden = [];
  let paginasDoorlopen = 0;

  while (pad && paginasDoorlopen < maxPaginas) {
    const url = pad.startsWith('http') ? pad : `${BASE_URL}${pad}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${RECRAS_TOKEN}` },
    });
    const data = await res.json();

    if (!res.ok) {
      const error = new Error(`Recras API GET ${pad} gaf status ${res.status}`);
      error.status = res.status;
      error.details = data;
      throw error;
    }

    for (const startmoment of data) {
      if (startmoment.startmomentgroep_id === groepId) gevonden.push(startmoment);
    }

    const linkHeader = res.headers.get('link') || '';
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pad = match ? match[1] : null;
    paginasDoorlopen++;
  }

  return { gevonden, paginasDoorlopen, volledigDoorzocht: !pad };
}

/**
 * TIJDELIJKE REPARATIE-FUNCTIE. Zet `percentage_materiaal_online_boeking`
 * op elk startmoment van een groep naar een gekozen waarde (bijv. 100),
 * zodat we kunnen testen of dit veld inderdaad de online/API-
 * beschikbaarheid blokkeerde toen het op `null` stond.
 */
async function zetOnlinePercentageVoorGroep(groepId, percentage) {
  const { gevonden } = await getStartmomentenVoorGroep(groepId);
  const resultaten = [];

  for (const startmoment of gevonden) {
    const res = await fetch(`${BASE_URL}/startmomenten/${startmoment.id}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RECRAS_TOKEN}`,
      },
      body: JSON.stringify({
        id: startmoment.id,
        startmomentgroep_id: startmoment.startmomentgroep_id,
        datetime: startmoment.datetime,
        percentage_materiaal_online_boeking: percentage,
      }),
    });
    const data = await res.json();
    resultaten.push({ id: startmoment.id, status: res.status, ok: res.ok, data });
  }

  return resultaten;
}

module.exports = {
  getBeschikbaarheid,
  vindOfMaakKlant,
  maakBoeking,
  maakGesplitsteBoeking,
  getStartmomentenVoorGroep,
  zetOnlinePercentageVoorGroep,
};
