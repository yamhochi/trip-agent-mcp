/** Matching of free-text place names, which is a heuristic: the schema carries a place as text, not as an id. */

export const words = (place: string): string[] => place.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Same place if one name's words all appear in the other ("Tokyo" in "Tokyo Haneda (HND)"). Sharing only a first word is not enough: "New York" is not "New Delhi". */
export function samePlace(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

const FILLER = new Set(["airport", "international", "station", "central", "terminal", "hotel"]);

/** Looser: the two names share a real place name ("Shinjuku, Tokyo" and "Tokyo Haneda (HND)" both say Tokyo). Used where a stay is involved, because a stay is named by its neighbourhood or city and a journey by its airport or station. */
export function sameArea(a: string, b: string): boolean {
  if (samePlace(a, b)) return true;
  const named = new Set(words(a).filter((w) => w.length >= 4 && !FILLER.has(w)));
  return words(b).some((w) => named.has(w));
}

/** Two names that start alike but are not the same place may be two airports of one city. */
export const mayBeSameCity = (a: string, b: string) => words(a)[0] === words(b)[0];

