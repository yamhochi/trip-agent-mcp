# trip-agent-mcp

An MCP server that checks a traveller's trip for what is missing and exports it as a calendar file on their own computer.

**Status: early software.** It is on [npm](https://www.npmjs.com/package/trip-agent-mcp), and on the [releases page](https://github.com/yamhochi/trip-agent-mcp/releases) as an extension file for Claude Desktop, which also shows the latest version. Its maintainer has tried it on one real trip, in Claude Desktop, Claude Code and Cursor. The decisions so far are in the [design notes](https://github.com/yamhochi/trip-agent-mcp/blob/main/docs/design.md) and the [decision records](https://github.com/yamhochi/trip-agent-mcp/tree/main/docs/adr); the words the project uses are in the [glossary](https://github.com/yamhochi/trip-agent-mcp/blob/main/CONTEXT.md).

## What it does

- Your own Claude reads your booking emails with your own email connector and assembles the trip. This server never reads email and keeps no database.
- It finds gaps by plain rules, not by asking a model: a night with nowhere to stay, a journey that does not connect, a missing return. Gaps show up on your calendar as placeholders until you fix them.
- It exports the trip as an `.ics` file in a folder on your computer, with stable event identities so importing it again updates events instead of duplicating them. It also adds included breakfasts, hotel shuttles, airport check-in blocks, and free-cancellation and payment deadlines when your emails state them.
- It never writes passport, card, e-ticket or loyalty numbers, or the text of an email. This is enforced in code, and booking codes are shortened to their last two characters.

## What you need

- A client that can run a local MCP server (see below).
- **An email connector in that client**, such as Gmail or Outlook if your client offers one. This server cannot read your mail itself. If Claude finds there is no connector, it will tell you, and you can paste your booking emails into the chat instead.
- The server must run on **your own computer**, because it writes the calendar file there. On a remote machine, container or SSH session the file lands on that machine.
- Node.js (current LTS) for the npm route.

## Install

> Checked on 11 October 2026 with version 0.1.0: the Claude Desktop extension, the `claude mcp add` line in Claude Code, and the config entry in Cursor all install and start. The `codex mcp add` line has **not** been tried. If a line fails for you, check it against your client's documentation and [open an issue](https://github.com/yamhochi/trip-agent-mcp/issues).

**Claude Desktop (macOS and Windows).** Download `trip-agent-mcp-<version>.mcpb` from the latest [release](https://github.com/yamhochi/trip-agent-mcp/releases) and open it (double-click it, or drag it into Claude Desktop). Claude Desktop shows an install dialog:

- **Export folder** (optional) is where the calendar files go. Leave it blank to use `Documents/trip-agent` in your home folder, or pick a folder.
- Nothing else needs setting up. Claude Desktop runs the extension with its own copy of Node.js, so you do not install it yourself.

To build the extension yourself instead: `npm install && npm run build:mcpb` writes `build/trip-agent-mcp-<version>.mcpb`.

**Claude Code.**

```bash
claude mcp add trip-agent -- npx -y trip-agent-mcp
```

**Codex** (not yet tried).

```bash
codex mcp add trip-agent -- npx -y trip-agent-mcp
```

**Cursor, and any other client that reads an MCP config file.** Add this to the client's MCP settings:

```json
{
  "mcpServers": {
    "trip-agent": {
      "command": "npx",
      "args": ["-y", "trip-agent-mcp"]
    }
  }
}
```

**From a clone.** To try the code before it is released, build it and point your client at the built file instead of npx:

```bash
npm install && npm run build
claude mcp add trip-agent -- node /full/path/to/trip-agent-mcp/dist/index.js
```

Or build a tarball with `npm pack` and run `npx -y ./trip-agent-mcp-<version>.tgz`.

**Where the files go.** `Documents/trip-agent/` in your home folder, created if it is missing. Change it with the extension's setting, or by setting the `TRIP_AGENT_DIR` environment variable for the server.

**Opening the file.** The server can hand the exported file to your default calendar app. Importing it is still your step, and your calendar app decides whether an updated event replaces the old one. Where no calendar app is available, the tool returns the file's path.

## What it will not be

- Not a hosted service, and not a phone app: phones cannot run local MCP servers.
- Not tied to any database. A private companion app uses Supabase; that is outside this repository and does not depend on this one.
- Not a live calendar connection. In version 1 you import the file yourself.

## Licence

MIT.
