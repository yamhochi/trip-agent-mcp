import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** Export trips the way Claude would and read back what landed in the folder. */
async function exporter() {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  return {
    async export(trip: unknown) {
      const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
      const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".ics")) : undefined;
      return { result, ics: file ? readFileSync(join(dir, file), "utf8") : undefined };
    },
  };
}

interface Event {
  uid: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  description: string;
  location: string;
}

const unfold = (ics: string) => ics.replace(/\r\n /g, "");

/** The events in a calendar file, so a test reads "the check-in block". */
function eventsIn(ics: string): Event[] {
  return unfold(ics)
    .split("BEGIN:VEVENT\r\n")
    .slice(1)
    .map((chunk) => {
      const get = (name: string) => chunk.match(new RegExp(`^${name}[^:]*:(.*)$`, "m"))?.[1]?.replace(/\r$/, "") ?? "";
      return {
        uid: get("UID"),
        summary: get("SUMMARY"),
        start: chunk.match(/^DTSTART([^\r\n]*)/m)![1],
        end: chunk.match(/^DTEND([^\r\n]*)/m)![1],
        status: get("STATUS"),
        description: get("DESCRIPTION"),
        location: get("LOCATION"),
      };
    });
}
const find = (ics: string, summaryStart: string) => eventsIn(ics).find((e) => e.summary.startsWith(summaryStart));

const endpoint = (location: string, localTime: string, timeZone: string) => ({ location, localTime, timeZone });
/** A flight in a booking of its own. London to Tokyo, leaving 11:30 on 1 December, unless said otherwise. */
const flight = (changes: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) => ({
  vendor: "Sample Air",
  reference: "FLT123",
  ...booking,
  legs: [
    {
      kind: "travel",
      status: "confirmed",
      mode: "flight",
      identifier: "JL044",
      international: true,
      from: endpoint("London Heathrow (LHR)", "2026-12-01T11:30", "Europe/London"),
      to: endpoint("Tokyo Haneda (HND)", "2026-12-02T07:35", "Asia/Tokyo"),
      ...changes,
    },
  ],
});
const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });

describe("airport check-in blocks", () => {
  it("puts a 3-hour tentative block ending at an international departure", async () => {
    const { result, ics } = await (await exporter()).export(trip(flight()));
    expect(result.isError, textOf(result)).toBeFalsy();
    const block = find(ics!, "Airport check-in")!;
    expect(block).toBeDefined();
    expect(block.start).toBe(";TZID=Europe/London:20261201T083000");
    expect(block.end).toBe(";TZID=Europe/London:20261201T113000");
    expect(block.status).toBe("TENTATIVE");
  });

  it("puts a 2-hour block before a domestic departure", async () => {
    const { ics } = await (await exporter()).export(trip(flight({ international: false })));
    const block = find(ics!, "Airport check-in")!;
    expect(block.start).toBe(";TZID=Europe/London:20261201T093000");
    expect(block.end).toBe(";TZID=Europe/London:20261201T113000");
  });

  it("names the flight and the airport, and says the time is approximate", async () => {
    const { ics } = await (await exporter()).export(trip(flight()));
    const block = find(ics!, "Airport check-in")!;
    expect(block.summary).toBe("Airport check-in: Flight JL044");
    expect(block.location).toBe("London Heathrow (LHR)");
    expect(block.description).toMatch(/approximate/i);
    expect(block.description).toContain("3 hours");
    const domestic = find((await (await exporter()).export(trip(flight({ international: false })))).ics!, "Airport check-in")!;
    expect(domestic.description).toContain("2 hours");
  });

  it("asks for the flag on a flight, saying what to supply", async () => {
    const { international: _omit, ...withoutFlag } = flight().legs[0];
    const { result, ics } = await (await exporter()).export(trip({ ...flight(), legs: [withoutFlag] }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("international");
    expect(textOf(result)).toMatch(/true|false|ask the traveller/i);
    expect(ics).toBeUndefined();
  });

  it("does not need the flag, and makes no block, for a train", async () => {
    const { international: _omit, ...asTrain } = flight({ mode: "train", identifier: "N700" }).legs[0];
    const { result, ics } = await (await exporter()).export(trip({ ...flight(), legs: [asTrain] }));
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(find(ics!, "Airport check-in")).toBeUndefined();
  });

  it.each([
    ["confirmed", "TENTATIVE"],
    ["planned", "TENTATIVE"],
    ["cancelled", "CANCELLED"],
  ])("makes the block of a %s flight %s", async (status, expected) => {
    const { ics } = await (await exporter()).export(trip(flight({ status })));
    expect(find(ics!, "Airport check-in")!.status).toBe(expected);
  });

  it("makes no block for an idea", async () => {
    const { ics } = await (await exporter()).export(trip(flight({ status: "idea" }), flight({ identifier: "JL999", from: endpoint("London Heathrow (LHR)", "2026-12-03T10:00", "Europe/London") }, { reference: "FLT456" })));
    expect(eventsIn(ics!).filter((e) => e.summary.startsWith("Airport check-in")).map((e) => e.summary)).toEqual(["Airport check-in: Flight JL999"]);
  });

  it("keeps the block's id when the departure time moves, and never shares the flight's id", async () => {
    const session = await exporter();
    const original = find((await session.export(trip(flight()))).ics!, "Airport check-in")!;
    const later = find((await session.export(trip(flight({ from: endpoint("London Heathrow (LHR)", "2026-12-01T15:00", "Europe/London") })))).ics!, "Airport check-in")!;
    const theFlight = find((await session.export(trip(flight()))).ics!, "Flight JL044")!;
    expect(later.uid).toBe(original.uid);
    expect(later.start).toBe(";TZID=Europe/London:20261201T120000");
    expect(original.uid).not.toBe(theFlight.uid);
  });
});

/** A stay in Tokyo from 2 to 5 December, with free airport transit unless said otherwise. */
const hotel = (changes: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) => ({
  vendor: "Sample Stays",
  reference: "HTL789",
  ...booking,
  legs: [
    { kind: "stay", status: "confirmed", property: "Sample Hotel Tokyo", location: "Tokyo", checkIn: "2026-12-02", checkOut: "2026-12-05", airportTransit: true, ...changes },
  ],
});
const arriving = flight(); // lands at Tokyo Haneda at 07:35 on 2 December
const leaving = (changes: Record<string, unknown> = {}) =>
  flight(
    { identifier: "JL043", from: endpoint("Tokyo Haneda (HND)", "2026-12-05T10:00", "Asia/Tokyo"), to: endpoint("London Heathrow (LHR)", "2026-12-05T16:00", "Europe/London"), ...changes },
    { reference: "FLT456" },
  );

describe("hotel shuttles", () => {
  it("starts an arriving shuttle at landing and runs it for 45 minutes, tentatively", async () => {
    const { result, ics } = await (await exporter()).export(trip(arriving, hotel()));
    expect(result.isError, textOf(result)).toBeFalsy();
    const shuttle = find(ics!, "Hotel shuttle from the airport")!;
    expect(shuttle).toBeDefined();
    expect(shuttle.summary).toBe("Hotel shuttle from the airport: Sample Hotel Tokyo");
    expect(shuttle.start).toBe(";TZID=Asia/Tokyo:20261202T073500");
    expect(shuttle.end).toBe(";TZID=Asia/Tokyo:20261202T082000");
    expect(shuttle.status).toBe("TENTATIVE");
    expect(shuttle.location).toBe("Tokyo Haneda (HND)");
  });

  it("ends a departing shuttle when airport check-in opens, 45 minutes after it starts", async () => {
    const { ics } = await (await exporter()).export(trip(leaving(), hotel()));
    const block = find(ics!, "Airport check-in")!;
    const shuttle = find(ics!, "Hotel shuttle to the airport")!;
    expect(block.start).toBe(";TZID=Asia/Tokyo:20261205T070000");
    expect(shuttle.start).toBe(";TZID=Asia/Tokyo:20261205T061500");
    expect(shuttle.end).toBe(block.start);
    expect(shuttle.status).toBe("TENTATIVE");
    expect(shuttle.location).toBe("Tokyo Haneda (HND)");
  });

  it("allows 2 hours before a domestic departure, so the shuttle is an hour later", async () => {
    const { ics } = await (await exporter()).export(trip(leaving({ international: false }), hotel()));
    const shuttle = find(ics!, "Hotel shuttle to the airport")!;
    expect(shuttle.start).toBe(";TZID=Asia/Tokyo:20261205T071500");
    expect(shuttle.end).toBe(";TZID=Asia/Tokyo:20261205T080000");
  });

  it("says the times are approximate and to check them with the hotel", async () => {
    const { ics } = await (await exporter()).export(trip(arriving, hotel()));
    const shuttle = find(ics!, "Hotel shuttle from the airport")!;
    expect(shuttle.description).toMatch(/approximate/i);
    expect(shuttle.description).toMatch(/check .* with the hotel/i);
  });

  it.each([
    ["the booking does not say transit is included", { airportTransit: undefined }],
    ["the booking says there is no free transit", { airportTransit: false }],
  ])("makes no shuttle when %s", async (_why, changes) => {
    const { ics } = await (await exporter()).export(trip(arriving, leaving(), hotel(changes)));
    expect(eventsIn(ics!).filter((e) => e.summary.startsWith("Hotel shuttle"))).toEqual([]);
  });

  it("makes no shuttle without a flight on the day, or from the city of the stay", async () => {
    const otherDay = flight({ to: endpoint("Tokyo Haneda (HND)", "2026-12-03T07:35", "Asia/Tokyo") });
    const otherCity = flight({ to: endpoint("Osaka Kansai (KIX)", "2026-12-02T07:35", "Asia/Tokyo") });
    const { ics } = await (await exporter()).export(trip(otherDay, otherCity, hotel()));
    expect(eventsIn(ics!).filter((e) => e.summary.startsWith("Hotel shuttle"))).toEqual([]);
  });

  it("cancels a shuttle when its stay or its flight is cancelled, and makes none for an idea flight", async () => {
    const stayCancelled = await (await exporter()).export(trip(arriving, hotel({ status: "cancelled" })));
    expect(find(stayCancelled.ics!, "Hotel shuttle from the airport")!.status).toBe("CANCELLED");
    const flightCancelled = await (await exporter()).export(trip(flight({ status: "cancelled" }), hotel()));
    expect(find(flightCancelled.ics!, "Hotel shuttle from the airport")!.status).toBe("CANCELLED");
    const flightIdea = await (await exporter()).export(trip(flight({ status: "idea" }), hotel()));
    expect(find(flightIdea.ics!, "Hotel shuttle")).toBeUndefined();
  });

  it("makes a planned stay's shuttle tentative, and no shuttle for an idea stay", async () => {
    const planned = await (await exporter()).export(trip(arriving, hotel({ status: "planned" })));
    expect(find(planned.ics!, "Hotel shuttle from the airport")!.status).toBe("TENTATIVE");
    const idea = await (await exporter()).export(trip(arriving, hotel({ status: "idea" })));
    expect(find(idea.ics!, "Hotel shuttle")).toBeUndefined();
  });

  it("keeps each shuttle's id when the flight time changes, and gives the two directions different ids", async () => {
    const session = await exporter();
    const first = (await session.export(trip(arriving, leaving(), hotel()))).ics!;
    const moved = (await session.export(trip(arriving, leaving({ from: endpoint("Tokyo Haneda (HND)", "2026-12-05T13:00", "Asia/Tokyo") }), hotel()))).ics!;
    const [inbound, outbound] = [find(first, "Hotel shuttle from")!, find(first, "Hotel shuttle to")!];
    expect(find(moved, "Hotel shuttle to")!.uid).toBe(outbound.uid);
    expect(find(moved, "Hotel shuttle from")!.uid).toBe(inbound.uid);
    expect(inbound.uid).not.toBe(outbound.uid);
    expect(find(moved, "Hotel shuttle to")!.start).toBe(";TZID=Asia/Tokyo:20261205T091500");
  });

  it("tells Claude about the flag and when to set it", async () => {
    const server = await startServer();
    open.push(server);
    const { tools } = await server.client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === "export_trip")!.inputSchema);
    expect(schema).toContain("airportTransit");
    expect(schema).toMatch(/only when the booking says/i);
    expect(schema).toContain("international");
  });

  it("exports a trip with both flights, a stay with free transit, both check-in blocks and both shuttles as the known-good file", async () => {
    const domesticLeaving = flight(
      { identifier: "JL043", international: false, from: endpoint("Tokyo Haneda (HND)", "2026-12-05T10:00", "Asia/Tokyo"), to: endpoint("Osaka Kansai (KIX)", "2026-12-05T11:30", "Asia/Tokyo") },
      { reference: "FLT456" },
    );
    const { result, ics } = await (await exporter()).export({ ...oneFlightTrip, bookings: [oneFlightTrip.bookings[0], hotel(), domesticLeaving] });
    expect(result.isError, textOf(result)).toBeFalsy();
    const expected = readFileSync(join(import.meta.dirname, "fixtures", "airport.ics"), "utf8");
    expect(unfold(ics!).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:20000101T000000Z")).toBe(expected);
  });
});
