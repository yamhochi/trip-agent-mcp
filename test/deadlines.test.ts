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

const deadlines = (ics: string) => eventsIn(ics).filter((e) => /^(Free cancellation ends|Payment due)/.test(e.summary));

/** The sample hotel with its two deadlines, unless said otherwise. */
const hotel = (booking: Record<string, unknown> = {}, leg: Record<string, unknown> = {}) => ({
  ...hotelBooking,
  deadlines: { cancellationBy: "2026-11-20", paymentDueBy: "2026-11-25" },
  ...booking,
  legs: [{ ...hotelBooking.legs[0], ...leg }],
});
const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });
const withDeadlines = (deadlinesValue: unknown, booking: Record<string, unknown> = {}) => ({ ...hotel(booking), deadlines: deadlinesValue });

describe("cancellation and payment deadlines", () => {
  it("exports two all-day deadline events for a booking with a cancellation cut-off and a payment due date", async () => {
    const { result, ics } = await (await exporter()).export(trip(hotel()));
    expect(result.isError, textOf(result)).toBeFalsy();
    const found = deadlines(ics!);
    expect(found.map((e) => [e.summary, e.start, e.end, e.status])).toEqual([
      ["Free cancellation ends: Sample Hotel Tokyo", ";VALUE=DATE:20261120", ";VALUE=DATE:20261121", "CONFIRMED"],
      ["Payment due: Sample Hotel Tokyo", ";VALUE=DATE:20261125", ";VALUE=DATE:20261126", "CONFIRMED"],
    ]);
  });

  it("exports no deadline events for a booking with none, and one for a booking with only one", async () => {
    const e = await exporter();
    expect(deadlines((await e.export(trip(withDeadlines(undefined)))).ics!)).toEqual([]);
    const only = deadlines((await e.export(trip(withDeadlines({ paymentDueBy: "2026-11-25" })))).ics!);
    expect(only.map((d) => d.summary)).toEqual(["Payment due: Sample Hotel Tokyo"]);
  });

  it("tells the traveller to check the booking", async () => {
    const { ics } = await (await exporter()).export(trip(hotel()));
    for (const e of deadlines(ics!)) {
      expect(e.description).toMatch(/check the booking/i);
      expect(e.description).toContain("Sample Stays");
    }
  });

  it("keeps each deadline's id when its date moves, and gives the two kinds different ids", async () => {
    const e = await exporter();
    const original = deadlines((await e.export(trip(hotel()))).ics!).map((d) => d.uid);
    const moved = deadlines(
      (await e.export(trip(withDeadlines({ cancellationBy: "2026-11-22", paymentDueBy: "2026-11-28" })))).ics!,
    ).map((d) => d.uid);
    expect(moved).toEqual(original);
    expect(new Set(original).size).toBe(2);
  });

  it("keeps the ids when the booking has no reference and a deadline moves, and tells two such bookings apart", async () => {
    const e = await exporter();
    const unbooked = (dates: Record<string, string>, property = "Sample Hotel Tokyo") => ({
      vendor: "Friend's flat",
      deadlines: dates,
      legs: [{ ...hotelBooking.legs[0], property }],
    });
    const original = deadlines((await e.export(trip(unbooked({ paymentDueBy: "2026-11-25" })))).ics!).map((d) => d.uid);
    const moved = deadlines((await e.export(trip(unbooked({ paymentDueBy: "2026-11-27" })))).ics!).map((d) => d.uid);
    expect(moved).toEqual(original);
    const both = deadlines((await e.export(trip(unbooked({ paymentDueBy: "2026-11-25" }), unbooked({ paymentDueBy: "2026-11-25" }, "Other Flat")))).ics!);
    expect(new Set(both.map((d) => d.uid)).size).toBe(2);
  });

  it("gives every event, deadlines included, its own id", async () => {
    const other = { ...hotel({ reference: "OTH111" }), legs: [{ ...hotelBooking.legs[0], property: "Other Hotel" }] };
    const { ics } = await (await exporter()).export(trip(hotel(), other));
    const ids = eventsIn(ics!).map((e) => e.uid);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("cancels the deadlines, with the same ids, when every leg of the booking is cancelled", async () => {
    const e = await exporter();
    const standing = deadlines((await e.export(trip(hotel()))).ics!);
    const cancelled = deadlines((await e.export(trip(hotel({}, { status: "cancelled" })))).ics!);
    expect(cancelled.map((d) => d.uid)).toEqual(standing.map((d) => d.uid));
    expect(cancelled.every((d) => d.status === "CANCELLED")).toBe(true);
  });

  it("makes tentative deadlines for a booking that is only planned", async () => {
    const { ics } = await (await exporter()).export(trip(hotel({}, { status: "planned" })));
    expect(deadlines(ics!).map((d) => d.status)).toEqual(["TENTATIVE", "TENTATIVE"]);
  });

  it("ends a deadline on the first day of the next month when it falls on the last day of a month", async () => {
    const { ics } = await (await exporter()).export(trip(withDeadlines({ paymentDueBy: "2026-11-30" })));
    expect(deadlines(ics!).map((d) => [d.start, d.end])).toEqual([[";VALUE=DATE:20261130", ";VALUE=DATE:20261201"]]);
  });

  it("makes no deadline events for a booking that is only an idea", async () => {
    const { ics } = await (await exporter()).export(trip(oneFlightTrip.bookings[0], hotel({}, { status: "idea" })));
    expect(deadlines(ics!)).toEqual([]);
  });

  it("rejects a deadline that is not a real date, saying what to supply", async () => {
    const { result, ics } = await (await exporter()).export(trip(withDeadlines({ paymentDueBy: "2026-02-30" })));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("paymentDueBy");
    expect(ics).toBeUndefined();
  });

  it("describes the deadlines to Claude in the tool's schema, as only when the email states them", async () => {
    const server = await startServer({ TRIP_AGENT_DIR: join(makeHome(), "out") });
    open.push(server);
    const { tools } = await server.client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === "export_trip")!.inputSchema);
    expect(schema).toContain("cancellationBy");
    expect(schema).toContain("paymentDueBy");
    expect(schema).toMatch(/states/i);
  });

  it("exports a trip with both deadlines as the known-good file", async () => {
    const { result, ics } = await (await exporter()).export(trip(hotel()));
    expect(result.isError, textOf(result)).toBeFalsy();
    const expected = readFileSync(join(import.meta.dirname, "fixtures", "deadlines.ics"), "utf8");
    expect(unfold(ics!).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:20000101T000000Z")).toBe(expected);
  });
});
