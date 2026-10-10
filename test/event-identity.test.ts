import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dinnerBooking, hotelBooking, mixedTrip, oneFlightTrip } from "./samples.js";
import { makeHome, startServer } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

type Trip = typeof oneFlightTrip;

/** Export trips the way Claude would and read back what landed in the folder. */
async function exporter() {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  return {
    async export(trip: unknown) {
      const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      const [file] = readdirSync(dir).filter((f) => f.endsWith(".ics"));
      return readFileSync(join(dir, file), "utf8");
    },
  };
}

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const lines = (ics: string) => unfold(ics).split("\r\n").filter(Boolean);

/** Event titles mapped to their ids, so a test reads "the flight's id". */
function idsBySummary(ics: string): Map<string, string> {
  const ids = new Map<string, string>();
  let uid = "";
  for (const line of lines(ics)) {
    if (line.startsWith("UID:")) uid = line.slice(4);
    if (line.startsWith("SUMMARY:")) ids.set(line.slice(8), uid);
  }
  return ids;
}

const idOf = (ics: string, summaryStart: string) => {
  const found = [...idsBySummary(ics)].find(([summary]) => summary.startsWith(summaryStart));
  expect(found, `no event starting "${summaryStart}"`).toBeDefined();
  return found![1];
};

/** A dinner the traveller planned themselves: there is no booking reference. */
const plannedDinner = (overrides: Record<string, string> = {}) => ({
  vendor: "Sample Sushi",
  legs: [{ ...dinnerBooking.legs[0], ...overrides }],
});
const tripWith = (...bookings: unknown[]) => ({ ...oneFlightTrip, bookings });

describe("event identity", () => {
  it("gives a leg with no booking reference the same id every time, from its type, name and date", async () => {
    const e = await exporter();
    const first = idOf(await e.export(tripWith(plannedDinner())), "Activity: Dinner at Sample Sushi");
    const again = idOf(await e.export(tripWith(plannedDinner())), "Activity: Dinner at Sample Sushi");
    expect(first).toMatch(/^[0-9a-f]{32}@trip-agent-mcp$/);
    expect(again).toBe(first);
  });

  it("keeps a reference-less leg's id when its time changes, and gives a new id for another day or name", async () => {
    const e = await exporter();
    const title = "Activity: Dinner at Sample Sushi";
    const original = idOf(await e.export(tripWith(plannedDinner())), title);
    const later = idOf(await e.export(tripWith(plannedDinner({ start: "2026-12-03T21:00", end: "2026-12-03T23:00" }))), title);
    const nextDay = idOf(
      await e.export(tripWith(plannedDinner({ start: "2026-12-04T20:00", end: "2026-12-04T22:00" }))),
      title,
    );
    const renamed = idOf(
      await e.export(tripWith(plannedDinner({ name: "Dinner at Another Place" }))),
      "Activity: Dinner at Another Place",
    );
    expect(later).toBe(original);
    expect(nextDay).not.toBe(original);
    expect(renamed).not.toBe(original);
  });

  it("gives every event the same id when the same trip is exported twice", async () => {
    const e = await exporter();
    const first = idsBySummary(await e.export(mixedTrip));
    const again = idsBySummary(await e.export(mixedTrip));
    expect(first.size).toBe(3);
    expect(again).toEqual(first);
    expect(new Set(first.values()).size).toBe(3);
  });

  it("keeps a flight's id when its time changes, and changes it with the flight number", async () => {
    const e = await exporter();
    const flight = oneFlightTrip.bookings[0].legs[0];
    const withFlight = (changes: Record<string, unknown>) =>
      tripWith({ ...oneFlightTrip.bookings[0], legs: [{ ...flight, ...changes }] });
    const original = idOf(await e.export(withFlight({})), "Flight JL044");
    const retimed = idOf(
      await e.export(
        withFlight({
          departure: { ...flight.departure, localTime: "2026-12-01T14:10" },
          arrival: { ...flight.arrival, localTime: "2026-12-02T10:15" },
        }),
      ),
      "Flight JL044",
    );
    const renumbered = idOf(await e.export(withFlight({ flightNumber: "JL045" })), "Flight JL045");
    expect(retimed).toBe(original);
    expect(renumbered).not.toBe(original);
  });

  it("keeps a stay's id when its dates change, and changes it with the property", async () => {
    const e = await exporter();
    const stay = hotelBooking.legs[0];
    const withStay = (changes: Record<string, unknown>) => tripWith({ ...hotelBooking, legs: [{ ...stay, ...changes }] });
    const original = idOf(await e.export(withStay({})), "Stay: Sample Hotel Tokyo");
    const extended = idOf(await e.export(withStay({ checkOut: "2026-12-07" })), "Stay: Sample Hotel Tokyo");
    const otherHotel = idOf(await e.export(withStay({ property: "Another Hotel" })), "Stay: Another Hotel");
    expect(extended).toBe(original);
    expect(otherHotel).not.toBe(original);
  });

  it("never writes a booking reference into the file", async () => {
    const e = await exporter();
    const references = ["XQZ987654", "KLM555111"];
    const trip = tripWith(
      { ...oneFlightTrip.bookings[0], reference: references[0] },
      { ...hotelBooking, reference: references[1] },
    );
    const ics = await e.export(trip);
    for (const reference of references) expect(unfold(ics)).not.toContain(reference);
  });

  it("cannot be broken by line breaks or calendar syntax in any text", async () => {
    const e = await exporter();
    const hostile = "x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:evil\nSUMMARY:pwned; a,b \\ c";
    const trip = {
      ...oneFlightTrip,
      name: `Trip ${hostile}`,
      bookings: [
        {
          vendor: hostile,
          reference: "ABC123",
          legs: [
            { ...dinnerBooking.legs[0], name: hostile, location: hostile },
            { ...hotelBooking.legs[0], property: hostile, location: hostile },
          ],
        },
      ],
    };
    const ics = await e.export(trip);
    const all = lines(ics);
    // Two events and one calendar, however hostile the text.
    expect(all.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(all.filter((l) => l === "END:VEVENT")).toHaveLength(2);
    expect(all.filter((l) => l === "BEGIN:VCALENDAR")).toHaveLength(1);
    expect(all.filter((l) => l === "END:VCALENDAR")).toHaveLength(1);
    expect(all.filter((l) => l.startsWith("UID:evil"))).toHaveLength(0);
    // Every line is a property, and every physical line is short enough.
    for (const line of all) expect(line).toMatch(/^[A-Z][A-Z-]*[:;]/);
    for (const physical of ics.split("\r\n")) expect(Buffer.byteLength(physical)).toBeLessThanOrEqual(75);
  });
});
