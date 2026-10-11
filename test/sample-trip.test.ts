import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const sample = (name: string) => readFileSync(join(import.meta.dirname, "..", "docs", "sample", name), "utf8");
const trip = JSON.parse(sample("tokyo-in-december.trip.json"));

/** The time of the export is the only thing that differs between two exports of the same trip. */
const withoutTimes = (ics: string) =>
  ics
    .replace(/\r\n /g, "")
    .replace(/^DTSTAMP:.*$/gm, "DTSTAMP:20000101T000000Z")
    .replace(/exportedAt%22%3A%22[^%]*(?:%3A[^%]*)*%22/g, "exportedAt%22%3A%22TIME%22");

describe("the sample trip that the readme links to", () => {
  it("is exactly what the server writes for the sample trip today, so the sample cannot go out of date", async () => {
    const dir = join(makeHome(), "out");
    const server = await startServer({ TRIP_AGENT_DIR: dir });
    open.push(server);
    const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
    expect(result.isError, textOf(result)).toBeFalsy();
    const written = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".ics"))!), "utf8");
    // If this fails, the server's output changed on purpose: run `npm run build && node scripts/make-sample.mjs` and review the change.
    expect(withoutTimes(sample("tokyo-in-december-2026-12-01.ics"))).toBe(withoutTimes(written));
  });

  it("is a calendar file with the twelve events the readme describes, and only invented data", () => {
    const ics = sample("tokyo-in-december-2026-12-01.ics");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(12);
    expect(ics).not.toMatch(/@(?!trip-agent-mcp)[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(ics).not.toContain("KQ7F2M");
    expect(ics).not.toContain("HK48213");
  });
});
