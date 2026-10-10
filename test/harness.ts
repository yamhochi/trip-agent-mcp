import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverEntry = join(import.meta.dirname, "..", "dist", "index.js");

export function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "trip-agent-test-"));
}

/** Start the server over stdio the way an MCP client would. */
export async function startServer(env: Record<string, string> = {}, home = makeHome()) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...env },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, home, close: () => client.close() };
}

export function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((c) => c.text ?? "").join("\n");
}
