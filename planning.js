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
 * Zet de ruwe Recras-beschikbaarheidsdata om naar een simpele lijst van
 * { startmoment, beschikbaarheid }, en bepaalt de "volledige capaciteit per
 * moment" (het hoogste aantal dat die dag ergens gezien wordt - zie README
 * voor de aanname/beperking hierachter).
 */
function leesMomenten(momenten) {
  const beschikbaarheidPerMoment = (momenten || []).map((m) => ({
    startmoment: m.startmoment,
    beschikbaarheid: m.locaties?.[0]?.beschikbaarheid ?? 0,
  }));
  const capaciteit =
    beschikbaarheidPerMoment.length > 0
      ? Math.max(...beschikbaarheidPerMoment.map((m) => m.beschikbaarheid))
      : 0;
  return { beschikbaarheidPerMoment, capaciteit };
}

/**
 * Stap 1: bepaalt of een groep in 1 moment past, of gesplitst moet worden.
 * Retourneert een van:
 *  - { status: 'enkel', capaciteit, opties: [{ startmoment, beschikbaarheid }] }
 *  - { status: 'kies_starttijd', capaciteit, groepsgroottes: [..], opties: [...] }
 *    (opties = geschikte startmomenten voor de EERSTE subgroep; de klant
 *    kiest hieruit, waarna planVervolgSchema het vervolg berekent)
 *  - { status: 'onmogelijk', reden: string }
 */
function planBoeking(momenten, aantal) {
  const { beschikbaarheidPerMoment, capaciteit } = leesMomenten(momenten);

  if (beschikbaarheidPerMoment.length === 0) {
    return { status: 'onmogelijk', reden: 'Geen startmomenten gevonden op deze dag.' };
  }
  if (capaciteit <= 0) {
    return { status: 'onmogelijk', reden: 'Geen enkel moment heeft nog vrije plekken op deze dag.' };
  }

  if (aantal <= capaciteit) {
    const opties = beschikbaarheidPerMoment.filter((m) => m.beschikbaarheid >= aantal);
    return { status: 'enkel', capaciteit, opties };
  }

  const aantalGroepen = Math.ceil(aantal / capaciteit);
  const groepsgroottes = verdeel(aantal, aantalGroepen);

  const opties = beschikbaarheidPerMoment.filter((m) => m.beschikbaarheid >= groepsgroottes[0]);
  if (opties.length === 0) {
    return {
      status: 'onmogelijk',
      reden: `Geen enkel moment heeft genoeg ruimte voor de eerste subgroep (${groepsgroottes[0]} personen).`,
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
 *  - { status: 'gesplitst', groepen: [{ aantal, startmoment }, ...] }
 *  - { status: 'onmogelijk', reden: string }
 */
function planVervolgSchema(momenten, groepsgroottes, gekozenStartmoment) {
  const { beschikbaarheidPerMoment } = leesMomenten(momenten);

  const startIndex = beschikbaarheidPerMoment.findIndex(
    (m) => m.startmoment === gekozenStartmoment
  );
  if (startIndex === -1) {
    return { status: 'onmogelijk', reden: 'De gekozen starttijd is niet (meer) gevonden op deze dag.' };
  }
  if (beschikbaarheidPerMoment[startIndex].beschikbaarheid < groepsgroottes[0]) {
    return {
      status: 'onmogelijk',
      reden: 'Dit moment heeft inmiddels niet meer genoeg vrije plekken voor de eerste subgroep. Ververs de beschikbaarheid en kies opnieuw.',
    };
  }

  const groepen = [{ aantal: groepsgroottes[0], startmoment: gekozenStartmoment }];
  let idx = startIndex + 1;

  for (let i = 1; i < groepsgroottes.length; i++) {
    while (idx < beschikbaarheidPerMoment.length && beschikbaarheidPerMoment[idx].beschikbaarheid < groepsgroottes[i]) {
      idx++;
    }
    if (idx >= beschikbaarheidPerMoment.length) {
      return {
        status: 'onmogelijk',
        reden: `Niet genoeg opeenvolgende beschikbare momenten na de gekozen starttijd voor alle subgroepen (nodig: ${groepsgroottes.length}, waarvan ${i} gevonden). Kies een vroegere starttijd voor groep 1, of probeer een andere dag.`,
      };
    }
    groepen.push({ aantal: groepsgroottes[i], startmoment: beschikbaarheidPerMoment[idx].startmoment });
    idx++;
  }

  return { status: 'gesplitst', groepen };
}

module.exports = { planBoeking, planVervolgSchema, verdeel };
