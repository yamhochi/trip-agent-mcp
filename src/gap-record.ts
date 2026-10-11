import { z } from "zod";
import { date } from "./schema.js";
import type { RecordedGap } from "./gaps.js";

/**
 * The only memory the server has of gaps: a line in the calendar file listing the gaps it last exported.
 * It is versioned so that older files can still be read when the format grows. Values are percent-encoded
 * JSON so that no place name can break the line.
 */
const PROPERTY = "X-TRIP-AGENT-GAPS";
const VERSION = 1;

const entry = z.object({
  rule: z.enum(["unbooked-night", "broken-chain", "missing-return"]),
  id: z.string().regex(/^[0-9a-f]{32}$/),
  start: date,
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
});

export const recordLine = (gaps: RecordedGap[]) => `${PROPERTY};VERSION=${VERSION}:${encodeURIComponent(JSON.stringify(gaps))}`;

const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, "");

/** The gaps an earlier file recorded. A line it cannot read (unknown version, damaged, hand-edited) counts as no record at all. */
export function readRecord(ics: string | undefined): RecordedGap[] {
  const line = ics && unfold(ics).split(/\r?\n/).find((l) => l.startsWith(`${PROPERTY};`));
  const prefix = `${PROPERTY};VERSION=${VERSION}:`;
  if (!line || !line.startsWith(prefix)) return [];
  try {
    return z.array(entry).parse(JSON.parse(decodeURIComponent(line.slice(prefix.length))));
  } catch {
    return [];
  }
}

/** The earlier file's own event for each recorded id, set to cancelled: importing a file never removes an event, so a fixed gap has to be written out as one. */
export function cancelledEvents(ics: string, ids: string[], stamp: string): string[][] {
  const events = unfold(ics)
    .split(/\r?\n/)
    .reduce<string[][]>((all, line) => {
      if (line === "BEGIN:VEVENT") all.push([]);
      else if (all.length && !all.at(-1)!.includes("END:VEVENT")) all.at(-1)!.push(line);
      return all;
    }, []);
  return ids.flatMap((id) => {
    const found = events.find((lines) => lines.includes(`UID:${id}@trip-agent-mcp`));
    if (!found) return [];
    const body = found.filter((l) => l !== "END:VEVENT").map((l) => (l.startsWith("STATUS:") ? "STATUS:CANCELLED" : l.startsWith("DTSTAMP:") ? `DTSTAMP:${stamp}` : l));
    return [["BEGIN:VEVENT", ...body, "END:VEVENT"]];
  });
}
