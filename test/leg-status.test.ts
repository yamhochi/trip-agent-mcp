import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dinnerBooking, hotelBooking, oneFlightTrip } from "./samples.js";
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
const uids = (ics: string) => [...ics.matchAll(/^UID:(.*)\r$/gm)].map((m) => m[1]);
const withStatus = (booking: { legs: object[] }, status: string) => ({ ...booking, legs: [{ ...booking.legs[0], status }] });
const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });

// Each status on its own booking; the idea is a Tokyo dinner that must not reach the file.
const ideaDinner = {
  vendor: "Sample Ramen",
  legs: [{ ...dinnerBooking.legs[0], status: "idea", name: "Dinner at Sample Ramen", timeZone: "Pacific/Auckland" }],
};
const allStatuses = trip(
  oneFlightTrip.bookings[0],
  withStatus(hotelBooking, "planned"),
  withStatus(dinnerBooking, "cancelled"),
  ideaDinner,
);

describe("confirmed, planned and cancelled legs", () => {
  it("exports a trip containing each status as the known-good file", async () => {
    const { result, ics } = await exportTrip(allStatuses);
    expect(result.isError).toBeFalsy();
    const expected = readFileSync(join(import.meta.dirname, "fixtures", "statuses.ics"), "utf8");
    expect(unfold(ics!).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:20000101T000000Z")).toBe(expected);
  });

  it.each([
    ["confirmed", "CONFIRMED"],
    ["planned", "TENTATIVE"],
    ["cancelled", "CANCELLED"],
  ])("exports a %s leg as STATUS:%s", async (status, ical) => {
    const { ics } = await exportTrip(trip(withStatus(hotelBooking, status)));
    expect(ics).toContain(`STATUS:${ical}\r\n`);
  });

  it("keeps the id of the event a leg cancels", async () => {
    const before = await exportTrip(trip(hotelBooking));
    const after = await exportTrip(trip(withStatus(hotelBooking, "cancelled")));
    expect(uids(after.ics!)).toEqual(uids(before.ics!));
    expect(after.ics).toContain("STATUS:CANCELLED\r\n");
  });

  it("keeps the id of a leg with no booking reference when it is cancelled", async () => {
    const { reference: _none, ...unbooked } = dinnerBooking;
    const before = await exportTrip(trip(unbooked));
    const after = await exportTrip(trip(withStatus(unbooked, "cancelled")));
    expect(uids(after.ics!)).toEqual(uids(before.ics!));
  });

  it("keeps the id when a planned leg is later confirmed", async () => {
    const planned = await exportTrip(trip(withStatus(hotelBooking, "planned")));
    const confirmed = await exportTrip(trip(hotelBooking));
    expect(uids(confirmed.ics!)).toEqual(uids(planned.ics!));
  });

  it("leaves ideas out of the file, with their time zone", async () => {
    const { result, ics } = await exportTrip(allStatuses);
    expect(result.isError).toBeFalsy();
    expect(ics).not.toContain("Sample Ramen");
    expect(ics).not.toContain("Pacific/Auckland");
    // The flight and its check-in block, the planned hotel and the cancelled dinner; the idea is left out.
    expect(ics!.match(/BEGIN:VEVENT/g)).toHaveLength(4);
  });

  it("writes nothing, and says why, when every leg is an idea", async () => {
    // A calendar file needs at least one event to be valid, so there is nothing to write.
    const { result, ics } = await exportTrip(trip(ideaDinner));
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/nothing was exported/i);
    expect(textOf(result)).toMatch(/idea/i);
    expect(ics).toBeUndefined();
  });

  it("leaves an earlier export untouched when a later one has only ideas", async () => {
    const dir = join(makeHome(), "out");
    const server = await startServer({ TRIP_AGENT_DIR: dir });
    open.push(server);
    const path = join(dir, "sample-japan-trip-2026-12-01.ics");
    await server.client.callTool({ name: "export_trip", arguments: { trip: trip(hotelBooking) } });
    const before = readFileSync(path, "utf8");
    const result = await server.client.callTool({ name: "export_trip", arguments: { trip: trip(ideaDinner) } });
    expect(result.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(before).toContain("BEGIN:VEVENT");
  });

  it("rejects a status it does not know", async () => {
    const { result, ics } = await exportTrip(trip(withStatus(hotelBooking, "maybe")));
    expect(result.isError).toBe(true);
    expect(ics).toBeUndefined();
  });
});
