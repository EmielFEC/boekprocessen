// Groep-splitsing logica.
//
// Uitgangspunt: als een groep groter is dan de capaciteit van een los
// startmoment, wordt de groep zo gelijk mogelijk verdeeld over meerdere
// startmomenten op dezelfde dag. Dit is pure berekening (geen Recras-calls),
// wat het makkelijk maakt om los te testen en later te verfijnen.

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
 * Bepaalt een boekingsvoorstel voor een gegeven aantal personen, op basis
 * van de ruwe Recras-beschikbaarheidsdata (zoals teruggegeven door
 * GET /api2/producten/{id}/beschikbaarheid, al gesorteerd op tijd).
 *
 * We nemen de hoogste geziene capaciteit op de dag als "volledige
 * capaciteit per moment" - dat is een aanname (zie README): als alle
 * momenten die dag al deels volgeboekt zijn, onderschatten we de echte
 * volledige capaciteit.
 *
 * Retourneert een van:
 *  - { status: 'enkel', capaciteit, opties: [{ startmoment, beschikbaarheid }] }
 *  - { status: 'gesplitst', capaciteit, groepen: [{ aantal, startmoment }] }
 *  - { status: 'onmogelijk', reden: string }
 */
function planBoeking(momenten, aantal) {
  if (!Array.isArray(momenten) || momenten.length === 0) {
    return { status: 'onmogelijk', reden: 'Geen startmomenten gevonden op deze dag.' };
  }

  const beschikbaarheidPerMoment = momenten.map((m) => ({
    startmoment: m.startmoment,
    beschikbaarheid: m.locaties?.[0]?.beschikbaarheid ?? 0,
  }));

  const capaciteit = Math.max(...beschikbaarheidPerMoment.map((m) => m.beschikbaarheid));

  if (capaciteit <= 0) {
    return { status: 'onmogelijk', reden: 'Geen enkel moment heeft nog vrije plekken op deze dag.' };
  }

  // Past de hele groep in een los moment? Laat dan gewoon alle passende
  // momenten zien, net als bij een normale (niet-gesplitste) boeking.
  if (aantal <= capaciteit) {
    const opties = beschikbaarheidPerMoment.filter((m) => m.beschikbaarheid >= aantal);
    return { status: 'enkel', capaciteit, opties };
  }

  // Groep is te groot voor 1 moment: verdeel over meerdere momenten.
  const aantalGroepen = Math.ceil(aantal / capaciteit);
  const sizes = verdeel(aantal, aantalGroepen);

  const gekozenGroepen = [];
  let momentIndex = 0;

  for (const groepsgrootte of sizes) {
    // Zoek het eerstvolgende (nog niet gebruikte) moment dat groot genoeg is.
    while (
      momentIndex < beschikbaarheidPerMoment.length &&
      beschikbaarheidPerMoment[momentIndex].beschikbaarheid < groepsgrootte
    ) {
      momentIndex++;
    }

    if (momentIndex >= beschikbaarheidPerMoment.length) {
      return {
        status: 'onmogelijk',
        reden: `Niet genoeg opeenvolgende beschikbare momenten op deze dag voor een groep van ${aantal} personen (capaciteit per moment: ${capaciteit}). Probeer een andere dag of splits handmatig.`,
      };
    }

    gekozenGroepen.push({
      aantal: groepsgrootte,
      startmoment: beschikbaarheidPerMoment[momentIndex].startmoment,
    });
    momentIndex++; // volgende groep krijgt een ander moment
  }

  return { status: 'gesplitst', capaciteit, groepen: gekozenGroepen };
}

module.exports = { planBoeking, verdeel };
