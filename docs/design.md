# Design decisions so far

First agreed in a design interview on 2026-10-09 and revised on 2026-10-10, when the server became stateless ([ADR 0002](adr/0002-the-public-mcp-keeps-no-trips.md)). Words are defined in [CONTEXT.md](../CONTEXT.md).

## What it is

A local MCP server. The traveller's own Claude reads their mailbox through the traveller's own email connector, assembles the trip in the conversation and calls this server. The server checks the trip, and writes a calendar (`.ics`) file on the traveller's computer. It reads no email and keeps no trip store. The private application (Supabase) is a separate project and is not a dependency; code is written fresh here, and sharing code later is a separate decision.

## Settled

1. **Audience.** An individual traveller using any client that runs a local MCP server (Claude Desktop, Claude Code, Codex, Cursor and others). No account, no sign-in, no database. MIT licence.
2. **Scope of version 1.** Check a trip for gaps, export it as a calendar file, and ship it so a traveller can install it. No skill: the playbook lives in the server's instructions and in each tool's description, because clients differ in what they pass to the model.
3. **Four tools.**
   - `check_trip`: the three gap rules (unbooked night, broken location chain, missing return), each with plain-English wording for Claude to relay. The chain rule walks every journey and stay in time order: each must start where the previous one ended, so a journey by any mode can connect two places and a stay in the next city does not by itself explain how the traveller got there. It also reports recorded gaps that are now covered, and by which leg.
   - `export_trip`: validates the trip, writes the `.ics`, returns the path.
   - `get_trip_file_info`: whether a trip's file exists, its bookmark and last export time.
   - `open_trip_file`: opens the exported file in the default calendar app, and returns the path instead of failing where no app exists.
4. **Input.** Structured legs only, in three kinds: travel (a journey by flight, train, ferry, bus, car or other, with a place, a local time and a named time zone at each end, and an optional number such as a flight or train number), stay (check-in to check-out) and activity (a named time zone, required). The trip carries a home city. Bookings carry their deadlines when the email states them.
5. **Privacy guard.** The export rejects, with a message Claude can act on, card, passport, e-ticket and loyalty numbers in any free-text field, and notes over a length cap. The server masks a booking code down to its last two characters and never writes the full code; a booking's own code written in full anywhere else in the booking (a note, a name, a location) is rejected too. The guard reads card numbers written with spaces, line breaks, dots or dashes between the groups, and a set of common e-ticket, loyalty and passport wordings, but it is pattern-based and cannot catch everything.
6. **Event identity.** A fingerprint of the booking reference plus the mode and number of a journey (or where it goes, when it has no number), or the property of a stay, leaving out dates and times, so an amended booking updates its event. Each fact is tidied before it is hashed (references and flight numbers keep only letters and digits, names ignore case and spacing), because Claude re-reads the emails each time and may write the same fact slightly differently. Legs without a reference use type, name and original date.
7. **Re-exports.** A cancelled leg is exported as a cancelled event, and so is a fixed gap, because importing a file never removes events. Claude shows the traveller the assembled trip, the gaps and any gaps now cleared, and the traveller confirms before every export. Ideas are never exported, and a trip whose legs are all ideas writes no file and says so, leaving any earlier export untouched.
8. **The file.** One `.ics` per trip, named by the server from the trip name and start date. Writes go to a temporary file and are renamed over the old one, keeping one `.bak`. The file carries a versioned bookmark (the date of the latest email processed) and the ids of the gap events last exported. This is the only memory the server has.
9. **Where files go.** `Documents/trip-agent/` in the home folder, created if missing, changed by an extension setting or the `TRIP_AGENT_DIR` environment variable. Tools take a trip name and date, never a path. If the folder cannot be written, the tool says so.
10. **Event content.** A plain title with the kind first, a location, a description with notes, the masked booking code (or "no booking reference" for something arranged by the traveller) and "approximate" flags where a time was assumed, and the email link as the event's link: the link to the one message that the mail connector supplies, passed through as given after checking it is a plain https address. Where the connector gives none, a Gmail search link is built from the message id, sender domain and date, which only works for Gmail. No traveller names, costs or alarms, and English only.
11. **Extra events.**
    - Included breakfast: a confirmed event each morning, about 8 to 10am, in the hotel's time zone.
    - Hotel shuttle (planned, tentative): 45 minutes ending when airport check-in opens, or 45 minutes after landing. It is made only when a flight (a travel leg with mode flight) matches the day.
    - Airport check-in block: 3 hours before an international departure, 2 hours before a domestic one, tentative. Claude flags each flight international or domestic. Check-in blocks, shuttles and that flag apply to the flight mode only.
    - Deadlines: cancellation and payment dates, only when stated outright.
    - Gaps: placeholders until fixed.
12. **Searching the mailbox.** Claude searches from the bookmark, going back a few days, and widens only when the traveller names an email it cannot find. On a first run it searches for the trip. The server cannot enforce this; it is guidance. A missing email connector cannot be detected by the server either, so the instructions tell Claude to check for one and, if there is none, say what is needed and offer pasting the emails instead.
13. **Install.** A `.mcpb` extension file on each GitHub release for Claude Desktop, and an npm package, `trip-agent-mcp`, for everything else. It must run on the traveller's own computer.
14. **Testing.** One seam: the tool interface. Sample trips go in, and the results and known-good `.ics` files are checked. A manual test imports the file into a real calendar app twice and looks for duplicates.
15. **Reminders about deadlines** are gentle guidance in the instructions, not a rule or a tool.

## To verify early

- Calendar apps ignore the custom bookmark property, honour cancelled events and match events by id when a file is imported again.
- Claude Desktop can write to `Documents` without extra permission, including with a redirected Documents folder.
- The traveller's mail connector offers a date filter and a message link.
- The install commands for each client.

## Not in version 1

Edits that last across conversations, a calendar connector that updates events directly, a hosted server, a deadline-warning tool, and train, ferry and car-hire leg kinds.
