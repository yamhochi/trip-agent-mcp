import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCalendar } from "./ics.js";
import { exportFolder, tripFilename, writeTripFile } from "./files.js";
import { openFile } from "./open.js";
import { access } from "node:fs/promises";
import { join } from "node:path";
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
      const calendar = buildCalendar(trip);
      try {
        const path = await writeTripFile(trip.name, trip.startDate, calendar);
        return { content: [{ type: "text", text: `Exported "${trip.name}" to ${path}` }] };
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
    "open_trip_file",
    {
      description:
        "Open a trip's exported calendar file in the traveller's default calendar app. Takes the trip name and start date, never a path. Only a file this server exported can be opened.",
      inputSchema: { name: z.string().min(1), startDate: date },
    },
    async ({ name, startDate }) => {
      const path = join(exportFolder(), tripFilename(name, startDate));
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
              text: `Could not open the file here (no calendar app or opener available on this machine). It is at ${path}. Ask the traveller to open or import it themselves.`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `Opened ${path}` }] };
    },
  );
  return server;
}
