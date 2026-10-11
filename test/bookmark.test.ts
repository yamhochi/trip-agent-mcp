import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const name = oneFlightTrip.name;
const startDate = oneFlightTrip.startDate;

async function session() {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  const file = join(dir, "sample-japan-trip-2026-12-01.ics");
  return {
    dir,
    file,
    exportTrip: (extra: object = {}, trip: object = oneFlightTrip) =>
      server.client.callTool({ name: "export_trip", arguments: { trip, ...extra } }),
    info: async () => {
      const result = await server.client.callTool({ name: "get_trip_file_info", arguments: { name, startDate } });
      expect(result.isError, textOf(result)).toBeFalsy();
      return textOf(result);
    },
  };
}

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const bookmarkLine = (ics: string) => unfold(ics).split("\r\n").find((l) => l.startsWith("X-TRIP-AGENT-BOOKMARK"));

describe("bookmark", () => {
  it("writes the date of the latest email processed into a versioned property", async () => {
    const s = await session();
    const result = await s.exportTrip({ latestEmailDate: "2026-10-05" });
    expect(result.isError, textOf(result)).toBeFalsy();
    const line = bookmarkLine(readFileSync(s.file, "utf8"))!;
    expect(line).toMatch(/^X-TRIP-AGENT-BOOKMARK;VERSION=2:/);
    expect(decodeURIComponent(line.slice(line.indexOf(":") + 1))).toContain("2026-10-05");
  });

  it("advances the bookmark on a later successful export", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    await s.exportTrip({ latestEmailDate: "2026-10-09" });
    expect(await s.info()).toContain("2026-10-09");
  });

  it("keeps the existing bookmark when an export does not give a date", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    await s.exportTrip();
    expect(await s.info()).toContain("2026-10-05");
  });

  it("leaves the existing bookmark unchanged when the export fails", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    const before = readFileSync(s.file, "utf8");
    // a non-empty folder where the backup goes makes the write fail after the new file is staged
    mkdirSync(join(s.file + ".bak"), { recursive: true });
    writeFileSync(join(s.file + ".bak", "keep"), "x");
    const failed = await s.exportTrip({ latestEmailDate: "2026-10-20" });
    expect(failed.isError).toBe(true);
    expect(readFileSync(s.file, "utf8")).toBe(before);
    expect(await s.info()).toContain("2026-10-05");
  });

  it("leaves the bookmark unchanged when nothing is exported because every leg is an idea", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    const ideas = {
      ...oneFlightTrip,
      bookings: oneFlightTrip.bookings.map((b) => ({ ...b, legs: b.legs.map((l) => ({ ...l, status: "idea" })) })),
    };
    await s.exportTrip({ latestEmailDate: "2026-10-20" }, ideas);
    expect(await s.info()).toContain("2026-10-05");
  });

  it("never moves the bookmark back: an older date than the one saved keeps the newer", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-09" });
    const result = await s.exportTrip({ latestEmailDate: "2026-10-05" });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await s.info()).toContain("Bookmark: 2026-10-09");
    expect(textOf(result)).toContain("2026-10-09");
  });

  it("rejects a date in the future, saying why, and writes nothing", async () => {
    const s = await session();
    const result = await s.exportTrip({ latestEmailDate: "2099-01-01" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/future/i);
    expect(existsSync(s.file)).toBe(false);
  });

  it("accepts today's date", async () => {
    const s = await session();
    const today = new Date().toISOString().slice(0, 10);
    const result = await s.exportTrip({ latestEmailDate: today });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await s.info()).toContain(`Bookmark: ${today}`);
  });

  it("ignores a bookmark in the file that is in the future, as if there were none", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    const hostile = encodeURIComponent(JSON.stringify({ date: "2099-01-01", exportedAt: "2026-10-05T00:00:00.000Z" }));
    writeFileSync(s.file, unfold(readFileSync(s.file, "utf8")).replace(/^X-TRIP-AGENT-BOOKMARK.*$/m, `X-TRIP-AGENT-BOOKMARK;VERSION=2:${hostile}`));
    const text = await s.info();
    expect(text).not.toContain("2099");
    expect(text).toMatch(/no bookmark|could not be read/i);
  });

  it("tells Claude in the export reply which bookmark the file now has", async () => {
    const s = await session();
    expect(textOf(await s.exportTrip({ latestEmailDate: "2026-10-05" }))).toContain("Bookmark: 2026-10-05");
    expect(textOf(await s.exportTrip())).toContain("Bookmark: 2026-10-05");
    const fresh = await session();
    expect(textOf(await fresh.exportTrip())).toMatch(/no bookmark/i);
  });

  it("says so, instead of silently dropping the bookmark, when the earlier file's bookmark cannot be read and no date is given", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    writeFileSync(s.file, unfold(readFileSync(s.file, "utf8")).replace(/^X-TRIP-AGENT-BOOKMARK.*$/m, "X-TRIP-AGENT-BOOKMARK;VERSION=9:???"));
    const result = textOf(await s.exportTrip());
    expect(result).toMatch(/no bookmark/i);
    expect(result).toMatch(/could not be read/i);
    expect(result).toMatch(/latestEmailDate/);
  });

  it("rejects a date that is not a real date", async () => {
    const s = await session();
    const result = await s.exportTrip({ latestEmailDate: "2026-13-45" });
    expect(result.isError).toBe(true);
  });
});

describe("get_trip_file_info", () => {
  it("reports existence, bookmark date and last export time for an existing file", async () => {
    const s = await session();
    const before = Date.now();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    const text = await s.info();
    expect(text).toContain("exists");
    expect(text).toContain("Bookmark: 2026-10-05");
    const exported = text.match(/Last exported: (\S+)/)![1];
    expect(Date.parse(exported)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(exported)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("says plainly there is no file when it is missing, and tells Claude to search by trip", async () => {
    const s = await session();
    const text = await s.info();
    expect(text).toContain("No file");
    expect(text.toLowerCase()).toContain("trip");
    expect(text).not.toContain("Bookmark:");
  });

  it("says a file has no bookmark when it was exported without one", async () => {
    const s = await session();
    await s.exportTrip();
    const text = await s.info();
    expect(text).toContain("exists");
    expect(text).toContain("no bookmark");
  });

  it("reads a file written before the bookmark existed", async () => {
    const s = await session();
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(s.file, readFileSync(join(import.meta.dirname, "fixtures", "gaps-appear.ics"), "utf8").replace(/^X-TRIP-AGENT-BOOKMARK.*\r\n/m, ""));
    const text = await s.info();
    expect(text).toContain("exists");
    expect(text).toContain("no bookmark");
  });

  it("still reads a file written with an older bookmark version that held only the date", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    const ics = unfold(readFileSync(s.file, "utf8")).replace(/^X-TRIP-AGENT-BOOKMARK.*$/m, "X-TRIP-AGENT-BOOKMARK;VERSION=1:2026-10-03");
    writeFileSync(s.file, ics);
    const text = await s.info();
    expect(text).toContain("Bookmark: 2026-10-03");
    expect(text).toContain("Last exported: unknown");
  });

  it("ignores a bookmark property it cannot read instead of failing", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    writeFileSync(s.file, unfold(readFileSync(s.file, "utf8")).replace(/^X-TRIP-AGENT-BOOKMARK.*$/m, "X-TRIP-AGENT-BOOKMARK;VERSION=9:???"));
    expect(await s.info()).toContain("search the mailbox for the trip itself");
  });

  it("says the bookmark could not be read, rather than that there is none, when the property is damaged", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    writeFileSync(s.file, unfold(readFileSync(s.file, "utf8")).replace(/^X-TRIP-AGENT-BOOKMARK.*$/m, "X-TRIP-AGENT-BOOKMARK;VERSION=9:???"));
    expect(await s.info()).toMatch(/could not be read/i);
  });

  it("says the file could not be read, with a reason, when it exists but is too large", async () => {
    const s = await session();
    await s.exportTrip({ latestEmailDate: "2026-10-05" });
    writeFileSync(s.file, "X".repeat(5_100_000));
    const text = await s.info();
    expect(text).toContain("exists");
    expect(text).toMatch(/could not be read/i);
    expect(text).not.toMatch(/Last exported: unknown/);
  });
});
