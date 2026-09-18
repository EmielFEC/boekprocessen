// Groep-splitsing logica.
//
// Uitgangspunt: als een groep groter is dan de capaciteit van een los
// startmoment, wordt de groep verdeeld over meerdere startmomenten op
// dezelfde dag. De klant kiest zelf de starttijd van de eerste (sub)groep;
// de rest van het schema wordt daarna automatisch zo aansluitend mogelijk
// ingepland. Dit is pure berekening (geen Recras-calls), wat het makkelijk
// maakt om los te testen en te verfijnen.

/**
 * Verdeelt `aantal` personen zo GELIJK mogelijk over `groepen` subgroepen.
 * Bijv. verdeel(15, 2) => [8, 7]. Gebruikt voor pure per-persoon producten
 * (Lasergame, American Golf, ...), waar een eerlijke verdeling de voorkeur
 * heeft boven het maximaal volplannen van 1 moment.
 */
function verdeel(aantal, groepen) {
  const basis = Math.floor(aantal / groepen);
  const rest = aantal % groepen;
  const sizes = new Array(groepen).fill(basis);
  for (let i = 0; i < rest; i++) sizes[i] += 1;
  return sizes;
}

/**
 * Verdeelt `aantal` personen GREEDY: vult elk moment tot de volledige
 * capaciteit voordat de rest naar het volgende moment gaat. Bijv.
 * verdeelGreedy(18, 12) => [12, 6]; verdeelGreedy(19, 12) => [12, 7].
 * Gebruikt voor per-eenheid producten (Bowling, X-Cube, Fun Curling,
 * X-Wall): daar is een eenheid (baan/cube) een fysieke, discrete
 * hulpbron, en wil je zo min mogelijk momenten nodig hebben in plaats van
 * de groep eerlijk te verdelen (bevestigd door Emiel voor X-Cube: 18
 * personen -> 12 op 2 cubes + 6 op de eerstvolgende cube, niet 9+9).
 */
function verdeelGreedy(aantal, capaciteit) {
  const sizes = [];
  let rest = aantal;
  const stap = capaciteit && capaciteit > 0 ? capaciteit : aantal;
  while (rest > 0) {
    const stuk = Math.min(rest, stap);
    sizes.push(stuk);
    rest -= stuk;
  }
  return sizes;
}

/**
 * Hoeveel 'eenheden' (banen/tafels/sessies/cubes) zijn nodig voor `aantal`
 * personen, gegeven hoeveel personen er per eenheid passen. Rondt altijd
 * naar boven af (zoals Recras' 'Afronding: boven' bij deze producten) -
 * bijv. 22 personen bij 7 per baan -> 4 banen.
 */
function berekenBenodigdeEenheden(aantal, perEenheidPersonen) {
  const perEenheid = perEenheidPersonen && perEenheidPersonen > 0 ? perEenheidPersonen : 1;
  return Math.ceil(aantal / perEenheid);
}

/**
 * Annoteert elk startmoment met hoeveel personen er al 'bezet' zijn door
 * andere activiteiten in het mandje die dit moment (deels) overlappen in
 * tijd, en welke items dat zijn. Dit FILTERT NIETS weg - overlappende
 * momenten blijven gewoon in de lijst staan, zodat de klant ze rood/als
 * conflict te zien kan krijgen in plaats van dat ze onverklaarbaar
 * verdwijnen. Of een overlap een écht probleem is, hangt af van hoeveel
 * personen de NIEUWE activiteit vraagt (bijv. een deelgroep van 5 kan prima
 * gelijktijdig met een andere deelgroep van 13 als het totaal <= de hele
 * bezoekersgroep blijft) - die afweging gebeurt in planBoeking/
 * planVervolgSchema, niet hier.
 *
 * `bezetteItems`: [{ itemId, slug, naam, aantal, begin, eind }, ...]
 * (1 entry per (sub)groep die al in het mandje staat)
 */
function annoteerOverlap(momenten, duurMinuten, bezetteItems) {
  const items = (bezetteItems || []).map((it) => ({
    ...it,
    beginMs: new Date(it.begin).getTime(),
    eindMs: new Date(it.eind).getTime(),
  }));

  return (momenten || []).map((m) => {
    const momentBeginMs = new Date(m.startmoment).getTime();
    const momentEindMs = momentBeginMs + (duurMinuten || 0) * 60 * 1000;

    const overlappend = items.filter(
      (it) => momentBeginMs < it.eindMs && momentEindMs > it.beginMs
    );
    const overlapLast = overlappend.reduce((som, it) => som + it.aantal, 0);

    return {
      ...m,
      overlapLast,
      overlapItems: overlappend.map(({ itemId, slug, naam, aantal, begin, eind }) => ({
        itemId,
        slug,
        naam,
        aantal,
        begin,
        eind,
      })),
    };
  });
}

/**
 * Zet de ruwe (mogelijk met annoteerOverlap geannoteerde) beschikbaarheids-
 * data om naar een lijst van { startmoment, eenhedenBeschikbaar,
 * personenCapaciteit, overlapLast, overlapItems }.
 *
 * BELANGRIJKE AANNAME: bij producten die per baan/tafel/sessie/cube
 * geboekt worden (per_eenheid_personen > 1, bijv. Bowling: 7 p.p. baan),
 * gaan we ervan uit dat Recras' 'beschikbaarheid' het aantal vrije
 * EENHEDEN teruggeeft, niet al een personen-equivalent. Daarom
 * vermenigvuldigen we hier met `perEenheidPersonen` om de werkelijke
 * personen-capaciteit van dat moment te krijgen. Voor pure per-persoon
 * producten (perEenheidPersonen = 1) verandert dit niets.
 */
function leesMomenten(momenten, perEenheidPersonen = 1) {
  const perEenheid = perEenheidPersonen && perEenheidPersonen > 0 ? perEenheidPersonen : 1;
  const beschikbaarheidPerMoment = (momenten || []).map((m) => {
    const eenhedenBeschikbaar = m.locaties?.[0]?.beschikbaarheid ?? 0;
    return {
      startmoment: m.startmoment,
      eenhedenBeschikbaar,
      personenCapaciteit: eenhedenBeschikbaar * perEenheid,
      overlapLast: m.overlapLast || 0,
      overlapItems: m.overlapItems || [],
    };
  });
  const capaciteit =
    beschikbaarheidPerMoment.length > 0
      ? Math.max(...beschikbaarheidPerMoment.map((m) => m.personenCapaciteit))
      : 0;
  return { beschikbaarheidPerMoment, capaciteit };
}

// Is er op dit moment een écht personen-conflict? Alleen als het totaal
// (al bezet door andere activiteiten + wat deze aanvraag vraagt) de totale
// bezoekersgroep zou overschrijden. Zo niet, mogen twee activiteiten prima
// gelijktijdig lopen (verschillende subgroepen van dezelfde bezoekersgroep).
function heeftConflict(moment, benodigdAantal, totaalGroep) {
  return moment.overlapItems.length > 0 && moment.overlapLast + benodigdAantal > totaalGroep;
}

/**
 * Stap 1: bepaalt of een groep in 1 moment past, of gesplitst moet worden.
 * `perEenheidPersonen`: zie leesMomenten (default 1 = puur per persoon).
 * `totaalGroep`: totale bezoekersgroep (voor de conflict-check bij overlap
 * met andere activiteiten in het mandje - default = aantal, dus geen
 * conflict-besef als dit niet wordt meegegeven).
 *
 * Geeft ALTIJD alle startmomenten van de dag terug in `opties`, elk met:
 *  - `beschikbaar`: genoeg CAPACITEIT (Recras-zijde)?
 *  - `conflict`: overlapt dit met iets anders in het mandje op een manier
 *    die de totale bezoekersgroep zou overschrijden?
 * zodat de klant volgeboekte tijden grijs, en overlappende-maar-wel-
 * beschikbare tijden als conflict (rood, oplosbaar) te zien krijgt, in
 * plaats van dat ze gewoon verdwijnen.
 *
 * Retourneert een van:
 *  - { status: 'enkel', capaciteit, opties: [...] }
 *  - { status: 'kies_starttijd', capaciteit, groepsgroottes: [..], opties: [...] }
 *  - { status: 'onmogelijk', reden: string, opties?: [...] }
 */
function planBoeking(momenten, aantal, perEenheidPersonen = 1, totaalGroep = aantal) {
  const { beschikbaarheidPerMoment, capaciteit } = leesMomenten(momenten, perEenheidPersonen);

  if (beschikbaarheidPerMoment.length === 0) {
    return { status: 'onmogelijk', reden: 'Geen startmomenten gevonden op deze dag.' };
  }
  if (capaciteit <= 0) {
    const opties = beschikbaarheidPerMoment.map((m) => ({
      ...m,
      eenhedenNodig: berekenBenodigdeEenheden(aantal, perEenheidPersonen),
      beschikbaar: false,
      conflict: false,
    }));
    return { status: 'onmogelijk', reden: 'Alle beschikbare tijden op deze dag zitten al vol.', opties };
  }

  if (aantal <= capaciteit) {
    const opties = beschikbaarheidPerMoment.map((m) => ({
      ...m,
      eenhedenNodig: berekenBenodigdeEenheden(aantal, perEenheidPersonen),
      beschikbaar: m.personenCapaciteit >= aantal,
      conflict: heeftConflict(m, aantal, totaalGroep),
    }));
    return { status: 'enkel', capaciteit, opties };
  }

  // Groep past niet in 1 moment: per-eenheid producten (fysieke, discrete
  // hulpbronnen zoals banen/cubes) vullen elk moment eerst zo vol mogelijk;
  // pure per-persoon producten verdelen eerlijk over de benodigde momenten.
  const groepsgroottes = perEenheidPersonen > 1
    ? verdeelGreedy(aantal, capaciteit)
    : verdeel(aantal, Math.ceil(aantal / capaciteit));

  const opties = beschikbaarheidPerMoment.map((m) => ({
    ...m,
    eenhedenNodig: berekenBenodigdeEenheden(groepsgroottes[0], perEenheidPersonen),
    beschikbaar: m.personenCapaciteit >= groepsgroottes[0],
    conflict: heeftConflict(m, groepsgroottes[0], totaalGroep),
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
 * overige subgroepen, te beginnen na het gekozen moment. Momenten die niet
 * genoeg capaciteit hebben ÓF die een echt personen-conflict zouden geven
 * met iets anders in het mandje worden overgeslagen.
 *
 * Retourneert:
 *  - { status: 'gesplitst', groepen: [{ aantal, startmoment, eenhedenNodig }, ...] }
 *  - { status: 'onmogelijk', reden: string }
 */
function planVervolgSchema(momenten, groepsgroottes, gekozenStartmoment, perEenheidPersonen = 1, totaalGroep = undefined) {
  const { beschikbaarheidPerMoment } = leesMomenten(momenten, perEenheidPersonen);
  const groep = totaalGroep ?? groepsgroottes.reduce((s, g) => s + g, 0);

  const startIndex = beschikbaarheidPerMoment.findIndex(
    (m) => m.startmoment === gekozenStartmoment
  );
  if (startIndex === -1) {
    return { status: 'onmogelijk', reden: 'De gekozen starttijd is niet (meer) gevonden op deze dag.' };
  }
  const eersteMoment = beschikbaarheidPerMoment[startIndex];
  if (eersteMoment.personenCapaciteit < groepsgroottes[0] || heeftConflict(eersteMoment, groepsgroottes[0], groep)) {
    return {
      status: 'onmogelijk',
      reden: 'Dit moment heeft inmiddels niet meer genoeg vrije plekken (of een overlap-conflict) voor de eerste subgroep. Ververs de beschikbaarheid en kies opnieuw.',
    };
  }

  const groepen = [{
    aantal: groepsgroottes[0],
    startmoment: gekozenStartmoment,
    eenhedenNodig: berekenBenodigdeEenheden(groepsgroottes[0], perEenheidPersonen),
  }];
  let idx = startIndex + 1;

  for (let i = 1; i < groepsgroottes.length; i++) {
    while (
      idx < beschikbaarheidPerMoment.length &&
      (beschikbaarheidPerMoment[idx].personenCapaciteit < groepsgroottes[i] ||
        heeftConflict(beschikbaarheidPerMoment[idx], groepsgroottes[i], groep))
    ) {
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

module.exports = {
  planBoeking,
  planVervolgSchema,
  verdeel,
  verdeelGreedy,
  berekenBenodigdeEenheden,
  annoteerOverlap,
  heeftConflict,
};
