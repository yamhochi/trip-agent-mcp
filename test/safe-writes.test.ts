import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hotelBooking, oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function exportTrip(dir: string, trip: object = oneFlightTrip) {
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  return server.client.callTool({ name: "export_trip", arguments: { trip } });
}

describe("safe writes", () => {
  it("leaves only the finished file after an export, no temporary files", async () => {
    const dir = join(makeHome(), "out");
    await exportTrip(dir);
    expect(readdirSync(dir)).toEqual(["sample-japan-trip-2026-12-01.ics"]);
  });

  it("keeps the previous version as one backup after re-exporting", async () => {
    const dir = join(makeHome(), "out");
    await exportTrip(dir);
    const first = readFileSync(join(dir, "sample-japan-trip-2026-12-01.ics"), "utf8");
    await exportTrip(dir, { ...oneFlightTrip, bookings: [...oneFlightTrip.bookings, hotelBooking] });
    const second = readFileSync(join(dir, "sample-japan-trip-2026-12-01.ics"), "utf8");
    await exportTrip(dir, oneFlightTrip);
    expect(readdirSync(dir).sort()).toEqual(["sample-japan-trip-2026-12-01.ics", "sample-japan-trip-2026-12-01.ics.bak"]);
    // the backup is the version just before the latest export, not the first
    expect(readFileSync(join(dir, "sample-japan-trip-2026-12-01.ics.bak"), "utf8")).toBe(second);
    expect(first).not.toBe(second);
  });

  it("says plainly that the folder cannot be created, instead of crashing", async () => {
    const home = makeHome();
    const blocker = join(home, "not-a-folder");
    writeFileSync(blocker, "x");
    const result = await exportTrip(join(blocker, "out"));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("folder");
    expect(textOf(result)).toContain("another folder");
  });

  it("says plainly that the folder cannot be written when the target file is unwritable", async () => {
    const dir = join(makeHome(), "out");
    // a directory sitting where the file should go cannot be replaced by a file
    mkdirSync(join(dir, "sample-japan-trip-2026-12-01.ics"), { recursive: true });
    const result = await exportTrip(dir);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("another folder");
    expect(readdirSync(dir)).toEqual(["sample-japan-trip-2026-12-01.ics"]);
  });
});

describe("similar-file notice", () => {
  it("flags an existing file for the same trip name with a different start date", async () => {
    const dir = join(makeHome(), "out");
    await exportTrip(dir);
    const moved = { ...oneFlightTrip, startDate: "2026-12-08" };
    const result = await exportTrip(dir, moved);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("sample-japan-trip-2026-12-01.ics");
    expect(textOf(result).toLowerCase()).toContain("different start date");
  });

  it("does not flag anything when there is no similar file", async () => {
    const dir = join(makeHome(), "out");
    const result = await exportTrip(dir);
    expect(textOf(result).toLowerCase()).not.toContain("different start date");
  });

  it("does not flag a differently named trip", async () => {
    const dir = join(makeHome(), "out");
    await exportTrip(dir, { ...oneFlightTrip, name: "Weekend in Paris" });
    const result = await exportTrip(dir);
    expect(textOf(result).toLowerCase()).not.toContain("different start date");
  });
});
