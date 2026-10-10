import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dinnerBooking, hotelBooking, mixedTrip, oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function exportTrip(trip: unknown) {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
  const path = join(dir, "sample-japan-trip-2026-12-01.ics");
  return { result, ics: existsSync(path) ? readFileSync(path, "utf8") : undefined };
}

const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("stays and activities", () => {
  it("exports a stay as an all-day event from check-in to check-out", async () => {
    const { result, ics } = await exportTrip({ ...oneFlightTrip, bookings: [hotelBooking] });
    expect(result.isError).toBeFalsy();
    expect(ics).toContain("DTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261205\r\n");
    expect(ics).toContain("SUMMARY:Stay: Sample Hotel Tokyo\r\n");
  });

  it("exports an activity at its local time in its named zone", async () => {
    const { result, ics } = await exportTrip({ ...oneFlightTrip, bookings: [dinnerBooking] });
    expect(result.isError).toBeFalsy();
    expect(ics).toContain("DTSTART;TZID=Asia/Tokyo:20261203T200000\r\nDTEND;TZID=Asia/Tokyo:20261203T220000\r\n");
    expect(ics).toContain("TZID:Asia/Tokyo\r\nBEGIN:STANDARD");
  });

  it("rejects an activity with no time zone, telling Claude to work it out or ask", async () => {
    const { timeZone: _omitted, ...dinnerNoZone } = dinnerBooking.legs[0];
    const trip = { ...oneFlightTrip, bookings: [{ ...dinnerBooking, legs: [dinnerNoZone] }] };
    const { result, ics } = await exportTrip(trip);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("timeZone");
    expect(text).toMatch(/work out|ask the traveller/);
    expect(ics).toBeUndefined();
  });

  it("rejects a stay that checks out on or before check-in", async () => {
    const stay = { ...hotelBooking.legs[0], checkOut: "2026-12-02" };
    const { result } = await exportTrip({ ...oneFlightTrip, bookings: [{ ...hotelBooking, legs: [stay] }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("checkOut");
  });

  it("exports a trip mixing flights, stays and activities as the known-good file", async () => {
    const { result, ics } = await exportTrip(mixedTrip);
    expect(result.isError).toBeFalsy();
    const expected = readFileSync(join(import.meta.dirname, "fixtures", "mixed.ics"), "utf8");
    expect(unfold(ics!).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:20000101T000000Z")).toBe(expected);
  });
});
