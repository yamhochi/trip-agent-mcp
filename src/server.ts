import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCalendar } from "./ics.js";
import { writeTripFile } from "./files.js";
import { tripSchema } from "./schema.js";

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
  return server;
}
