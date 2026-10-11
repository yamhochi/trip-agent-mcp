import type { Leg, Trip } from "./schema.js";
import { instantOf } from "./time.js";

export type Gap = { rule: "unbooked-night" | "broken-chain" | "missing-return"; message: string };

const MS_PER_DAY = 86_400_000;
const dayOf = (localTime: string) => localTime.slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd) + n * MS_PER_DAY).toISOString().slice(0, 10);

/** Only legs that stand count: ideas were never decided on and cancelled legs are gone. A planned leg counts, booked or not. */
function standingLegs(trip: Trip): Leg[] {
  return trip.bookings.flatMap((b) => b.legs).filter((l) => l.status === "confirmed" || l.status === "planned");
}

type Stop = { location: string; localTime: string; timeZone: string };
type Journey = { label: string; from: Stop; to: Stop };

/** A travel leg of any mode, as the traveller would name it: "flight JL044", "train N700", "the ferry". */
function journeyOf(leg: Leg): Journey | undefined {
  if (leg.kind === "travel") {
    const name = leg.mode === "other" ? "journey" : leg.mode;
    return { label: leg.identifier ? `${name} ${leg.identifier}` : `the ${name}`, from: leg.from, to: leg.to };
  }
  return undefined;
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

const FILLER = new Set(["airport", "international", "station", "central", "terminal", "hotel"]);

/** Looser: the two names share a real place name ("Shinjuku, Tokyo" and "Tokyo Haneda (HND)" both say Tokyo). Used where a stay is involved, because a stay is named by its neighbourhood or city and a journey by its airport or station. */
function sameArea(a: string, b: string): boolean {
  if (samePlace(a, b)) return true;
  const named = new Set(words(a).filter((w) => w.length >= 4 && !FILLER.has(w)));
  return words(b).some((w) => named.has(w));
}

/** Two names that start alike but are not the same place may be two airports of one city. */
const mayBeSameCity = (a: string, b: string) => words(a)[0] === words(b)[0];

function unbookedNights(legs: Leg[], startDate: string, returnedHome: boolean): Gap[] {
  const covered = new Set<string>();
  let last = startDate;
  const cover = (from: string, to: string) => {
    for (let d = from; d < to; d = addDays(d, 1)) covered.add(d);
  };
  let journey: Journey | undefined;
  for (const leg of legs) {
    if (leg.kind === "stay") {
      cover(leg.checkIn, leg.checkOut);
      if (leg.checkOut > last) last = leg.checkOut;
    } else if ((journey = journeyOf(leg))) {
      // A night spent in the air, or on a train, is not unbooked.
      cover(dayOf(journey.from.localTime), dayOf(journey.to.localTime));
      if (dayOf(journey.to.localTime) > last) last = dayOf(journey.to.localTime);
    } else if (leg.kind === "activity" && !returnedHome && dayOf(leg.end) > last) {
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

/** One step of the trip in time order: a journey, or a stay. */
type Step = { at: number; arrives: string; leaves: string; endsWith: string; startsWith: string; stay: boolean };

function steps(legs: Leg[]): Step[] {
  const stops = legs.flatMap((leg) => {
    const journey = journeyOf(leg);
    return journey ? [journey.from, journey.to] : [];
  });
  // A stay has no time zone of its own; the zone of a journey that starts or ends in the same area is the best guide, and UTC is the fallback.
  const zoneAt = (place: string) => stops.find((stop) => sameArea(stop.location, place))?.timeZone ?? "UTC";
  return legs
    .flatMap((leg): Step[] => {
      const journey = journeyOf(leg);
      if (journey) {
        return [
          {
            at: instantOf(journey.from.localTime, journey.from.timeZone),
            leaves: journey.from.location,
            arrives: journey.to.location,
            startsWith: `${journey.label} leaves from ${journey.from.location}`,
            endsWith: `${journey.label} arrives in ${journey.to.location}`,
            stay: false,
          },
        ];
      }
      if (leg.kind === "stay") {
        // A stay places the traveller from the day they check in; the end of that day keeps a same-day journey before it.
        return [
          {
            at: instantOf(`${leg.checkIn}T23:59`, zoneAt(leg.location)),
            leaves: leg.location,
            arrives: leg.location,
            startsWith: `the next stay, ${leg.property}, is in ${leg.location}`,
            endsWith: `the stay at ${leg.property} is in ${leg.location}`,
            stay: true,
          },
        ];
      }
      return [];
    })
    .sort((a, b) => a.at - b.at);
}

function brokenChains(legs: Leg[]): Gap[] {
  const all = steps(legs);
  const gaps: Gap[] = [];
  for (let i = 1; i < all.length; i++) {
    const [before, next] = [all[i - 1], all[i]];
    // Two journeys must meet at the same place; once a stay is involved, sharing a place name is enough.
    const connected = before.stay || next.stay ? sameArea(before.arrives, next.leaves) : samePlace(before.arrives, next.leaves);
    if (connected) continue;
    const maybe =
      !before.stay && !next.stay && mayBeSameCity(before.arrives, next.leaves)
        ? " These may be two airports of the same city: check with the traveller before treating it as a gap."
        : "";
    gaps.push({
      rule: "broken-chain",
      message: `Broken location chain: ${before.endsWith}, but ${next.startsWith}. Nothing is booked or planned to get from one to the other.${maybe}`,
    });
  }
  return gaps;
}

/** Where the traveller is at the end: the latest arrival of any journey, or the latest stay (from its check-in, so a journey home before check-out still counts). */
function finalPosition(legs: Leg[]): { at: number; where: string } | undefined {
  const stops = legs.flatMap((l) => {
    const journey = journeyOf(l);
    return journey ? [journey.from, journey.to] : [];
  });
  const zoneFor = (place: string) => stops.find((stop) => sameArea(stop.location, place))?.timeZone ?? "UTC";
  const positions = legs.flatMap((l) => {
    const journey = journeyOf(l);
    if (journey) return [{ at: instantOf(journey.to.localTime, journey.to.timeZone), where: journey.to.location }];
    return l.kind === "stay" ? [{ at: instantOf(`${l.checkIn}T00:00`, zoneFor(l.location)), where: l.location }] : [];
  });
  return positions.sort((a, b) => a.at - b.at).at(-1);
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
