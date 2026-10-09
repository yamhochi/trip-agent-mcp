# trip-agent-mcp

An MCP server that keeps a traveller's trip as structured data on their own computer, checks it for what is missing, and exports it as a calendar file.

**Status: design stage.** There is no code here yet. The decisions so far are in [docs/design.md](docs/design.md) and [docs/adr/](docs/adr/); the words the project uses are in [CONTEXT.md](CONTEXT.md).

## What it will be

- Runs on your desktop inside Claude Desktop (a local, stdio MCP server). No account, no sign-in, no database to set up.
- Claude reads your booking emails with its own email connector; this server never reads email. It stores the result (flights, stays, activities) in a local file.
- Finds gaps by plain rules, not by asking a model: a night with nowhere to stay, a journey that does not connect, a missing return.
- Your manual edits always win over anything imported.
- Exports a trip as an `.ics` calendar file, into a folder you choose, with stable event identities so importing it again updates events instead of duplicating them.
- Never stores passport, card, e-ticket or loyalty numbers, or the text of an email. This is enforced in code.

## What it will not be

- Not a hosted service, and not a phone app: phones cannot run local MCP servers.
- Not tied to any database. (A private companion app uses Supabase; that is outside this repository.)

## Licence

MIT.
