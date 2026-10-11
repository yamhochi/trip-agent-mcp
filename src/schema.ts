import { z } from "zod";
import { NOTE_MAX, bookingCodeLeaks, scanFreeText } from "./privacy.js";

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

const source = z
  .object({
    messageId: z.string().regex(/^<?[^\s<>]+>?$/, { message: "must be the message id as given, with no spaces (angle brackets are fine)" }),
    senderDomain: z.string().regex(/^[A-Za-z0-9.-]+$/, { message: 'must be a bare domain such as "sample-air.test"' }),
    receivedDate: date,
    link: z
      .string()
      .max(2000, { message: "is too long for a link to one message" })
      // The link goes into the file as written, so it must be a plain https address: no spaces, line breaks or quotes.
      .regex(/^https:\/\/[^\s"<>\\^`{|}]+$/, { message: "must be a plain https:// link to the one message, as the mail connector gave it" })
      .optional()
      .describe(
        "The link to this one message, if the mail connector gives one. Pass it exactly as given. Leave it out when the connector gives none; a Gmail search link is then built from the other fields, which only works for Gmail.",
      ),
  })
  .describe("A pointer back to the one email this booking came from. Never the email's content.");

const booking = z.object({
  vendor: z.string().min(1),
  reference: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Confirmation reference. Leave it out for something with no confirmation reference, such as a dinner the traveller planned. Only its last two characters are ever written to the file.",
    ),
  note: z
    .string()
    .max(NOTE_MAX, { message: `is too long (the limit is ${NOTE_MAX} characters): shorten it, and leave details in the email` })
    .optional()
    .describe(`A short note for the event description, at most ${NOTE_MAX} characters. Never put card, passport, e-ticket or loyalty numbers in it.`),
  source: source.optional(),
  legs: z.array(leg).min(1),
});

const tripShape = z.object({
  name: z.string().min(1),
  startDate: date,
  homeCity: z.string().min(1),
  travellers: z.array(z.string()).optional(),
  bookings: z.array(booking).min(1),
});

// The booking reference is an identifier that the server masks, so it is not scanned; the source is scanned because it ends up in the link.
export const tripSchema = tripShape.superRefine((trip, ctx) => {
  for (const { path, message } of [...scanFreeText(trip), ...bookingCodeLeaks(trip)]) {
    ctx.addIssue({ code: "custom", path, message });
  }
});

export type Trip = z.infer<typeof tripSchema>;
export type Flight = z.infer<typeof flight>;
export type Stay = z.infer<typeof stay>;
export type Activity = z.infer<typeof activity>;
export type Leg = z.infer<typeof leg>;
