import { createHash } from "node:crypto";
import type { Activity, Leg, Stay, Travel, Trip } from "./schema.js";
import { wallClockAsUtc, zoneAt } from "./time.js";

const CRLF = "\r\n";

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

/** A VTIMEZONE holding the one offset in force at the event, which is all an importer needs. */
function vtimezone(timeZone: string, localTime: string): string[] {
  const wall = wallClockAsUtc(localTime);
  const guess = zoneAt(wall, timeZone).offset;
  const { offset, name } = zoneAt(wall - guess * 60000, timeZone);
  const year = Number(localTime.slice(0, 4));
  const standard = Math.min(
    zoneAt(Date.UTC(year, 0, 1), timeZone).offset,
    zoneAt(Date.UTC(year, 6, 1), timeZone).offset,
  );
  const kind = offset > standard ? "DAYLIGHT" : "STANDARD";
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${timeZone}`,
    `BEGIN:${kind}`,
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${formatOffset(offset)}`,
    `TZOFFSETTO:${formatOffset(offset)}`,
    `TZNAME:${name}`,
    `END:${kind}`,
    "END:VTIMEZONE",
  ];
}

/** Escape a text value so that no field can carry calendar syntax. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Fold a content line at 75 octets, never inside a multi-byte character. */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join(CRLF + " ");
}

const compact = (localTime: string) => localTime.replace(/[-:]/g, "") + "00";

function uid(...facts: string[]): string {
  // JSON keeps the facts apart, so a "|" or quote inside a name cannot make two sets of facts hash alike.
  const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
  return `${digest}@trip-agent-mcp`;
}

type Booking = Trip["bookings"][number];

const squash = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
const tidy = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A leg's identity is a fingerprint of facts that do not change when a booking is amended: the
 * booking reference plus the mode and number of a journey, the property of a stay or the name of an
 * activity, never a time. Claude re-reads the emails each time and may write the same fact slightly
 * differently ("abc-123", "JL 044", extra spaces), so each fact is tidied first: references and
 * journey numbers keep only letters and digits, names ignore case and spacing. A leg with no
 * reference falls back to its kind, its name and its original date, so moving it to another day
 * makes a new event.
 */
function legId(booking: Booking, kind: string, fact: string, date: string): string {
  if (!booking.reference) return uid("unbooked", kind, fact, date);
  return uid("booked", squash(booking.reference) || tidy(booking.reference), kind, fact);
}

/** The last two characters, or nothing at all for a code too short to show any of without giving it away. */
const maskedCode = (reference: string) => (reference.length > 2 ? reference.slice(-2) : "hidden");

function describeBooking(booking: Booking): string {
  const line = booking.reference
    ? `${booking.vendor} booking, code ending ${maskedCode(booking.reference)}`
    : `${booking.vendor} (no booking reference)`;
  return booking.note ? `${line}\n${booking.note}` : line;
}

/** A search in the traveller's mailbox that finds the one email, built from the source alone. */
function emailLink(source: NonNullable<Booking["source"]>): string {
  const [y, m, d] = source.receivedDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const ymd = (dt: Date) => `${dt.getUTCFullYear()}/${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  const query = `rfc822msgid:${source.messageId.replace(/^<|>$/g, "")} from:${source.senderDomain} after:${y}/${m}/${d} before:${ymd(next)}`;
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

const eventStatus = { confirmed: "CONFIRMED", planned: "TENTATIVE", cancelled: "CANCELLED", idea: "CONFIRMED" } as const;

function event(booking: Booking, status: Leg["status"], id: string, stamp: string, dtstart: string, dtend: string, summary: string, location: string): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${id}`,
    `DTSTAMP:${stamp}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeText(summary)}`,
    `LOCATION:${escapeText(location)}`,
    `DESCRIPTION:${escapeText(describeBooking(booking))}`,
    ...(booking.source ? [`URL:${booking.source.link ?? emailLink(booking.source)}`] : []),
    `STATUS:${eventStatus[status]}`,
    "END:VEVENT",
  ];
}

const zoned = (name: string, timeZone: string, localTime: string) => `${name};TZID=${timeZone}:${compact(localTime)}`;
const allDay = (name: string, date: string) => `${name};VALUE=DATE:${date.replace(/-/g, "")}`;

function legEvent(booking: Booking, leg: Leg, stamp: string): string[] {
  switch (leg.kind) {
    case "travel":
      return travelEvent(booking, leg, stamp);
    case "stay":
      return stayEvent(booking, leg, stamp);
    case "activity":
      return activityEvent(booking, leg, stamp);
  }
}

const modeLabel = { flight: "Flight", train: "Train", ferry: "Ferry", bus: "Bus", car: "Car", other: "Travel" } as const;

function travelEvent(booking: Booking, leg: Travel, stamp: string): string[] {
  const { from, to } = leg;
  // A journey is named by its number when it has one, and by where it goes when it has not.
  const fact = leg.identifier ? squash(leg.identifier) : `${tidy(from.location)}>${tidy(to.location)}`;
  return event(
    booking,
    leg.status,
    legId(booking, leg.mode, fact, from.localTime.slice(0, 10)),
    stamp,
    zoned("DTSTART", from.timeZone, from.localTime),
    zoned("DTEND", to.timeZone, to.localTime),
    `${modeLabel[leg.mode]}${leg.identifier ? ` ${leg.identifier}` : ""}: ${from.location} to ${to.location}`,
    from.location,
  );
}

function stayEvent(booking: Booking, leg: Stay, stamp: string): string[] {
  return event(
    booking,
    leg.status,
    legId(booking, "stay", tidy(leg.property), leg.checkIn),
    stamp,
    allDay("DTSTART", leg.checkIn),
    allDay("DTEND", leg.checkOut),
    `Stay: ${leg.property}`,
    leg.location,
  );
}

function activityEvent(booking: Booking, leg: Activity, stamp: string): string[] {
  return event(
    booking,
    leg.status,
    legId(booking, "activity", tidy(leg.name), leg.start.slice(0, 10)),
    stamp,
    zoned("DTSTART", leg.timeZone, leg.start),
    zoned("DTEND", leg.timeZone, leg.end),
    `Activity: ${leg.name}`,
    leg.location,
  );
}

/** Every zoned time in the leg, so each zone used gets a VTIMEZONE. */
function zonedTimes(leg: Leg): { timeZone: string; localTime: string }[] {
  switch (leg.kind) {
    case "travel":
      return [leg.from, leg.to];
    case "stay":
      return [];
    case "activity":
      return [
        { timeZone: leg.timeZone, localTime: leg.start },
        { timeZone: leg.timeZone, localTime: leg.end },
      ];
  }
}

export function buildCalendar(trip: Trip, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const events: string[][] = [];
  const zones = new Map<string, string[]>();
  for (const b of trip.bookings) {
    for (const leg of b.legs) {
      // An idea is never exported, and takes no time zone definition with it.
      if (leg.status === "idea") continue;
      for (const end of zonedTimes(leg)) {
        if (!zones.has(end.timeZone)) zones.set(end.timeZone, vtimezone(end.timeZone, end.localTime));
      }
      events.push(legEvent(b, leg, stamp));
    }
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//trip-agent-mcp//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(trip.name)}`,
    ...[...zones.keys()].sort().flatMap((k) => zones.get(k)!),
    ...events.flat(),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join(CRLF) + CRLF;
}
