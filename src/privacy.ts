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

// Try every run of whole digit groups (split by spaces or dashes) of 13-19 digits, so a card number
// is found after other digits ("Room 12 4111 ...") without checking arbitrary slices by chance.
const hasCardNumber = (text: string) =>
  (text.match(/\d+(?:[ -]\d+)*/g) ?? []).some((run) => {
    const groups = run.split(/[ -]/);
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
  { label: "an e-ticket number", test: (t) => near("e-?ticket|ticket (?:no|number|#)").test(t) },
  {
    label: "a loyalty number",
    test: (t) => near("frequent[ -]flyer|loyalty|rewards? (?:no|number|#|id)|member(?:ship)? (?:no|number|#|id)|miles (?:no|number|#|id)").test(t),
  },
];

/** Every blocked pattern in `text`, as a message that tells Claude what to fix. */
export function privacyProblems(text: string): string[] {
  return rules
    .filter((r) => r.test(text))
    .map((r) => `looks like it contains ${r.label}. Remove it: the calendar file must not hold private numbers. The traveller can find it in their own email via the event's link.`);
}

/** Walk the trip and report every string free-text field that holds private data. */
export function scanFreeText(value: unknown, path: (string | number)[] = [], skip: Set<string> = new Set()): PrivacyProblem[] {
  if (typeof value === "string") return privacyProblems(value).map((message) => ({ path, message }));
  if (Array.isArray(value)) return value.flatMap((v, i) => scanFreeText(v, [...path, i], skip));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => (skip.has(k) ? [] : scanFreeText(v, [...path, k], skip)));
  }
  return [];
}
