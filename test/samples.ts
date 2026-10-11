// An invented trip. No real trip data is used anywhere in these tests.
export const oneFlightTrip = {
  name: "Sample Japan Trip",
  startDate: "2026-12-01",
  homeCity: "London",
  bookings: [
    {
      vendor: "Sample Air; Test",
      reference: "ABC123",
      legs: [
        {
          kind: "travel",
          mode: "flight",
          status: "confirmed",
          identifier: "JL044",
          from: { location: "London Heathrow (LHR)", localTime: "2026-12-01T11:30", timeZone: "Europe/London" },
          to: { location: "Tokyo Haneda (HND)", localTime: "2026-12-02T07:35", timeZone: "Asia/Tokyo" },
        },
      ],
    },
  ],
};

export const hotelBooking = {
  vendor: "Sample Stays",
  reference: "HTL789",
  legs: [
    {
      kind: "stay",
      status: "confirmed",
      property: "Sample Hotel Tokyo",
      location: "Tokyo",
      checkIn: "2026-12-02",
      checkOut: "2026-12-05",
    },
  ],
};

export const dinnerBooking = {
  vendor: "Sample Sushi",
  reference: "RES456",
  legs: [
    {
      kind: "activity",
      status: "confirmed",
      name: "Dinner at Sample Sushi",
      location: "Shibuya, Tokyo",
      start: "2026-12-03T20:00",
      end: "2026-12-03T22:00",
      timeZone: "Asia/Tokyo",
    },
  ],
};

export const mixedTrip = {
  ...oneFlightTrip,
  bookings: [...oneFlightTrip.bookings, hotelBooking, dinnerBooking],
};
