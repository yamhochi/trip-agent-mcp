import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hotelBooking, oneFlightTrip } from "./samples.js";
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

const unfold = (ics: string) => ics.replace(/\r\n /g, "");

interface Event {
  uid: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  description: string;
}

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
      };
    });
}
const breakfasts = (ics: string) => eventsIn(ics).filter((e) => e.summary.startsWith("Included breakfast"));

/** The sample hotel, 2 to 5 December in Tokyo, with breakfast included unless said otherwise. */
const hotel = (changes: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) => ({
  ...hotelBooking,
  ...booking,
  legs: [{ ...hotelBooking.legs[0], breakfastIncluded: true, timeZone: "Asia/Tokyo", ...changes }],
});
const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });

describe("included breakfast", () => {
  it("adds one confirmed breakfast for each morning after a night of the stay, in the property's time zone", async () => {
    const { result, ics } = await (await exporter()).export(trip(hotel()));
    expect(result.isError, textOf(result)).toBeFalsy();
    const found = breakfasts(ics!);
    // Nights of 2, 3 and 4 December: the mornings of the 3rd, 4th and 5th.
    expect(found.map((e) => [e.start, e.end])).toEqual([
      [";TZID=Asia/Tokyo:20261203T080000", ";TZID=Asia/Tokyo:20261203T100000"],
      [";TZID=Asia/Tokyo:20261204T080000", ";TZID=Asia/Tokyo:20261204T100000"],
      [";TZID=Asia/Tokyo:20261205T080000", ";TZID=Asia/Tokyo:20261205T100000"],
    ]);
    expect(found.every((e) => e.status === "CONFIRMED")).toBe(true);
    expect(found[0].summary).toBe("Included breakfast: Sample Hotel Tokyo");
  });

  it("says the time is approximate", async () => {
    const { ics } = await (await exporter()).export(trip(hotel()));
    for (const e of breakfasts(ics!)) expect(e.description).toMatch(/approximate/i);
  });

  it("makes no breakfast when the booking does not state it, or says it is not included", async () => {
    const e = await exporter();
    const { breakfastIncluded: _omit, ...unstated } = hotel().legs[0];
    expect(breakfasts((await e.export(trip({ ...hotel(), legs: [unstated] }))).ics!)).toEqual([]);
    expect(breakfasts((await e.export(trip(hotel({ breakfastIncluded: false })))).ics!)).toEqual([]);
  });

  it("asks for the property's time zone when breakfast is included, saying what to supply", async () => {
    const { timeZone: _omit, ...noZone } = hotel().legs[0];
    const { result, ics } = await (await exporter()).export(trip({ ...hotel(), legs: [noZone] }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timeZone");
    expect(textOf(result)).toMatch(/IANA|ask the traveller/i);
    expect(ics).toBeUndefined();
  });

  it("does not need the time zone when there is no breakfast", async () => {
    const { timeZone: _omit, breakfastIncluded: _flag, ...plain } = hotel().legs[0];
    const { result } = await (await exporter()).export(trip({ ...hotel(), legs: [plain] }));
    expect(result.isError, textOf(result)).toBeFalsy();
  });

  it("rejects a time zone that is not a real one", async () => {
    const { result } = await (await exporter()).export(trip(hotel({ timeZone: "Mars/Olympus" })));
    expect(result.isError).toBe(true);
  });

  it("gives each breakfast the same id on every export, and a different id for each morning", async () => {
    const e = await exporter();
    const first = breakfasts((await e.export(trip(hotel()))).ics!).map((b) => b.uid);
    const again = breakfasts((await e.export(trip(hotel()))).ics!).map((b) => b.uid);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });

  it("keeps the ids of the mornings that stay when the check-out is extended", async () => {
    const e = await exporter();
    const original = breakfasts((await e.export(trip(hotel()))).ics!).map((b) => b.uid);
    const extended = breakfasts((await e.export(trip(hotel({ checkOut: "2026-12-07" })))).ics!).map((b) => b.uid);
    expect(extended).toHaveLength(5);
    expect(extended.slice(0, 3)).toEqual(original);
  });

  it("cancels the breakfasts, with the same ids, when the stay is cancelled", async () => {
    const e = await exporter();
    const standing = breakfasts((await e.export(trip(hotel()))).ics!);
    const cancelled = breakfasts((await e.export(trip(hotel({ status: "cancelled" })))).ics!);
    expect(cancelled.map((b) => b.uid)).toEqual(standing.map((b) => b.uid));
    expect(cancelled.every((b) => b.status === "CANCELLED")).toBe(true);
  });

  it("makes tentative breakfasts for a planned stay and none for an idea", async () => {
    const e = await exporter();
    const planned = breakfasts((await e.export(trip(hotel({ status: "planned" })))).ics!);
    expect(planned).toHaveLength(3);
    expect(planned.every((b) => b.status === "TENTATIVE")).toBe(true);
    const idea = await e.export(trip(oneFlightTrip.bookings[0], hotel({ status: "idea" })));
    expect(idea.ics).not.toContain("breakfast");
  });

  it("never gives a breakfast the id of its stay or of another stay's breakfast", async () => {
    const other = hotel({ property: "Other Hotel" }, { reference: "OTH111" });
    const { ics } = await (await exporter()).export(trip(hotel(), other));
    const ids = eventsIn(ics!).map((e) => e.uid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("describes the time zone and the breakfast field to Claude in the tool's schema", async () => {
    const server = await startServer({ TRIP_AGENT_DIR: join(makeHome(), "out") });
    open.push(server);
    const { tools } = await server.client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === "export_trip")!.inputSchema);
    expect(schema).toContain("breakfastIncluded");
  });

  it("exports a trip with an included-breakfast stay as the known-good file", async () => {
    const { result, ics } = await (await exporter()).export(trip(hotel()));
    expect(result.isError, textOf(result)).toBeFalsy();
    const expected = readFileSync(join(import.meta.dirname, "fixtures", "breakfast.ics"), "utf8");
    expect(unfold(ics!).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:20000101T000000Z")).toBe(expected);
  });
});
