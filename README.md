# trip-agent-mcp

An MCP server that checks a traveller's trip for what is missing and exports it as a calendar file on their own computer.

**Status: working, not yet published.** The server checks a trip and exports it as a calendar file; the npm package builds and installs from its tarball, but nothing is on npm yet, so the commands below start working at the first release. The decisions so far are in [docs/design.md](docs/design.md) and [docs/adr/](docs/adr/); the words the project uses are in [CONTEXT.md](CONTEXT.md).

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

> Nothing is published yet, so `npx -y trip-agent-mcp` works from the first release. The package itself is checked: it installs from its tarball on a clean project and starts over standard input and output. The `claude mcp add` and `codex mcp add` lines below have not yet been run against each client; the end-to-end check (#22) does that. Confirm them against the client's documentation if one fails.

**Claude Desktop (macOS and Windows).** Download `trip-agent-mcp-<version>.mcpb` from the latest [release](https://github.com/yamhochi/trip-agent-mcp/releases) and open it (double-click it, or drag it into Claude Desktop). Claude Desktop shows an install dialog:

- **Export folder** (optional) is where the calendar files go. Leave it blank to use `Documents/trip-agent` in your home folder, or pick a folder.
- Nothing else needs setting up. Node.js comes with Claude Desktop, so you do not need to install it.

There is no release yet, so to try the extension now build it yourself: `npm install && npm run build:mcpb` writes `build/trip-agent-mcp-<version>.mcpb`. It has been checked by unpacking it and starting the server the way the format describes; it has not yet been opened in Claude Desktop itself (that is part of #22).

**Claude Code.**

```bash
claude mcp add trip-agent -- npx -y trip-agent-mcp
```

**Codex.**

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

**Before the first release.** To try it from a clone, build it and point your client at the built file instead of npx:

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
