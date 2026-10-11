import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./harness.js";

const connected: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(connected.splice(0).map((s) => s.close()));
});

async function connect() {
  const server = await startServer();
  connected.push(server);
  const { tools } = await server.client.listTools();
  const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
  return { instructions: server.client.getInstructions() ?? "", tools, description };
}

/** Each piece of guidance the route depends on, in the words a model would act on. */
const guidance: Record<string, RegExp[]> = {
  "checks that an email connector is available": [/check that an email connector[^.]*is available/i],
  "says plainly that a connector is needed when there is none": [/no (email )?connector|there is none|not available/i, /needs? (one|an email connector)|is needed/i],
  "offers pasting the booking emails instead": [/paste/i, /booking emails/i],
  "asks which trip the traveller means": [/which trip/i],
  "searches from the bookmark, going back a few days": [/from the bookmark/i, /going back a few days/i],
  "widens the search only when the traveller names an email it cannot find": [/widen/i, /names an email/i],
  "falls back to a trip-scoped search when there is no file": [/no file/i, /search the mailbox for the trip itself/i],
  "shows the trip, the gaps and any gaps now cleared before exporting": [/show the traveller the trip, the gaps and any gaps now cleared/i],
  "gets confirmation before every export": [/get their confirmation before every export/i],
  "relays gaps in natural language": [/relay each gap to the traveller in plain English/i],
  "mentions close cancellation and payment deadlines when checking": [/mention any cancellation and payment deadlines that are close/i],
  "creates breakfast events only when the email states them outright": [/breakfastIncluded \(breakfast\)[^.]*only when the email states each one outright/i],
  "creates shuttle events only when the email states them outright": [/airportTransit \(the hotel's free airport shuttle\)[^.]*only when the email states each one outright/i],
  "creates deadline events only when the email states them outright": [/deadlines \(free cancellation ends, payment due\)[^.]*only when the email states each one outright/i],
  "passes the date of the latest email processed": [/latestEmailDate/],
  "sets the international flag on flights and asks when unsure": [/Set international on every flight/i, /Ask the traveller if unsure/i],
  "asks for a time zone it cannot work out": [/time zone/i, /cannot work out|can't work out|ask the traveller/i],
};

describe("server instructions", () => {
  it("are present and not empty", async () => {
    const { instructions } = await connect();
    expect(instructions.trim().length).toBeGreaterThan(200);
  });

  for (const [piece, patterns] of Object.entries(guidance)) {
    it(`say it: ${piece}`, async () => {
      const { instructions } = await connect();
      for (const pattern of patterns) expect(instructions, String(pattern)).toMatch(pattern);
    });
  }

  it("give the message to use when there is no email connector: what is needed, and the paste fallback", async () => {
    const { instructions } = await connect();
    const message = instructions.match(/"I can't see an email connector[^"]*"/)?.[0] ?? "";
    expect(message).toMatch(/email connector/i);
    expect(message).toMatch(/I need one/i);
    expect(message).toMatch(/Gmail|Outlook/);
    expect(message).toMatch(/paste/i);
  });

  it("name the tools by their real names, so the guidance can be followed", async () => {
    const { instructions, tools } = await connect();
    for (const tool of tools) expect(instructions).toContain(tool.name);
  });

  it("rely on no client-specific prompt or skill", async () => {
    const { instructions } = await connect();
    expect(instructions).not.toMatch(/\/[a-z-]+:[a-z-]+|slash command|skill\b/i);
  });
});

describe("tool descriptions", () => {
  it("are present and not empty for every tool", async () => {
    const { tools } = await connect();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_trip", "export_trip", "get_trip_file_info", "open_trip_file"]);
    for (const tool of tools) expect((tool.description ?? "").trim().length, tool.name).toBeGreaterThan(80);
  });

  it("carry the guidance for export_trip: confirm first, the flag, the time zone, and events only when stated", async () => {
    const { description } = await connect();
    const text = description("export_trip");
    expect(text).toMatch(/confirmation before every export/i);
    expect(text).toMatch(/Set international on every flight \(ask the traveller if unsure\)/i);
    expect(text).toMatch(/ask the traveller for any time zone you cannot work out/i);
    expect(text).toMatch(/breakfastIncluded \(breakfast\)/);
    expect(text).toMatch(/airportTransit \(the hotel's free airport shuttle\)/);
    expect(text).toMatch(/deadlines only when the email states each one outright/i);
    expect(text).toMatch(/latestEmailDate/);
  });

  it("carry the guidance for check_trip: natural language, close deadlines, and near misses", async () => {
    const { description } = await connect();
    const text = description("check_trip");
    expect(text).toMatch(/relay them to the traveller in natural language/i);
    expect(text).toMatch(/mention any cancellation and payment deadlines that are close/i);
    expect(text).toMatch(/near miss/i);
  });

  it("carry the guidance for get_trip_file_info: the connector, which trip, the bookmark and the fallback", async () => {
    const { description } = await connect();
    const text = description("get_trip_file_info");
    expect(text).toMatch(/email connector/i);
    expect(text).toMatch(/paste/i);
    expect(text).toMatch(/which trip/i);
    expect(text).toMatch(/from the bookmark/i);
    expect(text).toMatch(/going back a few days/i);
    expect(text).toMatch(/widen/i);
    expect(text).toMatch(/search the mailbox for the trip itself/i);
  });

  it("carry the guidance for open_trip_file: offer it after an export, and only for a file this server exported", async () => {
    const { description } = await connect();
    const text = description("open_trip_file");
    expect(text).toMatch(/Offer it after a successful export/);
    expect(text).toMatch(/only a file this server exported/i);
  });

  it("rely on no client-specific prompt or skill", async () => {
    const { tools } = await connect();
    for (const tool of tools) expect(tool.description ?? "", tool.name).not.toMatch(/\/[a-z-]+:[a-z-]+|slash command|skill\b/i);
  });
});
