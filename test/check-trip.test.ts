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

    const localDinner = { ...dinnerBooking, legs: [{ ...dinnerBooking.legs[0], location: "London", timeZone: "Europe/London", start: "2026-12-02T20:00", end: "2026-12-02T22:00" }] };
    it("does not fire on a trip that stays in the home city", async () => {
      const local = stayBooking("Sample Hotel London", "London", "2026-12-01", "2026-12-03");
      const { text } = await checkTrip(trip(local, localDinner));
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

  describe("misfires found in review", () => {
    const london = "London Heathrow (LHR)";
    const outToParis = flightBooking("SA100", [london, "2026-12-01T08:00", "Europe/London"], ["Paris Charles de Gaulle (CDG)", "2026-12-01T10:30", "Europe/Paris"]);
    const backFromParis = (day: string) =>
      flightBooking("SA101", ["Paris Charles de Gaulle (CDG)", `${day}T10:00`, "Europe/Paris"], [london, `${day}T10:30`, "Europe/London"]);

    it("does not treat two different places that share a first word as the same place", async () => {
      const toNewYork = flightBooking("SA200", [london, "2026-12-01T09:00", "Europe/London"], ["New York JFK", "2026-12-01T12:00", "America/New_York"]);
      const fromNewDelhi = flightBooking("SA201", ["New Delhi (DEL)", "2026-12-03T09:00", "Asia/Kolkata"], [london, "2026-12-03T20:00", "Europe/London"]);
      const { text } = await checkTrip(trip(toNewYork, fromNewDelhi));
      expect(text).toContain("Broken location chain");
      expect(text).toContain("New York JFK");
      expect(text).toContain("New Delhi (DEL)");
    });

    it("still reads a city name and one of its airports as the same place", async () => {
      const toTokyo = flightBooking("SA300", [london, "2026-12-01T09:00", "Europe/London"], ["Tokyo", "2026-12-02T07:00", "Asia/Tokyo"]);
      const fromHaneda = flightBooking("SA301", ["Tokyo Haneda (HND)", "2026-12-03T09:00", "Asia/Tokyo"], [london, "2026-12-03T15:00", "Europe/London"]);
      const { text } = await checkTrip(trip(toTokyo, stayBooking("Sample Hotel Tokyo", "Tokyo", "2026-12-02", "2026-12-03"), fromHaneda));
      expect(text).not.toContain("Broken location chain");
    });

    it("flags two airports of one city, and says they may be the same city", async () => {
      const toNarita = flightBooking("SA400", [london, "2026-12-01T09:00", "Europe/London"], ["Tokyo Narita (NRT)", "2026-12-02T07:00", "Asia/Tokyo"]);
      const fromHaneda = flightBooking("SA401", ["Tokyo Haneda (HND)", "2026-12-02T20:00", "Asia/Tokyo"], [london, "2026-12-03T06:00", "Europe/London"]);
      const { text } = await checkTrip(trip(toNarita, fromHaneda));
      expect(text).toContain("Broken location chain");
      expect(text).toMatch(/same city/i);
    });

    it("does not report a missing return when a stay runs past the flight home", async () => {
      const parisStay = stayBooking("Sample Hotel Paris", "Paris", "2026-12-01", "2026-12-04");
      const { text } = await checkTrip(trip(outToParis, parisStay, backFromParis("2026-12-03")));
      expect(text).toBe('No gaps found in "Sample Japan Trip".');
    });

    it("does not let an activity after the flight home create unbooked nights", async () => {
      const parisStay = stayBooking("Sample Hotel Paris", "Paris", "2026-12-01", "2026-12-03");
      const romeDinner = { vendor: "Sample Trattoria", legs: [{ ...dinnerBooking.legs[0], name: "Dinner in Rome", location: "Rome", start: "2026-12-10T20:00", end: "2026-12-10T22:00", timeZone: "Europe/Rome" }] };
      const { text } = await checkTrip(trip(outToParis, parisStay, backFromParis("2026-12-03"), romeDinner));
      expect(text).toBe('No gaps found in "Sample Japan Trip".');
    });
  });
});
