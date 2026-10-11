import type { Leg, Trip } from "./schema.js";
import { instantOf } from "./time.js";
import { mayBeSameCity, sameArea, samePlace, tidy } from "./places.js";

export type GapRule = "unbooked-night" | "broken-chain" | "missing-return";

/**
 * Something the trip is missing. `message` is for Claude to relay; `title`, `start` and `end` (the day after
 * the last day, as an all-day event ends) are for the calendar placeholder; `facts` are what the gap's identity
 * is made of, never a time of day, so the same gap has the same id on every export. `from` and `to` are the
 * two places of a broken chain, or the home city of a missing return, so that the leg that later covers it can be found.
 */
export type Gap = { rule: GapRule; message: string; title: string; start: string; end: string; facts: string[]; from?: string; to?: string };

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
      title: "Missing: no lodging booked",
      start: runStart,
      end: addDays(runEnd, 1),
      facts: [runStart],
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
type Step = { at: number; day: string; arrives: string; leaves: string; endsWith: string; startsWith: string; stay: boolean };

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
            day: dayOf(journey.from.localTime),
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
            day: leg.checkIn,
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
      title: `Missing: no way to get from ${before.arrives} to ${next.leaves}`,
      start: next.day,
      end: addDays(next.day, 1),
      facts: [tidy(before.arrives), tidy(next.leaves)],
      from: before.arrives,
      to: next.leaves,
      message: `Broken location chain: ${before.endsWith}, but ${next.startsWith}. Nothing is booked or planned to get from one to the other.${maybe}`,
    });
  }
  return gaps;
}

/** Where the traveller is at the end: the latest arrival of any journey, or the latest stay (from its check-in, so a journey home before check-out still counts). */
function finalPosition(legs: Leg[]): { at: number; day: string; where: string } | undefined {
  const stops = legs.flatMap((l) => {
    const journey = journeyOf(l);
    return journey ? [journey.from, journey.to] : [];
  });
  const zoneFor = (place: string) => stops.find((stop) => sameArea(stop.location, place))?.timeZone ?? "UTC";
  const positions = legs.flatMap((l) => {
    const journey = journeyOf(l);
    if (journey) return [{ at: instantOf(journey.to.localTime, journey.to.timeZone), day: dayOf(journey.to.localTime), where: journey.to.location }];
    return l.kind === "stay" ? [{ at: instantOf(`${l.checkIn}T00:00`, zoneFor(l.location)), day: l.checkIn, where: l.location }] : [];
  });
  return positions.sort((a, b) => a.at - b.at).at(-1);
}

function missingReturn(legs: Leg[], homeCity: string): Gap[] {
  const final = finalPosition(legs);
  if (!final || samePlace(final.where, homeCity)) return [];
  return [
    {
      rule: "missing-return",
      title: `Missing: no way back to ${homeCity}`,
      start: final.day,
      end: addDays(final.day, 1),
      facts: [tidy(homeCity)],
      to: homeCity,
      message: `Missing return: the trip ends in ${final.where}, and nothing is booked or planned to take the traveller back to ${homeCity}.`,
    },
  ];
}

/** Plain rules over the trip as given; nothing is stored between calls. */
export function findGaps(trip: Trip): Gap[] {
  const legs = standingLegs(trip);
  const final = finalPosition(legs);
  const returnedHome = final !== undefined && samePlace(final.where, trip.homeCity);
  const gaps = [...unbookedNights(legs, trip.startDate, returnedHome), ...brokenChains(legs), ...missingReturn(legs, trip.homeCity)];
  // Two gaps made of the same facts (two breaks between the same two places) are told apart by their order in the trip, which a moved date does not change.
  const seen = new Map<string, number>();
  return gaps.map((gap) => {
    const key = JSON.stringify([gap.rule, ...gap.facts]);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? gap : { ...gap, facts: [...gap.facts, String(n)] };
  });
}

export function hasStandingLegs(trip: Trip): boolean {
  return standingLegs(trip).length > 0;
}

/** What an earlier export recorded about a gap, enough to find the leg that has since covered it. */
export type RecordedGap = { rule: GapRule; id: string; start: string; from?: string; to?: string };

/** The standing leg that now covers a recorded gap, named as the traveller would: "flight SA999", "the stay at Sample Hotel". */
export function coveringLeg(trip: Trip, gap: RecordedGap): string | undefined {
  const legs = standingLegs(trip);
  for (const leg of legs) {
    const journey = journeyOf(leg);
    if (gap.rule === "unbooked-night") {
      if (leg.kind === "stay" && leg.checkIn <= gap.start && gap.start < leg.checkOut) return `the stay at ${leg.property}`;
      if (journey && dayOf(journey.from.localTime) <= gap.start && gap.start < dayOf(journey.to.localTime)) return journey.label;
    } else if (journey && gap.rule === "broken-chain") {
      if (gap.from && gap.to && sameArea(journey.from.location, gap.from) && sameArea(journey.to.location, gap.to)) return journey.label;
    } else if (journey && gap.rule === "missing-return") {
      if (gap.to && samePlace(journey.to.location, gap.to) && dayOf(journey.to.localTime) >= gap.start) return journey.label;
    }
  }
  return undefined;
}
