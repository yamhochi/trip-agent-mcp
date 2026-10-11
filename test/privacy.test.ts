import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hotelBooking, mixedTrip, oneFlightTrip } from "./samples.js";
import { makeHome, startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function exportTrip(trip: unknown) {
  const dir = join(makeHome(), "out");
  const server = await startServer({ TRIP_AGENT_DIR: dir });
  open.push(server);
  const result = await server.client.callTool({ name: "export_trip", arguments: { trip } });
  const path = join(dir, "sample-japan-trip-2026-12-01.ics");
  return { result, ics: existsSync(path) ? readFileSync(path, "utf8") : undefined };
}

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const withNote = (note: string) => ({
  ...oneFlightTrip,
  bookings: [{ ...oneFlightTrip.bookings[0], note }],
});

describe("privacy guard", () => {
  const blocked: [string, string, RegExp][] = [
    ["a card number", "Paid with card 4111 1111 1111 1111", /card number/i],
    ["a card number written with dashes", "Card 4111-1111-1111-1111 on file", /card number/i],
    ["a passport number", "Passport no. X1234567 needed at check-in", /passport/i],
    ["an e-ticket number", "E-ticket number 1234567890123", /e-ticket/i],
    ["a loyalty number", "Frequent flyer number SA99887766", /loyalty/i],
  ];

  for (const [label, text, message] of blocked) {
    it(`rejects ${label} in a note, saying what to fix`, async () => {
      const { result, ics } = await exportTrip(withNote(text));
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(message);
      expect(textOf(result)).toMatch(/remove/i);
      expect(ics).toBeUndefined();
    });

    it(`rejects ${label} in any other free-text field`, async () => {
      const stay = { ...hotelBooking.legs[0], property: text };
      const { result, ics } = await exportTrip({ ...oneFlightTrip, bookings: [{ ...hotelBooking, legs: [stay] }] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(message);
      expect(textOf(result)).toContain("property");
      expect(ics).toBeUndefined();
    });
  }

  it("lets through a digit run that fails the card check, and ordinary wording", async () => {
    const { result } = await exportTrip(withNote("Order 4111 1111 1111 1112, ask for a quiet room, passport control is quick"));
    expect(result.isError).toBeFalsy();
  });

  it("finds a card number after other digits, and does not mistake a time range for a passport number", async () => {
    expect((await exportTrip(withNote("Room 12 4111 1111 1111 1111"))).result.isError).toBe(true);
    expect((await exportTrip(withNote("Passport control opens 0800-1700, 5 miles from the hotel"))).result.isError).toBeFalsy();
  });

  it("rejects private data placed in the source, which becomes the link", async () => {
    const trip = { ...oneFlightTrip, bookings: [{ ...oneFlightTrip.bookings[0], source: { messageId: "4111111111111111", senderDomain: "sample-air.test", receivedDate: "2026-10-01" } }] };
    const { result, ics } = await exportTrip(trip);
    expect(result.isError).toBe(true);
    expect(ics).toBeUndefined();
  });

  it("rejects a note over the length cap", async () => {
    const { result, ics } = await exportTrip(withNote("x".repeat(201)));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/note/);
    expect(textOf(result)).toMatch(/200/);
    expect(ics).toBeUndefined();
  });

  it("writes a note into the description", async () => {
    const { ics } = await exportTrip(withNote("Window seat requested"));
    expect(unfold(ics!)).toContain("DESCRIPTION:Sample Air\\; Test booking\\, code ending 23\\nWindow seat requested\r\n");
  });
});

describe("masked booking codes", () => {
  it("shows only the last two characters of a booking code and never the full code", async () => {
    const { ics } = await exportTrip(oneFlightTrip);
    expect(ics).toContain("code ending 23");
    expect(ics).not.toContain("ABC123");
    expect(ics).not.toContain("C123");
  });

  it("hides a code too short to mask", async () => {
    const trip = { ...oneFlightTrip, bookings: [{ ...oneFlightTrip.bookings[0], reference: "Q7" }] };
    const { ics } = await exportTrip(trip);
    expect(ics).toContain("code ending hidden");
    expect(ics).not.toContain("Q7");
  });
});

describe("email links", () => {
  const source = { messageId: "<abc.123@mail.sample-air.test>", senderDomain: "sample-air.test", receivedDate: "2026-10-01" };
  const sourced = {
    ...oneFlightTrip,
    bookings: [{ ...oneFlightTrip.bookings[0], source }],
  };

  it("puts a link back to the email in the event's link field when a source is given", async () => {
    const { result, ics } = await exportTrip(sourced);
    expect(result.isError).toBeFalsy();
    const url = unfold(ics!).match(/^URL:(.*)$/m)?.[1];
    expect(url).toBeDefined();
    expect(url).toMatch(/^https:\/\//);
    const query = decodeURIComponent(url!);
    expect(query).toContain("rfc822msgid:abc.123@mail.sample-air.test");
    expect(query).toContain("from:sample-air.test");
    expect(query).toContain("after:2026/10/1 before:2026/10/2");
  });

  it("leaves the link out when there is no source", async () => {
    const { ics } = await exportTrip(oneFlightTrip);
    expect(ics).not.toContain("URL");
  });

  it("rejects a source with a malformed date", async () => {
    const bad = { ...sourced, bookings: [{ ...sourced.bookings[0], source: { ...source, receivedDate: "yesterday" } }] };
    const { result } = await exportTrip(bad);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("receivedDate");
  });
});

describe("what is never written", () => {
  it("writes no traveller names, costs or alarms", async () => {
    const trip = {
      ...mixedTrip,
      travellers: ["Alexandra Testwell", "Bob Sample"],
      bookings: mixedTrip.bookings.map((b) => ({ ...b, cost: "GBP 1234.56" })),
    };
    const { result, ics } = await exportTrip(trip);
    expect(result.isError).toBeFalsy();
    expect(ics).not.toContain("Testwell");
    expect(ics).not.toContain("Bob");
    expect(ics).not.toContain("1234");
    expect(ics).not.toMatch(/VALARM|TRIGGER|ATTENDEE|ORGANIZER/);
  });
});
