#!/usr/bin/env node
// Rebuilds docs/sample/tokyo-in-december-2026-12-01.ics from docs/sample/tokyo-in-december.trip.json by running the
// real server, so the sample is always what the server writes. Run `npm run build` first, then:
//
//   node scripts/make-sample.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trip = JSON.parse(readFileSync(join(root, "docs", "sample", "tokyo-in-december.trip.json"), "utf8"));
const folder = mkdtempSync(join(tmpdir(), "trip-agent-sample-"));

const client = new Client({ name: "make-sample", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], env: { ...process.env, TRIP_AGENT_DIR: folder } }));
const result = await client.callTool({ name: "export_trip", arguments: { trip } });
await client.close();
if (result.isError) {
  console.error(result.content[0].text);
  process.exit(1);
}
const file = readdirSync(folder).find((name) => name.endsWith(".ics"));
copyFileSync(join(folder, file), join(root, "docs", "sample", file));
console.log(`Wrote docs/sample/${file}`);
