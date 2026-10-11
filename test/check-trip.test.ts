import { afterEach, describe, expect, it } from "vitest";
import { dinnerBooking, hotelBooking, oneFlightTrip } from "./samples.js";
import { startServer, textOf } from "./harness.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function checkTrip(trip: unknown) {
  const server = await startServer();
  open.push(server);
  const result = await server.client.callTool({ name: "check_trip", arguments: { trip } });
  return { result, text: textOf(result) };
}

const trip = (...bookings: object[]) => ({ ...oneFlightTrip, bookings });
const withStatus = (booking: { legs: object[] }, status: string) => ({ ...booking, legs: [{ ...booking.legs[0], status }] });
const flightBooking = (flightNumber: string, from: [string, string, string], to: [string, string, string], status = "confirmed") => ({
  vendor: "Sample Air",
  legs: [
    {
      kind: "flight",
      status,
      flightNumber,
      departure: { location: from[0], localTime: from[1], timeZone: from[2] },
      arrival: { location: to[0], localTime: to[1], timeZone: to[2] },
    },
  ],
});
const stayBooking = (property: string, location: string, checkIn: string, checkOut: string, status = "confirmed", vendor = "Sample Stays") => ({
  vendor,
  legs: [{ kind: "stay", status, property, location, checkIn, checkOut }],
});

const outbound = oneFlightTrip.bookings[0]; // London -> Tokyo, lands 2 Dec
const home = flightBooking("SA999", ["Tokyo Haneda (HND)", "2026-12-05T10:00", "Asia/Tokyo"], ["London Heathrow (LHR)", "2026-12-05T14:00", "Europe/London"]);
const completeTrip = trip(outbound, hotelBooking, home);

describe("check_trip", () => {
  it("reports no gaps on a complete trip", async () => {
    const { result, text } = await checkTrip(completeTrip);
    expect(result.isError).toBeFalsy();
    expect(text).toBe('No gaps found in "Sample Japan Trip".');
  });

  describe("unbooked night", () => {
    it("names the night no stay covers", async () => {
      const shortStay = stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-02", "2026-12-04");
      const { text } = await checkTrip(trip(outbound, shortStay, home));
      expect(text).toContain("Unbooked night");
      expect(text).toContain("2026-12-04");
      expect(text).not.toMatch(/Broken|return/i);
    });

    it("names the first and last night of a run of missing nights", async () => {
      const shortStay = stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-02", "2026-12-03");
      const { text } = await checkTrip(trip(outbound, shortStay, home));
      expect(text).toContain("2026-12-03 to 2026-12-04");
    });

    it("counts a night spent on an overnight flight as covered", async () => {
      const { text } = await checkTrip(completeTrip);
      expect(text).not.toContain("2026-12-01");
    });

    it("lets a planned stay with no booking reference cover a night", async () => {
      const friend = stayBooking("A friend's flat", "Tokyo", "2026-12-02", "2026-12-05", "planned", "Staying with a friend");
      const { text } = await checkTrip(trip(outbound, friend, home));
      expect(text).toBe('No gaps found in "Sample Japan Trip".');
    });

    it.each(["idea", "cancelled"])("does not let a %s stay cover a night", async (status) => {
      const { text } = await checkTrip(trip(outbound, { ...hotelBooking, legs: [{ ...hotelBooking.legs[0], status }] }, home));
      expect(text).toContain("Unbooked night");
      expect(text).toContain("2026-12-02 to 2026-12-04");
    });
  });

  describe("broken location chain", () => {
    const toOsaka = flightBooking("SA100", ["Tokyo Haneda (HND)", "2026-12-01T09:00", "Asia/Tokyo"], ["Osaka Kansai (KIX)", "2026-12-01T10:30", "Asia/Tokyo"]);
    const fromTokyo = flightBooking("SA200", ["Tokyo Haneda (HND)", "2026-12-04T09:00", "Asia/Tokyo"], ["London Heathrow (LHR)", "2026-12-04T14:00", "Europe/London"]);

    it("names both endpoints when a flight leaves from somewhere the traveller is not", async () => {
      const osakaStay = stayBooking("Sample Hotel Osaka", "Osaka", "2026-12-01", "2026-12-04");
      const { text } = await checkTrip(trip(toOsaka, osakaStay, fromTokyo));
      expect(text).toContain("Broken location chain");
      expect(text).toContain("Osaka Kansai (KIX)");
      expect(text).toContain("Tokyo Haneda (HND)");
      expect(text).not.toContain("Unbooked night");
    });

    it("accepts a flight home from a city the traveller stayed in on the way", async () => {
      const tokyoStay = stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-01", "2026-12-04");
      const { text } = await checkTrip(trip(toOsaka, tokyoStay, fromTokyo));
      expect(text).toBe('No gaps found in "Sample Japan Trip".');
    });

    it("ignores a cancelled flight in the chain", async () => {
      const cancelled = flightBooking("SA100", ["Tokyo Haneda (HND)", "2026-12-01T09:00", "Asia/Tokyo"], ["Osaka Kansai (KIX)", "2026-12-01T10:30", "Asia/Tokyo"], "cancelled");
      const tokyoStay = stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-01", "2026-12-04");
      const { text } = await checkTrip(trip(cancelled, tokyoStay, fromTokyo));
      expect(text).not.toContain("Broken location chain");
    });

    it("ignores an idea flight in the chain", async () => {
      const idea = flightBooking("SA300", ["Paris (CDG)", "2026-12-04T08:00", "Europe/Paris"], ["Rome (FCO)", "2026-12-04T10:00", "Europe/Rome"], "idea");
      const { text } = await checkTrip(trip(outbound, hotelBooking, idea, home));
      expect(text).not.toContain("Broken location chain");
    });
  });

  describe("missing return", () => {
    it("fires when the trip ends away from home", async () => {
      const { text } = await checkTrip(trip(outbound, hotelBooking));
      expect(text).toContain("Missing return");
      expect(text).toContain("Tokyo");
      expect(text).toContain("London");
      expect(text).not.toMatch(/Unbooked night|Broken/);
    });

    it("is not cleared by a cancelled flight home", async () => {
      const { text } = await checkTrip(trip(outbound, hotelBooking, withStatus(home, "cancelled")));
      expect(text).toContain("Missing return");
    });

    it("is not cleared by an idea flight home", async () => {
      const { text } = await checkTrip(trip(outbound, hotelBooking, withStatus(home, "idea")));
      expect(text).toContain("Missing return");
    });

    it("is cleared by a planned flight home", async () => {
      const { text } = await checkTrip(trip(outbound, hotelBooking, withStatus(home, "planned")));
      expect(text).not.toContain("Missing return");
    });

    it("does not fire on a trip that stays in the home city", async () => {
      const local = stayBooking("Sample Hotel London", "London", "2026-12-01", "2026-12-03");
      const { text } = await checkTrip(trip(local, dinnerBooking.legs.length ? { ...dinnerBooking, legs: [{ ...dinnerBooking.legs[0], location: "London", timeZone: "Europe/London", start: "2026-12-02T20:00", end: "2026-12-02T22:00" }] } : local));
      expect(text).not.toContain("Missing return");
    });
  });

  const lateDinner = { ...dinnerBooking, legs: [{ ...dinnerBooking.legs[0], start: "2026-12-05T20:00", end: "2026-12-05T22:00" }] };
  it("reports several gaps at once", async () => {
    const { text } = await checkTrip(trip(outbound, stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-02", "2026-12-03"), lateDinner));
    expect(text).toContain("Unbooked night");
    expect(text).toContain("Missing return");
  });

  it("finds nothing to check when every leg is an idea", async () => {
    const { result, text } = await checkTrip(trip(withStatus(hotelBooking, "idea")));
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Nothing to check");
  });
});
