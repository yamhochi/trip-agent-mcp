import { z } from "zod";
import { date } from "./schema.js";

/**
 * Where the last mailbox search stopped: the date of the latest email processed, and when the file was exported.
 * A line in the calendar file, versioned so older files stay readable. Version 1 held the date alone as plain text;
 * version 2 holds percent-encoded JSON with the export time as well. Only the current version is written.
 */
const PROPERTY = "X-TRIP-AGENT-BOOKMARK";
const VERSION = 2;

export interface Bookmark {
  /** The date of the latest email processed. */
  date?: string;
  /** When the file was exported, as an ISO timestamp. */
  exportedAt?: string;
  /** The file has a bookmark line that could not be used: damaged, an unknown version, or a date that cannot be right. */
  unreadable?: boolean;
}

const DAY_MS = 86_400_000;

/** A latest-email date later than tomorrow (UTC; a day is allowed for the traveller's time zone) cannot be true, and would make the next search skip real emails. */
export const isFutureDate = (day: string, now: Date) => day > new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);

/** The later of two dates, either of which may be missing: a bookmark only ever moves forward. */
export const laterDate = (a?: string, b?: string) => (a && b ? (a > b ? a : b) : (a ?? b));

const current = z.object({ date: date.optional().catch(undefined), exportedAt: z.iso.datetime().optional().catch(undefined) });

export const bookmarkLine = (b: Bookmark) => `${PROPERTY};VERSION=${VERSION}:${encodeURIComponent(JSON.stringify(b))}`;

/** What an earlier file recorded. A line it cannot read (unknown version, damaged, hand-edited, a date in the future) counts as no bookmark, and says so. */
export function readBookmark(ics: string | undefined, now: Date = new Date()): Bookmark {
  const line = ics?.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).find((l) => l.startsWith(`${PROPERTY};`));
  if (!line) return {};
  const match = line.match(/^[^:;]*;VERSION=(\d+):(.*)$/);
  try {
    const found =
      match?.[1] === "1" ? (date.safeParse(match[2]).success ? { date: match[2] } : undefined)
      : match?.[1] === String(VERSION) ? current.parse(JSON.parse(decodeURIComponent(match[2])))
      : undefined;
    if (found && !(found.date && isFutureDate(found.date, now))) return found;
  } catch {
    // fall through: damaged
  }
  return { unreadable: true };
}
