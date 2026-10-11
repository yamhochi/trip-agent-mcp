import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCalendar } from "./ics.js";
import { tripFilePath, writeTripFile } from "./files.js";
import { findGaps, hasStandingLegs } from "./gaps.js";
import { openFile } from "./open.js";
import { access } from "node:fs/promises";
import { z } from "zod";
import { date, tripSchema } from "./schema.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "trip-agent-mcp", version: "0.0.0" });
  server.registerTool(
    "export_trip",
    {
      description:
        "Export a trip as a calendar (.ics) file on the traveller's computer. Takes the assembled trip (name, start date, home city, bookings with their legs); the server chooses the file name and folder. Show the traveller the trip and get their confirmation before calling this. Returns the path written.",
      inputSchema: { trip: tripSchema },
    },
    async ({ trip }) => {
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
      const calendar = buildCalendar(trip);
      try {
        const { path, similar } = await writeTripFile(trip.name, trip.startDate, calendar);
        const notice = similar.length
          ? ` A file for a similarly named trip with a different start date already exists in that folder (${similar.join(", ")}). If the trip moved, the old file may now be stale: ask the traveller before suggesting they delete it.`
          : "";
        return { content: [{ type: "text", text: `Exported "${trip.name}" to ${path}${notice ? "." : ""}${notice}` }] };
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
        "Check an assembled trip for what is missing, by plain rules: an unbooked night, a broken location chain (a flight that does not leave from where the last one arrived) and a missing return to the home city. Takes the same trip as export_trip. Ideas and cancelled legs never count; a planned stay with no booking covers its nights. Keeps nothing. Returns each gap in plain English: relay them to the traveller and ask how they want to fix them.",
      inputSchema: { trip: tripSchema },
    },
    async ({ trip }) => {
      if (!hasStandingLegs(trip)) {
        return { content: [{ type: "text", text: `Nothing to check in "${trip.name}": every leg is an idea or cancelled. Add the legs the traveller has decided on first.` }] };
      }
      const gaps = findGaps(trip);
      const text = gaps.length
        ? `${gaps.length === 1 ? "1 gap" : `${gaps.length} gaps`} found in "${trip.name}":\n${gaps.map((g) => `- ${g.message}`).join("\n")}`
        : `No gaps found in "${trip.name}".`;
      return { content: [{ type: "text", text }] };
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
