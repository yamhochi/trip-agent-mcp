import type { Flight, Leg, Stay, Trip } from "./schema.js";

export type Gap = { rule: "unbooked-night" | "broken-chain" | "missing-return"; message: string };

const DAY = 86_400_000;
const dayOf = (localTime: string) => localTime.slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd) + n * DAY).toISOString().slice(0, 10);

/** Only legs that stand count: ideas were never decided on and cancelled legs are gone. A planned leg counts, booked or not. */
function standingLegs(trip: Trip): Leg[] {
  return trip.bookings.flatMap((b) => b.legs).filter((l) => l.status === "confirmed" || l.status === "planned");
}

const words = (place: string): string[] => place.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Same place if one name's words all appear in the other ("Tokyo" in "Tokyo Haneda (HND)"), or they start with the same word. */
function samePlace(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  if (wa[0] === wb[0]) return true;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

function unbookedNights(legs: Leg[], startDate: string): Gap[] {
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
    } else if (dayOf(leg.end) > last) {
      last = dayOf(leg.end);
    }
  }
  const gaps: Gap[] = [];
  let runStart: string | undefined;
  const close = (runEnd: string) => {
    if (!runStart) return;
    const nights = (Date.parse(runEnd) - Date.parse(runStart)) / DAY + 1;
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
    gaps.push({
      rule: "broken-chain",
      message: `Broken location chain: flight ${before.flightNumber} arrives in ${before.arrival.location}, but flight ${next.flightNumber} leaves from ${leftFrom}. Nothing is booked or planned to get from one to the other.`,
    });
  }
  return gaps;
}

function missingReturn(legs: Leg[], homeCity: string): Gap[] {
  const positions = legs.flatMap((l) =>
    l.kind === "flight"
      ? [{ at: l.arrival.localTime, where: l.arrival.location }]
      : l.kind === "stay"
        ? [{ at: `${l.checkOut}T00:00`, where: l.location }]
        : [],
  );
  const final = positions.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
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
  return [...unbookedNights(legs, trip.startDate), ...brokenChains(legs), ...missingReturn(legs, trip.homeCity)];
}

export function hasStandingLegs(trip: Trip): boolean {
  return standingLegs(trip).length > 0;
}
