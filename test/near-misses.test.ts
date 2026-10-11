import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** One server and one export folder, so an export and a later check meet the same file, as they do for a traveller. */
async function session() {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  return {
    async check(trip: unknown) {
      const result = await server.client.callTool({ name: "check_trip", arguments: { trip } });
      expect(result.isError, textOf(result)).toBeFalsy();
      return textOf(result);
    },
    async export(trip: unknown) {
      const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
      expect(result.isError, textOf(result)).toBeFalsy();
      const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".ics")) : undefined;
      return readFileSync(join(dir, file!), "utf8").replace(/\r\n /g, "");
    },
    server,
  };
}

const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });
const flightBooking = (flightNumber: string, from: [string, string, string], to: [string, string, string]) => ({
  vendor: "Sample Air",
  legs: [
    {
      kind: "travel",
      mode: "flight",
      international: true,
      status: "confirmed",
      identifier: flightNumber,
      from: { location: from[0], localTime: from[1], timeZone: from[2] },
      to: { location: to[0], localTime: to[1], timeZone: to[2] },
    },
  ],
});
const stayBooking = (property: string, location: string, checkIn: string, checkOut: string, reference = "STY111") => ({
  vendor: "Sample Stays",
  reference,
  legs: [{ kind: "stay", status: "confirmed", property, location, checkIn, checkOut }],
});

const london = "London Heathrow (LHR)";
// The traveller flies into Tokyo Narita, but the flight home leaves from Tokyo Haneda.
const toNarita = flightBooking("SA400", [london, "2026-12-01T09:00", "Europe/London"], ["Tokyo Narita (NRT)", "2026-12-02T07:00", "Asia/Tokyo"]);
const fromHaneda = flightBooking("SA401", ["Tokyo Haneda (HND)", "2026-12-02T20:00", "Asia/Tokyo"], [london, "2026-12-03T06:00", "Europe/London"]);
const wrongAirport = trip(toNarita, fromHaneda);
// The traveller lands in Tokyo on 2 December, and the Tokyo hotel starts on the 3rd.
const landsInTokyo = flightBooking("SA500", [london, "2026-12-01T11:30", "Europe/London"], ["Tokyo Haneda (HND)", "2026-12-02T07:35", "Asia/Tokyo"]);
const goHome = flightBooking("SA999", ["Tokyo Haneda (HND)", "2026-12-05T10:00", "Asia/Tokyo"], [london, "2026-12-05T14:00", "Europe/London"]);
const lateStay = stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-03", "2026-12-05");
const startsALateDay = trip(landsInTokyo, lateStay, goHome);

describe("near misses in check_trip", () => {
  it("reports a flight into the wrong airport of the right city as a near miss for the broken chain, naming both legs", async () => {
    const text = await (await session()).check(wrongAirport);
    expect(text).toContain("1 gap found");
    expect(text).toContain("Broken location chain: flight SA400 arrives in Tokyo Narita (NRT), but flight SA401 leaves from Tokyo Haneda (HND).");
    expect(text).toContain(
      "Near miss for the broken location chain (flight SA400 arrives in Tokyo Narita (NRT), but flight SA401 leaves from Tokyo Haneda (HND)): the two places share a city, so they may be one place under two names or two airports of one city. This does not clear the gap: ask the traveller, and if they are the same place, correct the leg that names the wrong one.",
    );
  });

  it("reports a stay in the right city that starts a day late as a near miss for the unbooked night, naming the stay", async () => {
    const text = await (await session()).check(startsALateDay);
    expect(text).toContain("1 gap found");
    expect(text).toContain("Unbooked night: nothing is booked or planned for the night of 2026-12-02.");
    expect(text).toContain(
      "Near miss for the unbooked night of 2026-12-02: the stay at Sample Hotel Tokyo in Tokyo starts on 2026-12-03, a day after that night, and the traveller is already in Tokyo Haneda (HND) on 2026-12-02. This does not clear the gap: ask the traveller whether the stay should start a day earlier, and if so, correct its check-in date.",
    );
  });

  it("puts the near misses after the gaps, under a heading that says they clear nothing", async () => {
    const text = await (await session()).check(wrongAirport);
    const heading = text.indexOf("Near misses");
    expect(heading).toBeGreaterThan(text.indexOf("Broken location chain"));
    expect(text.slice(heading, heading + 120)).toMatch(/do not clear/i);
  });

  it("reports no near miss for a stay in another city, or for a stay that starts two days late", async () => {
    const s = await session();
    const paris = trip(landsInTokyo, stayBooking("Sample Hotel Paris", "Paris", "2026-12-03", "2026-12-05"), goHome);
    expect(await s.check(paris)).not.toMatch(/near miss/i);
    const twoLate = trip(landsInTokyo, stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-04", "2026-12-05"), goHome);
    expect(await s.check(twoLate)).not.toMatch(/near miss/i);
  });

  it("reports no near miss for two different cities, or when nothing is wrong", async () => {
    const s = await session();
    const toParis = flightBooking("SA600", [london, "2026-12-01T09:00", "Europe/London"], ["Paris (CDG)", "2026-12-01T11:00", "Europe/Paris"]);
    const fromRome = flightBooking("SA601", ["Rome (FCO)", "2026-12-02T09:00", "Europe/Rome"], [london, "2026-12-02T12:00", "Europe/London"]);
    const text = await s.check(trip(toParis, fromRome));
    expect(text).toContain("Broken location chain");
    expect(text).not.toMatch(/near miss/i);
    expect(await s.check(trip(landsInTokyo, stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-02", "2026-12-05"), goHome))).toBe('No gaps found in "Sample Japan Trip".');
  });

  it("never clears a gap: the gap is still reported, and an export keeps its placeholder tentative", async () => {
    const s = await session();
    const placeholderStatus = (ics: string) => ics.split("BEGIN:VEVENT\r\n").filter((c) => c.includes("SUMMARY:Missing:")).map((c) => c.match(/^STATUS:(.*)\r$/m)![1]);
    expect(placeholderStatus(await s.export(wrongAirport))).toEqual(["TENTATIVE"]);
    const again = await s.export(wrongAirport);
    expect(placeholderStatus(again)).toEqual(["TENTATIVE"]);
    const text = await s.check(wrongAirport);
    expect(text).toContain("1 gap found");
    expect(text).not.toMatch(/now covered/i);
    // The same for the late stay.
    const late = await session();
    expect(placeholderStatus(await late.export(startsALateDay))).toEqual(["TENTATIVE"]);
    expect(placeholderStatus(await late.export(startsALateDay))).toEqual(["TENTATIVE"]);
    expect(await late.check(startsALateDay)).not.toMatch(/now covered/i);
  });

  it("asks nothing once the traveller's answer is a corrected leg: the gap and its near miss both go", async () => {
    const s = await session();
    await s.export(wrongAirport);
    const corrected = trip(toNarita, flightBooking("SA401", ["Tokyo Narita (NRT)", "2026-12-02T20:00", "Asia/Tokyo"], [london, "2026-12-03T06:00", "Europe/London"]));
    const text = await s.check(corrected);
    expect(text).toContain("No gaps found");
    expect(text).not.toMatch(/near miss/i);
    expect(text).toMatch(/now covered/i);
  });

  it("is described to Claude in the check_trip description", async () => {
    const s = await session();
    const { tools } = await s.server.client.listTools();
    expect(tools.find((t) => t.name === "check_trip")!.description).toMatch(/near miss/i);
  });
});
