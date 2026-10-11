import type { Flight, Leg, Stay, Trip } from "./schema.js";

export type Gap = { rule: "unbooked-night" | "broken-chain" | "missing-return"; message: string };

const MS_PER_DAY = 86_400_000;
const dayOf = (localTime: string) => localTime.slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd) + n * MS_PER_DAY).toISOString().slice(0, 10);

/** Only legs that stand count: ideas were never decided on and cancelled legs are gone. A planned leg counts, booked or not. */
function standingLegs(trip: Trip): Leg[] {
  return trip.bookings.flatMap((b) => b.legs).filter((l) => l.status === "confirmed" || l.status === "planned");
}

const words = (place: string): string[] => place.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Same place if one name's words all appear in the other ("Tokyo" in "Tokyo Haneda (HND)"). Sharing only a first word is not enough: "New York" is not "New Delhi". */
function samePlace(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

/** Two names that start alike but are not the same place may be two airports of one city. */
const mayBeSameCity = (a: string, b: string) => words(a)[0] === words(b)[0];

function unbookedNights(legs: Leg[], startDate: string, returnedHome: boolean): Gap[] {
  const covered = new Set<string>();
  let last = startDate;
  const cover = (from: string, to: string) => {
    for (let d = from; d < to; d = addDays(d, 1)) covered.add(d);
  };
  for (const leg of legs) {
    if (leg.kind === "stay") {
      cover(leg.checkIn, leg.checkOut);
      if (leg.checkOut > last) last = leg.checkOut;
    } else if (leg.kind === "flight") {
      // A night spent in the air is not unbooked.
      cover(dayOf(leg.departure.localTime), dayOf(leg.arrival.localTime));
      if (dayOf(leg.arrival.localTime) > last) last = dayOf(leg.arrival.localTime);
    } else if (!returnedHome && dayOf(leg.end) > last) {
      // An activity shows the traveller is still away, but not once they are home: a dinner after the flight home is not a night away.
      last = dayOf(leg.end);
    }
  }
  const gaps: Gap[] = [];
  let runStart: string | undefined;
  const close = (runEnd: string) => {
    if (!runStart) return;
    const nights = (Date.parse(runEnd) - Date.parse(runStart)) / MS_PER_DAY + 1;
    gaps.push({
      rule: "unbooked-night",
      message:
        nights === 1
          ? `Unbooked night: nothing is booked or planned for the night of ${runStart}.`
          : `Unbooked night: nothing is booked or planned for the ${nights} nights from ${runStart} to ${runEnd}.`,
    });
    runStart = undefined;
  };
  let prev = startDate;
  for (let d = startDate; d < last; d = addDays(d, 1)) {
    if (covered.has(d)) close(prev);
    else runStart ??= d;
    prev = d;
  }
  close(prev);
  return gaps;
}

function brokenChains(legs: Leg[]): Gap[] {
  const flights = legs.filter((l): l is Flight => l.kind === "flight").sort((a, b) => a.departure.localTime.localeCompare(b.departure.localTime));
  const stays = legs.filter((l): l is Stay => l.kind === "stay");
  const gaps: Gap[] = [];
  for (let i = 1; i < flights.length; i++) {
    const [before, next] = [flights[i - 1], flights[i]];
    const leftFrom = next.departure.location;
    if (samePlace(before.arrival.location, leftFrom)) continue;
    // A stay in the departure city between the two flights explains how the traveller got there (a train, say).
    const explained = stays.some(
      (s) => s.checkIn <= dayOf(next.departure.localTime) && s.checkOut >= dayOf(before.arrival.localTime) && samePlace(s.location, leftFrom),
    );
    if (explained) continue;
    const maybe = mayBeSameCity(before.arrival.location, leftFrom)
      ? " These may be two airports of the same city: check with the traveller before treating it as a gap."
      : "";
    gaps.push({
      rule: "broken-chain",
      message: `Broken location chain: flight ${before.flightNumber} arrives in ${before.arrival.location}, but flight ${next.flightNumber} leaves from ${leftFrom}. Nothing is booked or planned to get from one to the other.${maybe}`,
    });
  }
  return gaps;
}

/** Where the traveller is at the end: the latest flight arrival, or the latest stay (from its check-in, so a flight home before check-out still counts). */
function finalPosition(legs: Leg[]): { at: string; where: string } | undefined {
  const positions = legs.flatMap((l) =>
    l.kind === "flight"
      ? [{ at: l.arrival.localTime, where: l.arrival.location }]
      : l.kind === "stay"
        ? [{ at: `${l.checkIn}T00:00`, where: l.location }]
        : [],
  );
  return positions.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}

function missingReturn(legs: Leg[], homeCity: string): Gap[] {
  const final = finalPosition(legs);
  if (!final || samePlace(final.where, homeCity)) return [];
  return [
    {
      rule: "missing-return",
      message: `Missing return: the trip ends in ${final.where}, and nothing is booked or planned to take the traveller back to ${homeCity}.`,
    },
  ];
}

/** Plain rules over the trip as given; nothing is stored between calls. */
export function findGaps(trip: Trip): Gap[] {
  const legs = standingLegs(trip);
  const final = finalPosition(legs);
  const returnedHome = final !== undefined && samePlace(final.where, trip.homeCity);
  return [...unbookedNights(legs, trip.startDate, returnedHome), ...brokenChains(legs), ...missingReturn(legs, trip.homeCity)];
}

export function hasStandingLegs(trip: Trip): boolean {
  return standingLegs(trip).length > 0;
}
