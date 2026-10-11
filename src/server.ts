import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCalendar, gapId } from "./ics.js";
import { readTripFile, tripFilePath, writeTripFile } from "./files.js";
import { coveringLeg, findGaps, hasStandingLegs, type RecordedGap } from "./gaps.js";
import { readRecord } from "./gap-record.js";
import { isFutureDate, readBookmark } from "./bookmark.js";
import { openFile } from "./open.js";
import { access } from "node:fs/promises";
import { z } from "zod";
import { date, tripSchema } from "./schema.js";

/** An earlier gap in the traveller's words. */
function describeRecorded(r: RecordedGap): string {
  // Only the kind and the date: the places in a record came from a file, which anyone can edit, and are used for matching alone.
  if (r.rule === "unbooked-night") return `The unbooked night of ${r.start}`;
  if (r.rule === "missing-return") return `The missing return home, noted on ${r.start}`;
  return `The broken location chain noted on ${r.start}`;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "trip-agent-mcp", version: "0.0.0" });
  server.registerTool(
    "export_trip",
    {
      description:
        "Export a trip as a calendar (.ics) file on the traveller's computer. Takes the assembled trip (name, start date, home city, bookings with their legs: each leg is travel by flight, train, ferry, bus, car or other, a stay, or an activity); the server chooses the file name and folder. Each gap the check finds is also written as a tentative placeholder event (for example \"Missing: no lodging booked\"), and a placeholder from an earlier export whose gap is now fixed is written out as cancelled. Show the traveller the trip, the gaps and any gaps now covered, and get their confirmation before calling this. Pass latestEmailDate (the date of the latest email you processed) so the next run can start its search there; it is saved only if the export succeeds, an older date never replaces a newer one, a date in the future is refused, and leaving it out keeps the earlier bookmark. The reply says which bookmark the file now has. Returns the path written.",
      inputSchema: {
        trip: tripSchema,
        latestEmailDate: date
          .optional()
          .describe("The date of the latest email processed for this trip, as the bookmark where the next mailbox search starts. Leave it out to keep the earlier bookmark."),
      },
    },
    async ({ trip, latestEmailDate }) => {
      // A calendar file needs at least one event, and an empty one would overwrite a good earlier export.
      if (trip.bookings.every((b) => b.legs.every((l) => l.status === "idea"))) {
        return {
          content: [
            {
              type: "text",
              text: `Nothing was exported: every leg in "${trip.name}" is still an idea, and ideas are not written to the calendar. Mark the legs the traveller has decided on as planned or confirmed, then export again. Any earlier file for this trip was left as it was.`,
            },
          ],
        };
      }
      if (latestEmailDate && isFutureDate(latestEmailDate, new Date())) {
        return {
          isError: true,
          content: [{ type: "text", text: `Nothing was exported: latestEmailDate ${latestEmailDate} is in the future. Pass the date of the latest email you actually processed (today at the latest), or leave it out to keep the earlier bookmark.` }],
        };
      }
      const earlierFile = await readTripFile(trip.name, trip.startDate);
      const earlierExists = earlierFile !== undefined || (await access(tripFilePath(trip.name, trip.startDate)).then(() => true, () => false));
      const calendar = buildCalendar(trip, new Date(), earlierFile, latestEmailDate);
      try {
        const { path, similar } = await writeTripFile(trip.name, trip.startDate, calendar.text);
        const placeholders = [
          calendar.placeholders ? `${calendar.placeholders} gap placeholder${calendar.placeholders === 1 ? "" : "s"} added or kept` : "",
          calendar.cancelled ? `${calendar.cancelled} earlier placeholder${calendar.cancelled === 1 ? "" : "s"} cancelled because the gap is fixed` : "",
        ].filter(Boolean);
        const gapNote = placeholders.length ? ` ${placeholders.join("; ")}.` : "";
        const notice = similar.length
          ? ` A file for a similarly named trip with a different start date already exists in that folder (${similar.join(", ")}). If the trip moved, the old file may now be stale: ask the traveller before suggesting they delete it.`
          : "";
        // Say which bookmark the file now has, so a bookmark that was not saved is never a surprise.
        const earlierLost = calendar.earlierBookmarkUnreadable || (earlierExists && earlierFile === undefined);
        const bookmarkNote = calendar.bookmark
          ? ` Bookmark: ${calendar.bookmark}${latestEmailDate && latestEmailDate < calendar.bookmark ? ` (the earlier, later date was kept; ${latestEmailDate} is older)` : ""}.`
          : earlierLost && !latestEmailDate
            ? " No bookmark was saved: the earlier file's bookmark could not be read, and no latestEmailDate was given. Pass latestEmailDate next time."
            : " No bookmark was saved: no latestEmailDate was given.";
        return { content: [{ type: "text", text: `Exported "${trip.name}" to ${path}.${notice}${gapNote}${bookmarkNote}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Could not write the calendar file (${message}). Ask the traveller to choose another folder (TRIP_AGENT_DIR).` }],
        };
      }
    },
  );
  server.registerTool(
    "check_trip",
    {
      description:
        "Check an assembled trip for what is missing, by plain rules: an unbooked night, a broken location chain (a journey by any mode of travel, or a stay, that does not start where the previous one ended) and a missing return to the home city. Takes the same trip as export_trip. Ideas and cancelled legs never count; a planned stay with no booking covers its nights; calendar placeholders never count either. Reads the trip's earlier export, if there is one, and also reports each gap recorded there that the trip now covers, and by which leg: ask the traveller to confirm before exporting, which cancels its placeholder. Changes nothing. Returns each gap in plain English: relay them to the traveller and ask how they want to fix them.",
      inputSchema: { trip: tripSchema },
    },
    async ({ trip }) => {
      if (!hasStandingLegs(trip)) {
        return { content: [{ type: "text", text: `Nothing to check in "${trip.name}": every leg is an idea or cancelled. Add the legs the traveller has decided on first.` }] };
      }
      const gaps = findGaps(trip);
      const current = new Set(gaps.map(gapId));
      const covered = readRecord(await readTripFile(trip.name, trip.startDate))
        .filter((r) => !current.has(r.id))
        .map((r) => ({ r, by: coveringLeg(trip, r) }));
      const text = gaps.length
        ? `${gaps.length === 1 ? "1 gap" : `${gaps.length} gaps`} found in "${trip.name}":\n${gaps.map((g) => `- ${g.message}`).join("\n")}`
        : `No gaps found in "${trip.name}".`;
      const earlier = covered.length
        ? `\n\nGaps from the earlier export that are now covered (ask the traveller to confirm before exporting, which cancels their calendar placeholders):\n${covered
            .map(({ r, by }) => `- ${describeRecorded(r)}${by ? ` is now covered by ${by}` : " is no longer a gap"}.`)
            .join("\n")}`
        : "";
      return { content: [{ type: "text", text: text + earlier }] };
    },
  );
  server.registerTool(
    "get_trip_file_info",
    {
      description:
        "Say whether a trip's exported calendar file exists, and if it does, its bookmark (the date of the latest email processed by the last export) and when it was last exported. Takes the trip name and start date. Call it before searching the mailbox: search from the bookmark date, going back a few days; if there is no file or no bookmark, search the mailbox for the trip itself. Changes nothing.",
      inputSchema: { name: z.string().min(1), startDate: date },
    },
    async ({ name, startDate }) => {
      const path = tripFilePath(name, startDate);
      try {
        await access(path);
      } catch {
        return {
          content: [{ type: "text", text: `No file for "${name}" starting ${startDate}: it has not been exported. Search the mailbox for the trip itself, with no start date, then export it.` }],
        };
      }
      const text = await readTripFile(name, startDate);
      if (text === undefined) {
        return {
          content: [{ type: "text", text: `The file for "${name}" starting ${startDate} exists but could not be read (it may be damaged or larger than expected), so its bookmark is unknown. Search the mailbox for the trip itself.` }],
        };
      }
      const { date: bookmark, exportedAt, unreadable } = readBookmark(text);
      const lines = [
        `The file for "${name}" starting ${startDate} exists.`,
        bookmark
          ? `Bookmark: ${bookmark} (the latest email processed). Search from there, going back a few days.`
          : unreadable
            ? "The file's bookmark could not be read, so search the mailbox for the trip itself."
            : "This file has no bookmark, so search the mailbox for the trip itself.",
        `Last exported: ${exportedAt ?? "unknown"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
  server.registerTool(
    "open_trip_file",
    {
      description:
        "Open a trip's exported calendar file in the traveller's default calendar app. Takes the trip name and start date, never a path. Only a file this server exported can be opened.",
      inputSchema: { name: z.string().min(1), startDate: date },
    },
    async ({ name, startDate }) => {
      const path = tripFilePath(name, startDate);
      try {
        await access(path);
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `No exported file for "${name}" starting ${startDate}. Export the trip first.` }],
        };
      }
      try {
        await openFile(path);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Could not open the file here (there is no calendar app, display or opener that responded on this machine). It is at ${path}. Ask the traveller to open or import it themselves.`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `Opened ${path}` }] };
    },
  );
  return server;
}
