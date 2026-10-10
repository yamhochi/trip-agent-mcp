import { z } from "zod";

const timeZone = z.string().refine(
  (tz) => {
    if (tz !== "UTC" && !/^[A-Za-z_]+(\/[A-Za-z_+-]+)+$/.test(tz)) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a named IANA time zone such as "Europe/London" (not an offset or abbreviation)' },
);

const isRealDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const localTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'must be a local time like "2026-12-01T11:30", with no zone or offset' })
  .refine((t) => isRealDate(t.slice(0, 10)) && +t.slice(11, 13) < 24 && +t.slice(14) < 60, {
    message: "is not a real date and time",
  });

const endpoint = z.object({
  location: z.string().min(1),
  localTime,
  timeZone,
});

const flight = z.object({
  kind: z.literal("flight"),
  status: z.literal("confirmed"),
  flightNumber: z.string().min(1),
  departure: endpoint,
  arrival: endpoint,
});

export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be a date like "2026-12-01"' })
  .refine(isRealDate, { message: "is not a real date" });

const stay = z
  .object({
    kind: z.literal("stay"),
    status: z.literal("confirmed"),
    property: z.string().min(1),
    location: z.string().min(1),
    checkIn: date,
    checkOut: date,
  })
  .refine((s) => s.checkOut > s.checkIn, { path: ["checkOut"], message: "must be after checkIn" });

const activityZone = z.string({
  error: (issue) =>
    issue.input === undefined
      ? "is required: work out the IANA time zone from the location, or ask the traveller, then supply it"
      : undefined,
});

const activity = z
  .object({
    kind: z.literal("activity"),
    status: z.literal("confirmed"),
    name: z.string().min(1),
    location: z.string().min(1),
    start: localTime,
    end: localTime,
    timeZone: activityZone.pipe(timeZone),
  })
  .refine((a) => a.end > a.start, { path: ["end"], message: "must be after start" });

const leg = z.discriminatedUnion("kind", [flight, stay, activity]);

const booking = z.object({
  vendor: z.string().min(1),
  reference: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Confirmation reference. Leave it out for something with no booking, such as a dinner the traveller planned. Only its last two characters are ever written to the file.",
    ),
  legs: z.array(leg).min(1),
});

export const tripSchema = z.object({
  name: z.string().min(1),
  startDate: date,
  homeCity: z.string().min(1),
  travellers: z.array(z.string()).optional(),
  bookings: z.array(booking).min(1),
});

export type Trip = z.infer<typeof tripSchema>;
export type Flight = z.infer<typeof flight>;
export type Stay = z.infer<typeof stay>;
export type Activity = z.infer<typeof activity>;
export type Leg = z.infer<typeof leg>;
