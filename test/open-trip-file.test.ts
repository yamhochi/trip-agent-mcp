import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/**
 * Stand in for the operating system's opener. A fake `xdg-open` and `open` on the
 * server's PATH records what it was asked to open, the way the real one would be
 * asked, so the server runs exactly as it does for a traveller.
 */
function fakeOpener(exitCode = 0) {
  const bin = mkdtempSync(join(tmpdir(), "trip-agent-bin-"));
  const record = join(bin, "opened.txt");
  for (const name of ["xdg-open", "open"]) {
    const script = join(bin, name);
    writeFileSync(script, `#!/bin/sh\necho "$@" >> "${record}"\nexit ${exitCode}\n`);
    chmodSync(script, 0o755);
  }
  return { bin, opened: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : []) };
}

async function exportSample(env: Record<string, string>) {
  const server = await startServer(env);
  open.push(server);
  await server.client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
  return server;
}

const trip = { name: oneFlightTrip.name, startDate: oneFlightTrip.startDate };
const exported = (dir: string) => join(dir, "sample-japan-trip-2026-12-01.ics");

/** The reply a traveller gets where nothing can open the file: the path, plainly, and no error. */
function expectFallback(result: unknown, dir: string) {
  expect((result as { isError?: boolean }).isError).toBeFalsy();
  expect(textOf(result)).toContain("Could not open");
  expect(textOf(result)).toContain(exported(dir));
}

describe.skipIf(process.platform === "win32")("open_trip_file", () => {
  it("opens an exported trip file through the platform's default opener", async () => {
    const dir = join(makeHome(), "out");
    const opener = fakeOpener();
    const server = await exportSample({ TRIP_AGENT_DIR: dir, PATH: opener.bin, DISPLAY: ":0" });
    const result = await server.client.callTool({ name: "open_trip_file", arguments: trip });
    expect(result.isError).toBeFalsy();
    expect(opener.opened()).toEqual([exported(dir)]);
    expect(textOf(result)).toContain("Opened");
    expect(textOf(result)).toContain(exported(dir));
  });

  it("says there is no exported file, and opens nothing, when the trip was never exported", async () => {
    const dir = join(makeHome(), "out");
    const opener = fakeOpener();
    const server = await startServer({ TRIP_AGENT_DIR: dir, PATH: opener.bin, DISPLAY: ":0" });
    open.push(server);
    const result = await server.client.callTool({ name: "open_trip_file", arguments: trip });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No exported file");
    expect(opener.opened()).toEqual([]);
  });

  it("refuses a name or date that would point outside the export folder, and opens nothing", async () => {
    const home = makeHome();
    const dir = join(home, "out");
    mkdirSync(dir, { recursive: true });
    // Files a path trick could reach: one beside the export folder, one named by a hostile trip name.
    writeFileSync(join(home, "decoy.ics"), "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
    writeFileSync(join(home, "decoy-2026-12-01.ics"), "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
    const opener = fakeOpener();
    const server = await startServer({ TRIP_AGENT_DIR: dir, PATH: opener.bin, DISPLAY: ":0" }, home);
    open.push(server);

    const hostileDate = await server.client.callTool({
      name: "open_trip_file",
      arguments: { name: "sample-japan-trip-", startDate: "/../../decoy" },
    });
    expect(hostileDate.isError).toBe(true);

    const hostileName = await server.client.callTool({
      name: "open_trip_file",
      arguments: { name: "../decoy", startDate: "2026-12-01" },
    });
    // The hostile name is flattened into a plain file name inside the export folder, which has no such file.
    expect(hostileName.isError).toBe(true);
    expect(textOf(hostileName)).toContain("No exported file");
    expect(opener.opened()).toEqual([]);
  });

  it("returns the file's path and a plain message, not an error, when no opener is installed", async () => {
    const dir = join(makeHome(), "out");
    const emptyBin = mkdtempSync(join(tmpdir(), "trip-agent-empty-"));
    const server = await exportSample({ TRIP_AGENT_DIR: dir, PATH: emptyBin, DISPLAY: ":0" });
    const result = await server.client.callTool({ name: "open_trip_file", arguments: trip });
    expectFallback(result, dir);
  });

  it("returns the file's path and a plain message, not an error, when the opener fails", async () => {
    const dir = join(makeHome(), "out");
    const opener = fakeOpener(1);
    const server = await exportSample({ TRIP_AGENT_DIR: dir, PATH: opener.bin, DISPLAY: ":0" });
    const result = await server.client.callTool({ name: "open_trip_file", arguments: trip });
    expectFallback(result, dir);
  });

  it.skipIf(process.platform !== "linux")("does not try to open anything on a Linux machine with no display", async () => {
    const dir = join(makeHome(), "out");
    const opener = fakeOpener();
    // No DISPLAY or WAYLAND_DISPLAY: an SSH session or a container.
    const server = await exportSample({ TRIP_AGENT_DIR: dir, PATH: opener.bin });
    const result = await server.client.callTool({ name: "open_trip_file", arguments: trip });
    expectFallback(result, dir);
    expect(opener.opened()).toEqual([]);
  });
});
