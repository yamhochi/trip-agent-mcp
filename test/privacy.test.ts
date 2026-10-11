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

  it.each([
    ["dots", "Card 4111.1111.1111.1111"],
    ["two spaces", "Card 4111  1111 1111 1111"],
    ["a line break", "Card 4111\n1111 1111 1111"],
    ["non-breaking spaces", "Card 4111\u00a01111\u00a01111\u00a01111"],
    ["mixed separators", "Card 4111 1111-1111.1111"],
  ])("finds a card number written with %s between the groups", async (_how, text) => {
    const { result, ics } = await exportTrip(withNote(text));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/card number/i);
    expect(ics).toBeUndefined();
  });

  it.each([
    ["ETKT", "ETKT 1252345678901", /e-ticket/i],
    ["tkt no", "tkt no 1252345678901", /e-ticket/i],
    ["a colon after ticket", "Ticket: 1252345678901", /e-ticket/i],
    ["FFN", "FFN SA99887766", /loyalty/i],
    ["SkyMiles", "SkyMiles 1234567890", /loyalty/i],
    ["Flying Blue", "Flying Blue 123456789", /loyalty/i],
    ["a membership colon", "Membership: AB123456", /loyalty/i],
  ])("also rejects %s wording", async (_what, text, message) => {
    const { result, ics } = await exportTrip(withNote(text));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(message);
    expect(ics).toBeUndefined();
  });

  it("does not reject ordinary uses of those words", async () => {
    const note = "Ticket office opens at 0900, member of the lounge club, ask about the Bonvoy desk";
    expect((await exportTrip(withNote(note))).result.isError).toBeFalsy();
  });

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
  const withSource = (changes: Record<string, string>) => ({
    ...sourced,
    bookings: [{ ...sourced.bookings[0], source: { ...source, ...changes } }],
  });

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

  it("uses the message link the mail connector supplied, exactly as given, in preference to a search", async () => {
    // Not Gmail: a provider whose links the server could never build itself.
    const link = "https://outlook.sample.test/mail/id/AAMkAD;x,y=z/0?a=1&b=2";
    const withLink = withSource({ link });
    const { result, ics } = await exportTrip(withLink);
    expect(result.isError).toBeFalsy();
    expect(unfold(ics!).match(/^URL:(.*)$/m)?.[1]).toBe(link);
    expect(ics).not.toContain("mail.google.com");
  });

  it.each([
    ["a script address", "javascript:alert(1)"],
    ["an unencrypted address", "http://outlook.sample.test/mail/id/1"],
    ["a local file", "file:///etc/passwd"],
    ["an address with a line break that would inject calendar lines", "https://outlook.sample.test/a\r\nEND:VEVENT\r\nBEGIN:VEVENT"],
    ["an address with a space", "https://outlook.sample.test/a b"],
    ["an address with a quote or angle bracket", 'https://outlook.sample.test/a"<b>'],
    ["an address that is far too long", "https://outlook.sample.test/" + "a".repeat(2100)],
  ])("rejects a connector link that is %s, and writes nothing", async (_what, link) => {
    const bad = withSource({ link });
    const { result, ics } = await exportTrip(bad);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("link");
    expect(ics).toBeUndefined();
  });

  it("still runs the privacy guard over a connector link", async () => {
    const link = "https://outlook.sample.test/mail/4111111111111111";
    const bad = withSource({ link });
    const { result, ics } = await exportTrip(bad);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/card number/i);
    expect(ics).toBeUndefined();
  });

  it("still folds a long connector link and gives it back whole", async () => {
    const link = "https://outlook.sample.test/mail/id/" + "AbC123_-".repeat(40);
    const withLink = withSource({ link });
    const { result, ics } = await exportTrip(withLink);
    expect(result.isError).toBeFalsy();
    expect(unfold(ics!).match(/^URL:(.*)$/m)?.[1]).toBe(link);
    for (const physical of ics!.split("\r\n")) expect(Buffer.byteLength(physical)).toBeLessThanOrEqual(75);
  });

  it("leaves the link out when there is no source", async () => {
    const { ics } = await exportTrip(oneFlightTrip);
    expect(ics).not.toContain("URL");
  });

  it.each([
    ["empty", "<>"],
    ["blank", "  "],
    ["containing a space, which would widen the search", "abc def@mail.sample-air.test"],
  ])("rejects a message id that is %s", async (_what, messageId) => {
    const { result, ics } = await exportTrip(withSource({ messageId }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("messageId");
    expect(ics).toBeUndefined();
  });

  it("rejects a source with a malformed date", async () => {
    const bad = withSource({ receivedDate: "yesterday" });
    const { result } = await exportTrip(bad);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("receivedDate");
  });
});

describe("a booking code is only ever shown masked", () => {
  const withCode = (reference: string, change: (b: Record<string, unknown>) => Record<string, unknown>) => ({
    ...oneFlightTrip,
    bookings: [change({ ...oneFlightTrip.bookings[0], reference })],
  });

  it.each([
    ["a note", (b: Record<string, unknown>) => ({ ...b, note: "PNR XK29PQ for the desk" })],
    ["a note in lower case with a dash", (b: Record<string, unknown>) => ({ ...b, note: "pnr xk29-pq" })],
    ["the vendor", (b: Record<string, unknown>) => ({ ...b, vendor: "Sample Air XK29PQ" })],
    [
      "a flight's location",
      (b: Record<string, unknown>) => {
        const flight = (b.legs as { departure: object }[])[0];
        return { ...b, legs: [{ ...flight, departure: { ...flight.departure, location: "Gate XK29PQ" } }] };
      },
    ],
  ])("rejects the full code appearing in %s, saying to remove it", async (_where, change) => {
    const { result, ics } = await exportTrip(withCode("XK29PQ", change));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/booking (code|reference)/i);
    expect(textOf(result)).toMatch(/remove/i);
    expect(ics).toBeUndefined();
  });

  it("does not mistake an ordinary short word for a very short booking code", async () => {
    const { result } = await exportTrip(withCode("AB1", (b) => ({ ...b, note: "Room AB1 is on the second floor" })));
    expect(result.isError).toBeFalsy();
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
