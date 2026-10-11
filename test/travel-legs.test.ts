import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hotelBooking, oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** Export and check trips the way Claude would. */
async function session() {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  return {
    async export(trip: unknown) {
      const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
      const file = readdirSync(dir).find((f) => f.endsWith(".ics"));
      return { result, ics: file ? readFileSync(join(dir, file), "utf8") : undefined };
    },
    async check(trip: unknown) {
      return textOf(await server.client.callTool({ name: "check_trip", arguments: { trip } }));
    },
  };
}

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const lines = (ics: string) => unfold(ics).split("\r\n").filter(Boolean);

type Mode = "flight" | "train" | "ferry" | "bus" | "car" | "other";
const endpoint = (location: string, localTime: string, timeZone: string) => ({ location, localTime, timeZone });

/** A travel leg in its own booking, Osaka to Tokyo unless said otherwise. */
const travel = (mode: Mode, changes: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) => ({
  vendor: "Sample Rail",
  reference: "TRV123",
  ...booking,
  legs: [
    {
      kind: "travel",
      status: "confirmed",
      mode,
      identifier: "N700",
      from: endpoint("Osaka", "2026-12-03T09:00", "Asia/Tokyo"),
      to: endpoint("Tokyo", "2026-12-03T11:30", "Asia/Tokyo"),
      ...changes,
    },
  ],
});
const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });

describe("travel legs", () => {
  it.each([
    ["flight", "Flight"],
    ["train", "Train"],
    ["ferry", "Ferry"],
    ["bus", "Bus"],
    ["car", "Car"],
    ["other", "Travel"],
  ] as const)("exports a %s leg with its mode in the title and its real times and zones", async (mode, label) => {
    const { result, ics } = await (await session()).export(trip(travel(mode)));
    expect(result.isError, textOf(result)).toBeFalsy();
    const all = lines(ics!);
    expect(all).toContain(`SUMMARY:${label} N700: Osaka to Tokyo`);
    expect(all).toContain("DTSTART;TZID=Asia/Tokyo:20261203T090000");
    expect(all).toContain("DTEND;TZID=Asia/Tokyo:20261203T113000");
  });
});

const idOf = (ics: string) => lines(ics).find((l) => l.startsWith("UID:"))!.slice(4);
/** Export one booking and give back the id of its single event. */
async function idFor(booking: object) {
  const { result, ics } = await (await session()).export(trip(booking));
  expect(result.isError, textOf(result)).toBeFalsy();
  return idOf(ics!);
}

describe("travel leg identity", () => {
  it("keeps a journey's id when its times change, and changes it with the number or the mode", async () => {
    const original = await idFor(travel("train"));
    const retimed = await idFor(
      travel("train", { from: endpoint("Osaka", "2026-12-03T10:15", "Asia/Tokyo"), to: endpoint("Tokyo", "2026-12-03T12:45", "Asia/Tokyo") }),
    );
    const renumbered = await idFor(travel("train", { identifier: "N800" }));
    const otherMode = await idFor(travel("bus"));
    expect(retimed).toBe(original);
    expect(renumbered).not.toBe(original);
    expect(otherMode).not.toBe(original);
  });

  it("ignores case, spacing and punctuation in the journey number and the reference", async () => {
    const original = await idFor(travel("train"));
    const rewritten = await idFor(travel("train", { identifier: " n-700 " }, { reference: " trv 123 " }));
    expect(rewritten).toBe(original);
  });

  it("uses where a journey goes when it has no number, so a different route is a different id", async () => {
    const noNumber = (changes: Record<string, unknown> = {}) => travel("ferry", { identifier: undefined, ...changes });
    const original = await idFor(noNumber());
    const again = await idFor(noNumber());
    const otherRoute = await idFor(noNumber({ to: endpoint("Kobe", "2026-12-03T11:30", "Asia/Tokyo") }));
    expect(again).toBe(original);
    expect(otherRoute).not.toBe(original);
  });

  it("falls back to the mode, the places and the original date when there is no reference or number", async () => {
    const bare = (changes: Record<string, unknown> = {}) => travel("car", { identifier: undefined, ...changes }, { reference: undefined });
    const original = await idFor(bare());
    const later = await idFor(bare({ from: endpoint("Osaka", "2026-12-03T14:00", "Asia/Tokyo"), to: endpoint("Tokyo", "2026-12-03T17:00", "Asia/Tokyo") }));
    const nextDay = await idFor(bare({ from: endpoint("Osaka", "2026-12-04T09:00", "Asia/Tokyo"), to: endpoint("Tokyo", "2026-12-04T11:30", "Asia/Tokyo") }));
    expect(later).toBe(original);
    expect(nextDay).not.toBe(original);
  });

  it("never writes the booking reference of a journey into the file", async () => {
    const { ics } = await (await session()).export(trip(travel("train", {}, { reference: "XQZ987654" })));
    expect(unfold(ics!)).not.toContain("XQZ987654");
  });
});

/** A journey between two places on given local times, in one booking of its own. */
const journey = (mode: Mode, identifier: string, from: [string, string], to: [string, string], zones: [string, string] = ["Europe/London", "Europe/London"]) =>
  travel(mode, { identifier, from: endpoint(from[0], from[1], zones[0]), to: endpoint(to[0], to[1], zones[1]) }, { reference: `REF${identifier}` });
const stayAt = (property: string, location: string, checkIn: string, checkOut: string) => ({
  vendor: "Sample Stays",
  legs: [{ kind: "stay", status: "confirmed", property, location, checkIn, checkOut }],
});
const noGaps = 'No gaps found in "Sample Japan Trip".';

describe("gaps across every kind of travel", () => {
  const out = journey("flight", "SA1", ["London", "2026-12-01T11:00"], ["Osaka", "2026-12-02T08:00"], ["Europe/London", "Asia/Tokyo"]);
  const home = journey("flight", "SA2", ["Tokyo", "2026-12-05T10:00"], ["London", "2026-12-05T16:00"], ["Asia/Tokyo", "Europe/London"]);

  it("is satisfied by a train that connects two places", async () => {
    const train = journey("train", "N700", ["Osaka", "2026-12-03T09:00"], ["Tokyo", "2026-12-03T11:30"], ["Asia/Tokyo", "Asia/Tokyo"]);
    const text = await (await session()).check(trip(out, stayAt("Osaka Inn", "Osaka", "2026-12-02", "2026-12-03"), train, stayAt("Tokyo Inn", "Tokyo", "2026-12-03", "2026-12-05"), home));
    expect(text).toBe(noGaps);
  });

  it("reports a broken chain when nothing connects two places, even with a stay at the far end", async () => {
    const text = await (await session()).check(trip(out, stayAt("Tokyo Inn", "Tokyo", "2026-12-02", "2026-12-05"), home));
    expect(text).toContain("Broken location chain");
    expect(text).toContain("Osaka");
    expect(text).toContain("Tokyo");
  });

  it("reports a broken chain between two stays in different places", async () => {
    const outToParis = journey("flight", "SA3", ["London", "2026-12-01T08:00"], ["Paris", "2026-12-01T10:30"], ["Europe/London", "Europe/Paris"]);
    const backFromRome = journey("flight", "SA4", ["Rome", "2026-12-05T10:00"], ["London", "2026-12-05T12:30"], ["Europe/Rome", "Europe/London"]);
    const text = await (await session()).check(trip(outToParis, stayAt("Paris Inn", "Paris", "2026-12-01", "2026-12-03"), stayAt("Rome Inn", "Rome", "2026-12-03", "2026-12-05"), backFromRome));
    expect(text).toContain("Broken location chain");
    expect(text).toContain("Paris");
    expect(text).toContain("Rome");
  });

  it("is satisfied when a train runs between those two stays", async () => {
    const outToParis = journey("flight", "SA3", ["London", "2026-12-01T08:00"], ["Paris", "2026-12-01T10:30"], ["Europe/London", "Europe/Paris"]);
    const backFromRome = journey("flight", "SA4", ["Rome", "2026-12-05T10:00"], ["London", "2026-12-05T12:30"], ["Europe/Rome", "Europe/London"]);
    const train = journey("train", "TGV9", ["Paris", "2026-12-03T09:00"], ["Rome", "2026-12-03T19:00"], ["Europe/Paris", "Europe/Rome"]);
    const text = await (await session()).check(trip(outToParis, stayAt("Paris Inn", "Paris", "2026-12-01", "2026-12-03"), train, stayAt("Rome Inn", "Rome", "2026-12-03", "2026-12-05"), backFromRome));
    expect(text).toBe(noGaps);
  });

  it("counts the way home by any mode, so a train home is not a missing return", async () => {
    const outToParis = journey("flight", "SA3", ["London", "2026-12-01T08:00"], ["Paris", "2026-12-01T10:30"], ["Europe/London", "Europe/Paris"]);
    const trainHome = journey("train", "ES9", ["Paris", "2026-12-03T10:00"], ["London", "2026-12-03T12:30"], ["Europe/Paris", "Europe/London"]);
    const text = await (await session()).check(trip(outToParis, stayAt("Paris Inn", "Paris", "2026-12-01", "2026-12-03"), trainHome));
    expect(text).toBe(noGaps);
  });

  it("reports a missing return when the last journey ends away from home, whatever the mode", async () => {
    const outToParis = journey("flight", "SA3", ["London", "2026-12-01T08:00"], ["Paris", "2026-12-01T10:30"], ["Europe/London", "Europe/Paris"]);
    const toLyon = journey("train", "TGV5", ["Paris", "2026-12-03T09:00"], ["Lyon", "2026-12-03T11:00"], ["Europe/Paris", "Europe/Paris"]);
    const text = await (await session()).check(trip(outToParis, stayAt("Paris Inn", "Paris", "2026-12-01", "2026-12-03"), toLyon));
    expect(text).toContain("Missing return");
    expect(text).toContain("Lyon");
  });

  it("counts a night spent on an overnight train as covered", async () => {
    const night = journey("train", "NT1", ["Osaka", "2026-12-03T22:00"], ["Tokyo", "2026-12-04T06:00"], ["Asia/Tokyo", "Asia/Tokyo"]);
    const text = await (await session()).check(trip(out, stayAt("Osaka Inn", "Osaka", "2026-12-02", "2026-12-03"), night, stayAt("Tokyo Inn", "Tokyo", "2026-12-04", "2026-12-05"), home));
    expect(text).toBe(noGaps);
  });
});

describe("places named differently by a stay and a journey", () => {
  it("reads a stay in a neighbourhood as the same area as the airport city", async () => {
    const out = journey("flight", "SA1", ["London", "2026-12-01T11:00"], ["Tokyo Haneda (HND)", "2026-12-02T08:00"], ["Europe/London", "Asia/Tokyo"]);
    const home = journey("flight", "SA2", ["Tokyo Haneda (HND)", "2026-12-05T10:00"], ["London", "2026-12-05T16:00"], ["Asia/Tokyo", "Europe/London"]);
    const text = await (await session()).check(trip(out, stayAt("Shinjuku Inn", "Shinjuku, Tokyo", "2026-12-02", "2026-12-05"), home));
    expect(text).toBe(noGaps);
  });
});

describe("what Claude is told about travel legs", () => {
  it("lists every mode and the optional number in the export schema and describes check_trip for any mode", async () => {
    const server = await startServer();
    open.push(server);
    const { tools } = await server.client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === "export_trip")!.inputSchema);
    for (const mode of ["flight", "train", "ferry", "bus", "car", "other"]) expect(schema).toContain(`"${mode}"`);
    expect(schema).toMatch(/flight number, the train number/i);
    expect(tools.find((t) => t.name === "check_trip")!.description).toMatch(/any (mode|kind) of travel|train/i);
  });
});
