// Groep-splitsing logica.
//
// Uitgangspunt: als een groep groter is dan de capaciteit van een los
// startmoment, wordt de groep zo gelijk mogelijk verdeeld over meerdere
// startmomenten op dezelfde dag. De klant kiest zelf de starttijd van de
// eerste (sub)groep; de rest van het schema wordt daarna automatisch zo
// aansluitend mogelijk ingepland. Dit is pure berekening (geen Recras-
// calls), wat het makkelijk maakt om los te testen en te verfijnen.

/**
 * Verdeelt `aantal` personen zo gelijk mogelijk over `groepen` subgroepen.
 * Bijv. verdeel(15, 2) => [8, 7]
 */
function verdeel(aantal, groepen) {
  const basis = Math.floor(aantal / groepen);
  const rest = aantal % groepen;
  const sizes = new Array(groepen).fill(basis);
  for (let i = 0; i < rest; i++) sizes[i] += 1;
  return sizes;
}

/**
 * Hoeveel 'eenheden' (banen/tafels/sessies) zijn nodig voor `aantal`
 * personen, gegeven hoeveel personen er per eenheid passen. Rondt altijd
 * naar boven af (zoals Recras' 'Afronding: boven' bij deze producten) -
 * bijv. 22 personen bij 7 per baan -> 4 banen.
 */
function berekenBenodigdeEenheden(aantal, perEenheidPersonen) {
  const perEenheid = perEenheidPersonen && perEenheidPersonen > 0 ? perEenheidPersonen : 1;
  return Math.ceil(aantal / perEenheid);
}

/**
 * Zet de ruwe Recras-beschikbaarheidsdata om naar een lijst van
 * { startmoment, eenhedenBeschikbaar, personenCapaciteit }.
 *
 * BELANGRIJKE AANNAME: bij producten die per baan/tafel/sessie geboekt
 * worden (per_eenheid_personen > 1, bijv. Bowling: 7 p.p. baan), gaan we
 * ervan uit dat Recras' 'beschikbaarheid' het aantal vrije EENHEDEN
 * (banen) teruggeeft, niet al een personen-equivalent. Daarom
 * vermenigvuldigen we hier met `perEenheidPersonen` om de werkelijke
 * personen-capaciteit van dat moment te krijgen (bijv. 4 vrije banen x 7
 * p.p. = 28 personen mogelijk op 1 moment, verdeeld over die 4 banen).
 * Voor pure per-persoon producten (perEenheidPersonen = 1) verandert dit
 * niets. Zie README voor hoe dit te verifiëren tegen echte Recras-data.
 */
function leesMomenten(momenten, perEenheidPersonen = 1) {
  const perEenheid = perEenheidPersonen && perEenheidPersonen > 0 ? perEenheidPersonen : 1;
  const beschikbaarheidPerMoment = (momenten || []).map((m) => {
    const eenhedenBeschikbaar = m.locaties?.[0]?.beschikbaarheid ?? 0;
    return {
      startmoment: m.startmoment,
      eenhedenBeschikbaar,
      personenCapaciteit: eenhedenBeschikbaar * perEenheid,
    };
  });
  const capaciteit =
    beschikbaarheidPerMoment.length > 0
      ? Math.max(...beschikbaarheidPerMoment.map((m) => m.personenCapaciteit))
      : 0;
  return { beschikbaarheidPerMoment, capaciteit };
}

/**
 * Stap 1: bepaalt of een groep in 1 moment past, of gesplitst moet worden.
 * `perEenheidPersonen`: zie leesMomenten (default 1 = puur per persoon).
 *
 * Geeft ALTIJD alle startmomenten van de dag terug in `opties` (elk met een
 * `beschikbaar` vlag), zodat de klant ook volgeboekte tijden grijs/niet-
 * klikbaar te zien krijgt in plaats van dat ze gewoon verdwijnen.
 *
 * Retourneert een van:
 *  - { status: 'enkel', capaciteit, opties: [{ startmoment, personenCapaciteit, eenhedenBeschikbaar, eenhedenNodig, beschikbaar }] }
 *  - { status: 'kies_starttijd', capaciteit, groepsgroottes: [..], opties: [...] }
 *    (opties = alle startmomenten, met `beschikbaar` op basis van de EERSTE
 *    subgroep; de klant kiest een beschikbaar moment, waarna
 *    planVervolgSchema het vervolg berekent)
 *  - { status: 'onmogelijk', reden: string, opties?: [...] }
 *    (opties zit hierbij als de dag wel startmomenten heeft maar alles vol
 *    zit, zodat ook dan de volledige - grijze - tijdenlijst getoond kan
 *    worden; ontbreekt als er die dag helemaal geen startmomenten zijn)
 */
function planBoeking(momenten, aantal, perEenheidPersonen = 1) {
  const { beschikbaarheidPerMoment, capaciteit } = leesMomenten(momenten, perEenheidPersonen);

  if (beschikbaarheidPerMoment.length === 0) {
    return { status: 'onmogelijk', reden: 'Geen startmomenten gevonden op deze dag.' };
  }
  if (capaciteit <= 0) {
    const opties = beschikbaarheidPerMoment.map((m) => ({
      ...m,
      eenhedenNodig: berekenBenodigdeEenheden(aantal, perEenheidPersonen),
      beschikbaar: false,
    }));
    return { status: 'onmogelijk', reden: 'Alle beschikbare tijden op deze dag zitten al vol.', opties };
  }

  if (aantal <= capaciteit) {
    const opties = beschikbaarheidPerMoment.map((m) => ({
      ...m,
      eenhedenNodig: berekenBenodigdeEenheden(aantal, perEenheidPersonen),
      beschikbaar: m.personenCapaciteit >= aantal,
    }));
    return { status: 'enkel', capaciteit, opties };
  }

  const aantalGroepen = Math.ceil(aantal / capaciteit);
  const groepsgroottes = verdeel(aantal, aantalGroepen);

  const opties = beschikbaarheidPerMoment.map((m) => ({
    ...m,
    eenhedenNodig: berekenBenodigdeEenheden(groepsgroottes[0], perEenheidPersonen),
    beschikbaar: m.personenCapaciteit >= groepsgroottes[0],
  }));
  if (!opties.some((o) => o.beschikbaar)) {
    return {
      status: 'onmogelijk',
      reden: `Geen enkel moment heeft genoeg ruimte voor de eerste subgroep (${groepsgroottes[0]} personen).`,
      opties,
    };
  }

  return { status: 'kies_starttijd', capaciteit, groepsgroottes, opties };
}

/**
 * Stap 2: de klant heeft een starttijd voor de eerste subgroep gekozen.
 * Bereken het optimale (zo aansluitend mogelijk) vervolgschema voor de
 * overige subgroepen, te beginnen na het gekozen moment.
 *
 * Retourneert:
 *  - { status: 'gesplitst', groepen: [{ aantal, startmoment, eenhedenNodig }, ...] }
 *  - { status: 'onmogelijk', reden: string }
 */
function planVervolgSchema(momenten, groepsgroottes, gekozenStartmoment, perEenheidPersonen = 1) {
  const { beschikbaarheidPerMoment } = leesMomenten(momenten, perEenheidPersonen);

  const startIndex = beschikbaarheidPerMoment.findIndex(
    (m) => m.startmoment === gekozenStartmoment
  );
  if (startIndex === -1) {
    return { status: 'onmogelijk', reden: 'De gekozen starttijd is niet (meer) gevonden op deze dag.' };
  }
  if (beschikbaarheidPerMoment[startIndex].personenCapaciteit < groepsgroottes[0]) {
    return {
      status: 'onmogelijk',
      reden: 'Dit moment heeft inmiddels niet meer genoeg vrije plekken voor de eerste subgroep. Ververs de beschikbaarheid en kies opnieuw.',
    };
  }

  const groepen = [{
    aantal: groepsgroottes[0],
    startmoment: gekozenStartmoment,
    eenhedenNodig: berekenBenodigdeEenheden(groepsgroottes[0], perEenheidPersonen),
  }];
  let idx = startIndex + 1;

  for (let i = 1; i < groepsgroottes.length; i++) {
    while (idx < beschikbaarheidPerMoment.length && beschikbaarheidPerMoment[idx].personenCapaciteit < groepsgroottes[i]) {
      idx++;
    }
    if (idx >= beschikbaarheidPerMoment.length) {
      return {
        status: 'onmogelijk',
        reden: `Niet genoeg opeenvolgende beschikbare momenten na de gekozen starttijd voor alle subgroepen (nodig: ${groepsgroottes.length}, waarvan ${i} gevonden). Kies een vroegere starttijd voor groep 1, of probeer een andere dag.`,
      };
    }
    groepen.push({
      aantal: groepsgroottes[i],
      startmoment: beschikbaarheidPerMoment[idx].startmoment,
      eenhedenNodig: berekenBenodigdeEenheden(groepsgroottes[i], perEenheidPersonen),
    });
    idx++;
  }

  return { status: 'gesplitst', groepen };
}

/**
 * Filtert startmomenten weg die overlappen met al geplande (mandje-)
 * intervallen, zodat een klant niet twee activiteiten tegelijk kan boeken.
 * `bezetIntervallen`: [{ begin: iso, eind: iso }, ...]
 * Een moment met duur `duurMinuten` overlapt een bezet interval als
 * moment.begin < interval.eind EN moment.eind > interval.begin.
 */
function filterOverlap(momenten, duurMinuten, bezetIntervallen) {
  if (!bezetIntervallen || bezetIntervallen.length === 0) return momenten;

  return (momenten || []).filter((m) => {
    const momentBegin = new Date(m.startmoment).getTime();
    const momentEind = momentBegin + (duurMinuten || 0) * 60 * 1000;

    return !bezetIntervallen.some((interval) => {
      const iBegin = new Date(interval.begin).getTime();
      const iEind = new Date(interval.eind).getTime();
      return momentBegin < iEind && momentEind > iBegin;
    });
  });
}

module.exports = {
  planBoeking,
  planVervolgSchema,
  verdeel,
  berekenBenodigdeEenheden,
  filterOverlap,
};
