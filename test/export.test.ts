import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const knownGood = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
// DTSTAMP is the export moment, so it is the one line that cannot be saved.
const withoutStamp = (ics: string) => ics.replace(/^DTSTAMP:.*$/m, "DTSTAMP:20000101T000000Z");

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("trip-agent server", () => {
  it("starts over stdio and lists the exporter tool", async () => {
    const server = await startServer();
    open.push(server);
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["export_trip"]);
  });

  it("exports a one-flight trip that matches the known-good calendar file", async () => {
    const dir = join(makeHome(), "out");
    const server = await startServer({ TRIP_AGENT_DIR: dir });
    open.push(server);
    const result = await server.client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
    expect(result.isError).toBeFalsy();
    const path = join(dir, "sample-japan-trip-2026-12-01.ics");
    expect(textOf(result)).toContain(path);
    expect(withoutStamp(readFileSync(path, "utf8"))).toBe(knownGood("one-flight.ics"));
  });

  it("builds the filename itself, so a hostile trip name cannot become a path", async () => {
    const dir = join(makeHome(), "out");
    const server = await startServer({ TRIP_AGENT_DIR: dir });
    open.push(server);
    const trip = { ...oneFlightTrip, name: "../../etc/Évil name\\..\\x.ics" };
    const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
    expect(result.isError).toBeFalsy();
    expect(readdirSync(dir)).toEqual(["etc-evil-name-x-ics-2026-12-01.ics"]);
    expect(existsSync(join(dir, "..", "etc"))).toBe(false);
  });

  it("creates the default folder, Documents/trip-agent in the home folder, when missing", async () => {
    const server = await startServer();
    open.push(server);
    await server.client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
    expect(readdirSync(join(server.home, "Documents", "trip-agent"))).toEqual(["sample-japan-trip-2026-12-01.ics"]);
  });

  it("lets TRIP_AGENT_DIR override the folder, creating it when missing", async () => {
    const dir = join(makeHome(), "a", "b");
    const server = await startServer({ TRIP_AGENT_DIR: dir });
    open.push(server);
    await server.client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
    expect(readdirSync(dir)).toEqual(["sample-japan-trip-2026-12-01.ics"]);
    expect(existsSync(join(server.home, "Documents"))).toBe(false);
  });

  it("rejects a trip that fails the schema with a message that names the problem", async () => {
    const dir = join(makeHome(), "out");
    const server = await startServer({ TRIP_AGENT_DIR: dir });
    open.push(server);
    const trip = structuredClone(oneFlightTrip);
    trip.bookings[0].legs[0].arrival.timeZone = "JST";
    const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("arrival");
    expect(textOf(result)).toContain("timeZone");
    expect(textOf(result)).toContain("IANA");
    expect(existsSync(dir)).toBe(false);
  });
});
