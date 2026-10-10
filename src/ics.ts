import { createHash } from "node:crypto";
import type { Flight, Trip } from "./schema.js";

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

function flightUid(reference: string, flightNumber: string): string {
  const digest = createHash("sha256").update(`${reference}|${flightNumber}`).digest("hex").slice(0, 32);
  return `${digest}@trip-agent-mcp`;
}

function flightEvent(vendor: string, reference: string, leg: Flight, stamp: string): string[] {
  const { departure, arrival } = leg;
  return [
    "BEGIN:VEVENT",
    `UID:${flightUid(reference, leg.flightNumber)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${departure.timeZone}:${compact(departure.localTime)}`,
    `DTEND;TZID=${arrival.timeZone}:${compact(arrival.localTime)}`,
    `SUMMARY:${escapeText(`Flight ${leg.flightNumber}: ${departure.location} to ${arrival.location}`)}`,
    `LOCATION:${escapeText(departure.location)}`,
    `DESCRIPTION:${escapeText(`${vendor} booking, code ending ${reference.slice(-2)}`)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ];
}

export function buildCalendar(trip: Trip, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const events: string[][] = [];
  const zones = new Map<string, string[]>();
  for (const b of trip.bookings) {
    for (const leg of b.legs) {
      for (const end of [leg.departure, leg.arrival]) {
        if (!zones.has(end.timeZone)) zones.set(end.timeZone, vtimezone(end.timeZone, end.localTime));
      }
      events.push(flightEvent(b.vendor, b.reference, leg, stamp));
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
