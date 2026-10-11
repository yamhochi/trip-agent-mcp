import { createHash } from "node:crypto";
import type { Activity, Flight, Leg, Stay, Trip } from "./schema.js";

const CRLF = "\r\n";

/** Offset in minutes of `timeZone` from UTC at the given instant, plus its short name. */
function zoneAt(instant: number, timeZone: string): { offset: number; name: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "short",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const asUtc = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour"), +get("minute"), +get("second"));
  return { offset: Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000), name: get("timeZoneName") };
}

function wallClockAsUtc(localTime: string): number {
  const [d, t] = localTime.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return Date.UTC(y, mo - 1, da, h, mi);
}

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

/**
 * A leg's identity is a fingerprint of facts that do not change when a booking is amended: the
 * booking reference plus the flight number or property, never a time. A leg with no reference
 * falls back to its kind, name and original date, so moving it to another day makes a new event.
 */
function legId(booking: Booking, kind: Leg["kind"], name: string, date: string): string {
  return booking.reference ? uid("booked", booking.reference, kind, name) : uid("unbooked", kind, name, date);
}

function describeBooking(booking: Booking): string {
  const line = booking.reference
    ? `${booking.vendor} booking, code ending ${booking.reference.slice(-2)}`
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

function event(booking: Booking, id: string, stamp: string, dtstart: string, dtend: string, summary: string, location: string): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${id}`,
    `DTSTAMP:${stamp}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeText(summary)}`,
    `LOCATION:${escapeText(location)}`,
    `DESCRIPTION:${escapeText(describeBooking(booking))}`,
    ...(booking.source ? [`URL:${emailLink(booking.source)}`] : []),
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ];
}

const zoned = (name: string, timeZone: string, localTime: string) => `${name};TZID=${timeZone}:${compact(localTime)}`;
const allDay = (name: string, date: string) => `${name};VALUE=DATE:${date.replace(/-/g, "")}`;

function legEvent(booking: Booking, leg: Leg, stamp: string): string[] {
  switch (leg.kind) {
    case "flight":
      return flightEvent(booking, leg, stamp);
    case "stay":
      return stayEvent(booking, leg, stamp);
    case "activity":
      return activityEvent(booking, leg, stamp);
  }
}

function flightEvent(booking: Booking, leg: Flight, stamp: string): string[] {
  const { departure, arrival } = leg;
  return event(
    booking,
    legId(booking, "flight", leg.flightNumber, leg.departure.localTime.slice(0, 10)),
    stamp,
    zoned("DTSTART", departure.timeZone, departure.localTime),
    zoned("DTEND", arrival.timeZone, arrival.localTime),
    `Flight ${leg.flightNumber}: ${departure.location} to ${arrival.location}`,
    departure.location,
  );
}

function stayEvent(booking: Booking, leg: Stay, stamp: string): string[] {
  return event(
    booking,
    legId(booking, "stay", leg.property, leg.checkIn),
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
    legId(booking, "activity", leg.name, leg.start.slice(0, 10)),
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
    case "flight":
      return [leg.departure, leg.arrival];
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
