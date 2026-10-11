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
}

const current = z.object({ date: date.optional().catch(undefined), exportedAt: z.iso.datetime().optional().catch(undefined) });

export const bookmarkLine = (b: Bookmark) => `${PROPERTY};VERSION=${VERSION}:${encodeURIComponent(JSON.stringify(b))}`;

/** What an earlier file recorded. A line it cannot read (unknown version, damaged, hand-edited) counts as no bookmark. */
export function readBookmark(ics: string | undefined): Bookmark {
  const line = ics?.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).find((l) => l.startsWith(`${PROPERTY};`));
  const match = line?.match(/^[^:;]*;VERSION=(\d+):(.*)$/);
  if (!match) return {};
  try {
    if (match[1] === "1") return date.safeParse(match[2]).success ? { date: match[2] } : {};
    if (match[1] === String(VERSION)) return current.parse(JSON.parse(decodeURIComponent(match[2])));
  } catch {
    // fall through: damaged
  }
  return {};
}
