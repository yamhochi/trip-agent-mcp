import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** A fake `xdg-open` and `open` on the server's PATH that records what it was asked to open. */
function fakeOpener() {
  const bin = mkdtempSync(join(tmpdir(), "trip-agent-bin-"));
  const record = join(bin, "opened.txt");
  for (const name of ["xdg-open", "open"]) {
    const script = join(bin, name);
    writeFileSync(script, `#!/bin/sh\necho "$@" >> "${record}"\nexit 0\n`);
    chmodSync(script, 0o755);
  }
  return { bin, opened: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : []) };
}

async function session() {
  const dir = join(makeHome(), "out");
  const opener = fakeOpener();
  const server = await startServer({ TRIP_AGENT_DIR: dir, PATH: opener.bin, DISPLAY: ":0" });
  open.push(server);
  return {
    dir,
    opener,
    server,
    async export(name: string, startDate = "2026-12-01") {
      const trip = { ...oneFlightTrip, name, startDate };
      const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
      expect(result.isError, textOf(result)).toBeFalsy();
      return textOf(result);
    },
    files: () => readdirSync(dir).filter((f) => f.endsWith(".ics")).sort(),
    read: (file: string) => readFileSync(join(dir, file), "utf8"),
  };
}

const calendarName = (ics: string) => ics.match(/^X-WR-CALNAME:(.*)\r$/m)?.[1];

describe("trip file names", () => {
  it("keeps two trips with different non-English names apart, though their readable part is empty and they start the same day", async () => {
    const s = await session();
    await s.export("東京旅行");
    await s.export("大阪旅行");
    const files = s.files();
    expect(files).toHaveLength(2);
    expect(files.map((f) => calendarName(s.read(f))).sort()).toEqual(["大阪旅行", "東京旅行"].sort());
  });

  it("puts a short hash of the full name into the file name only when the readable part would lose letters", async () => {
    const s = await session();
    await s.export("東京旅行");
    await s.export("Tokyo 東京");
    const [onlyJapanese, mixed] = [s.files().find((f) => f.startsWith("trip-"))!, s.files().find((f) => f.startsWith("tokyo-"))!];
    expect(onlyJapanese).toMatch(/^trip-[0-9a-f]{8}-2026-12-01\.ics$/);
    expect(mixed).toMatch(/^tokyo-[0-9a-f]{8}-2026-12-01\.ics$/);
  });

  it("leaves the file name of an English name, and of a name with accents that read as letters, exactly as it was", async () => {
    const s = await session();
    await s.export("Sample Japan Trip");
    await s.export("Café Trip");
    expect(s.files()).toEqual(["cafe-trip-2026-12-01.ics", "sample-japan-trip-2026-12-01.ics"]);
  });

  it("gives the same trip the same file every time: a second export replaces its own file and keeps one backup", async () => {
    const s = await session();
    await s.export("東京旅行");
    await s.export("東京旅行");
    expect(s.files()).toHaveLength(1);
    expect(readdirSync(s.dir).filter((f) => f.endsWith(".bak"))).toHaveLength(1);
  });

  it("reads the same name written with different spacing, case or composed and decomposed letters as one trip", async () => {
    const s = await session();
    await s.export("Tokyo 東京 Trip");
    await s.export("  tokyo   東京   TRIP ");
    expect(s.files()).toHaveLength(1);
    await s.export("Cafe\u0301 東京");
    await s.export("Caf\u00e9 東京");
    expect(s.files()).toHaveLength(2);
  });

  it("gives a name with nothing readable in it at all, only emoji or punctuation, a file of its own", async () => {
    const s = await session();
    for (const name of ["🌴", "🏖", "!!!", "???"]) await s.export(name);
    const files = s.files();
    expect(files).toHaveLength(4);
    for (const file of files) expect(file).toMatch(/^trip-[0-9a-f]{8}-2026-12-01\.ics$/);
  });

  it("uses only safe characters in the file name, whatever the name holds", async () => {
    const s = await session();
    await s.export("../東京\\旅行\n<>:*?\"|");
    for (const file of s.files()) expect(file).toMatch(/^[a-z0-9.-]+$/);
    expect(s.files()).toHaveLength(1);
  });

  it("opens the right file for each trip when two share a start date", async () => {
    const s = await session();
    await s.export("東京旅行");
    await s.export("大阪旅行");
    const tokyo = s.files().find((f) => calendarName(s.read(f)) === "東京旅行")!;
    const osaka = s.files().find((f) => calendarName(s.read(f)) === "大阪旅行")!;
    for (const name of ["東京旅行", "大阪旅行"]) {
      const result = await s.server.client.callTool({ name: "open_trip_file", arguments: { name, startDate: "2026-12-01" } });
      expect(result.isError, textOf(result)).toBeFalsy();
    }
    expect(s.opener.opened()).toEqual([join(s.dir, tokyo), join(s.dir, osaka)]);
  });

  it("still tells the traveller about a file for the same trip name with another start date", async () => {
    const s = await session();
    await s.export("東京旅行", "2026-12-01");
    const reply = await s.export("東京旅行", "2026-12-03");
    expect(reply).toMatch(/similarly named trip/);
    expect(s.files()).toHaveLength(2);
  });

  it("never lets one trip read the earlier file of another: a check of a different trip reports nothing covered", async () => {
    const s = await session();
    // Trip A has a gap and is exported; trip B starts the same day with another non-English name.
    await s.export("東京旅行");
    const fixed = {
      ...oneFlightTrip,
      name: "大阪旅行",
      bookings: [
        ...oneFlightTrip.bookings,
        { vendor: "Sample Air", legs: [{ kind: "travel", mode: "flight", international: true, status: "confirmed", identifier: "SA999", from: { location: "Tokyo Haneda (HND)", localTime: "2026-12-05T10:00", timeZone: "Asia/Tokyo" }, to: { location: "London Heathrow (LHR)", localTime: "2026-12-05T14:00", timeZone: "Europe/London" } }] },
        { vendor: "Sample Stays", reference: "STY111", legs: [{ kind: "stay", status: "confirmed", property: "Sample Hotel Tokyo", location: "Tokyo", checkIn: "2026-12-02", checkOut: "2026-12-05" }] },
      ],
    };
    const result = await s.server.client.callTool({ name: "check_trip", arguments: { trip: fixed } });
    expect(textOf(result)).not.toMatch(/now covered/i);
  });
});
