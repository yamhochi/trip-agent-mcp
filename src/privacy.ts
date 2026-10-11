export const NOTE_MAX = 200;

export interface PrivacyProblem {
  path: (string | number)[];
  message: string;
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

// Try every run of whole digit groups (split by spaces, line breaks, dots or dashes) of 13-19 digits, so a
// card number is found after other digits ("Room 12 4111 ...") without checking arbitrary slices by chance.
const SEPARATOR = String.raw`[\s.-]+`;
const hasCardNumber = (text: string) =>
  (text.match(new RegExp(String.raw`\d+(?:${SEPARATOR}\d+)*`, "g")) ?? []).some((run) => {
    const groups = run.split(new RegExp(SEPARATOR));
    for (let from = 0; from < groups.length; from++) {
      let digits = "";
      for (let to = from; to < groups.length; to++) {
        digits += groups[to];
        if (digits.length > 19) break;
        if (digits.length >= 13 && luhn(digits)) return true;
      }
    }
    return false;
  });

// An identifier is a run of at least six letters or digits that includes a digit, after wording that names it.
const identifier = String.raw`[^\n]{0,25}?\b(?=[A-Z]*\d)[A-Z0-9]{6,}\b`;
const near = (wording: string) => new RegExp(`(?:${wording})${identifier}`, "i");

const rules: { label: string; test: (text: string) => boolean }[] = [
  { label: "a card number", test: hasCardNumber },
  { label: "a passport number", test: (t) => near("passport").test(t) },
  { label: "an e-ticket number", test: (t) => near("e-?ticket|etkt|(?:tkt|ticket) (?:no|number|#)|ticket\\s*[:#]").test(t) },
  {
    label: "a loyalty number",
    test: (t) => near("frequent[ -]flyer|ffn|skymiles|aadvantage|flying blue|loyalty|rewards? (?:no|number|#|id)|member(?:ship)?(?: (?:no|number|#|id)|\\s*[:#])|miles (?:no|number|#|id)").test(t),
  },
];

/** Every blocked pattern in `text`, as a message that tells Claude what to fix. */
export function privacyProblems(text: string): string[] {
  return rules
    .filter((r) => r.test(text))
    .map((r) => `looks like it contains ${r.label}. Remove it: the calendar file must not hold private numbers. The traveller can find it in their own email via the event's link.`);
}

/** The one place a booking code is allowed to be written in full: the booking's own reference, which the server masks. */
const isBookingReference = (path: (string | number)[]) => path.length === 3 && path[0] === "bookings" && path[2] === "reference";

/** Walk the trip and report every string free-text field that holds private data. */
export function scanFreeText(value: unknown, path: (string | number)[] = []): PrivacyProblem[] {
  if (isBookingReference(path)) return [];
  if (typeof value === "string") return privacyProblems(value).map((message) => ({ path, message }));
  if (Array.isArray(value)) return value.flatMap((v, i) => scanFreeText(v, [...path, i]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => scanFreeText(v, [...path, k]));
  }
  return [];
}

// Short enough and an ordinary word could be mistaken for a code, so only codes of this length are searched for.
const MIN_CODE_LENGTH = 5;
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Every place a booking's own reference is written out in full somewhere other than its reference. */
export function bookingCodeLeaks(trip: { bookings: { reference?: string }[] }): PrivacyProblem[] {
  return trip.bookings.flatMap((booking, i) => {
    const code = booking.reference ? squash(booking.reference) : "";
    if (code.length < MIN_CODE_LENGTH) return [];
    const texts: PrivacyProblem[] = [];
    const walk = (value: unknown, path: (string | number)[]) => {
      if (typeof value === "string") {
        if (squash(value).includes(code)) {
          texts.push({ path, message: "contains the booking code. Remove it: only the last two characters of a booking code are ever written, and the traveller can find the rest in their own email via the event's link." });
        }
      } else if (Array.isArray(value)) value.forEach((v, j) => walk(v, [...path, j]));
      else if (value && typeof value === "object") {
        // The reference is masked by the server, and the source is a pointer Claude cannot reword: both are exempt.
        for (const [k, v] of Object.entries(value)) if (!(path.length === 2 && (k === "reference" || k === "source"))) walk(v, [...path, k]);
      }
    };
    walk(booking, ["bookings", i]);
    return texts;
  });
}
