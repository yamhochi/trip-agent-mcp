# Design decisions so far

Agreed in a design interview on 2026-10-09. Open branches are at the end.

## Settled

1. **Audience and promise.** An individual traveller using Claude Desktop. No Supabase, no sign-in: the server reads and writes a local file and exports a calendar file.
2. **Scope.** The public repository is the MCP server and the code it needs. The web app is not part of it; whether it is ever public is a separate decision.
3. **One store in the public product.** A local file, behind the same trip store interface the private application's Supabase store implements, proven by the same contract tests. No Supabase code in this repository.
4. **Repository shape.** This repository owns `core`, the file store and the MCP server (ADR 0001). The private repository consumes it from npm.
5. **Licence and name.** MIT. Working name `trip-agent-mcp`, to be checked on npm before the first publish.
6. **No skill in version 1.** The email-reading playbook stays in the server's instructions and prompts, which work in any client.
7. **Version 1.** The local file store, the calendar export, and the work to publish. Updating a calendar through a calendar connector comes later, designed after seeing how real calendar apps treat a re-imported file.
8. **The server keeps trips.** A calendar export is an export of the local trip file. Keeping trips is what makes gaps, "manual edits win", refresh after an amendment and history possible.
9. **Where the export goes.** A default folder (`~/Documents/trip-agent/`), changeable with an environment variable in the MCP configuration. The export tool takes a filename only, never a path, so the model cannot choose where a file is written. One `.ics` file per trip, overwritten on each export, with the path in the tool's reply.
10. **What is in the export.** Legs only. Flights at their real departure and arrival times in their own time zones; stays as all-day events from check-in to check-out; activities and dinners at their times. No markers in the first version. Cancelled legs and ideas are left out. Notes go in the description; booking references, and anything the privacy guard blocks, never do. Each leg keeps one event identity for life so a re-import updates it.

## Still to decide

- What must be scrubbed before code is copied in: a fresh history, and the real December trip fixture replaced by the sample trip.
- How the local trip file is protected from corruption (atomic writes, a schema version, what happens when two Claude sessions write at once).
- How the private application is developed against the public package without a publish for every change.
- How it is published: npm, and a packaged Desktop extension for one-click install.
- Calendar updates through a calendar connector: the server works out what changed since last time and Claude applies it.
