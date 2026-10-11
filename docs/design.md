# Design decisions so far

First agreed in a design interview on 2026-10-09 and revised on 2026-10-10, when the server became stateless ([ADR 0002](adr/0002-the-public-mcp-keeps-no-trips.md)). Words are defined in [CONTEXT.md](../CONTEXT.md).

## What it is

A local MCP server. The traveller's own Claude reads their mailbox through the traveller's own email connector, assembles the trip in the conversation and calls this server. The server checks the trip, and writes a calendar (`.ics`) file on the traveller's computer. It reads no email and keeps no trip store. The private application (Supabase) is a separate project and is not a dependency; code is written fresh here, and sharing code later is a separate decision.

## Settled

1. **Audience.** An individual traveller using any client that runs a local MCP server (Claude Desktop, Claude Code, Codex, Cursor and others). No account, no sign-in, no database. MIT licence.
2. **Scope of version 1.** Check a trip for gaps, export it as a calendar file, and ship it so a traveller can install it. No skill: the playbook lives in the server's instructions and in each tool's description, because clients differ in what they pass to the model.
3. **Four tools.**
   - `check_trip`: the three gap rules (unbooked night, broken location chain, missing return), each with plain-English wording for Claude to relay. The chain rule walks every journey and stay in the order they really happen (time zones respected, so a flight across the date line sorts correctly): each must start where the previous one ended, so a journey by any mode can connect two places and a stay in the next city does not by itself explain how the traveller got there. It also reports recorded gaps that are now covered, and by which leg.
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
    - Included breakfast: an event for each morning after a night of the stay, 8 to 10am in the property's time zone, with the stay's own status (so a cancelled stay cancels them) and an "approximate" note. Only when the booking says breakfast is included (`breakfastIncluded`, left out when it is merely available); the stay then must carry its IANA `timeZone`, which Claude works out from the location or asks the traveller for.
    - Hotel shuttle (planned, tentative): 45 minutes ending when airport check-in opens, or 45 minutes after landing. It is made only when a flight (a travel leg with mode flight) matches the day and the stay is in the same area as the airport, and only when the stay's booking says free airport transit is included (`airportTransit`, left out unless the booking says so).
    - Airport check-in block: 3 hours before an international departure, 2 hours before a domestic one, tentative. Claude flags each flight international or domestic; the flag is required on every flight, and Claude asks the traveller when unsure. Check-in blocks, shuttles and that flag apply to the flight mode only.
    - Deadlines: a booking may carry `deadlines` with a cancellation date (`cancellationBy`) and a payment date (`paymentDueBy`), only when the email states the date outright. Each makes an all-day event on that date, titled with the booking's first leg, telling the traveller to check the booking. Its id comes from the booking and the kind, never the date, so moving the date updates the same event. Every leg of the booking cancelled cancels them; a booking of only ideas makes none.
    - Gaps: placeholders until fixed.
12. **Searching the mailbox.** Claude searches from the bookmark, going back a few days, and widens only when the traveller names an email it cannot find. On a first run it searches for the trip. The server cannot enforce this; it is guidance. A missing email connector cannot be detected by the server either, so the instructions tell Claude to check for one and, if there is none, say what is needed and offer pasting the emails instead.
13. **Install.** A `.mcpb` extension file on each GitHub release for Claude Desktop, and an npm package, `trip-agent-mcp`, for everything else. It must run on the traveller's own computer.
14. **Testing.** One seam: the tool interface. Sample trips go in, and the results and known-good `.ics` files are checked. A manual test imports the file into a real calendar app twice and looks for duplicates.
15. **Reminders about deadlines** are gentle guidance in the instructions, not a rule or a tool.

## Verified

- **Writing to `Documents` on macOS (checked 2026-10-11, issue #7).** Claude Desktop launched the server (node 24 via nvm, through Claude's `disclaimer` helper) and `export_trip` created `~/Documents/trip-agent/` and wrote the `.ics` with no macOS prompt and no error, even with Documents switched off for that `node` in Privacy & Security → Files & Folders. One machine and one Node install: macOS did not enforce the denial and we do not know why (the Node setup on that machine may have been unusual), so a fresh machine could behave differently. Not checked: a Documents folder redirected to iCloud (none available), and Windows including OneDrive.
- **Side effects seen on the same machine.** Resetting the Documents permission (`tccutil reset SystemPolicyDocumentsFolder`) made other apps ask again, and a denied `node` made a different MCP server time out and disconnect, with no clear error.
- **The Gmail connector (checked 2026-10-11, issue #7).** One connector, Gmail in Claude Desktop; Outlook and others not checked.
  - *Date filter:* works, with a start date and an end date. The results matched the dates.
  - *Message link:* the connector's fetch-message tool takes the message id and returns a view link that opens that one message directly, not a search. The link contains a `|` (`...#all/thread-f:<id>|msg-f:<id>`) and an `authuser=<email address>` parameter. The link check in `src/schema.ts` rejects `|`, so a real Gmail link is refused today, and the address would be written into the file; both are tracked in #38. Whether the `%7C`-encoded form still opens the same message, and whether the fallback `rfc822msgid:` search finds a message from Gmail's `msg-f:` id, are untested.
  - *No connector:* with Gmail connected but switched off for the chat, Claude said it could not read the mailbox, said what was needed, did not invent a trip, and offered to work from pasted booking details, as item 12 expects. A connector that was never installed was not tried.

## To verify early

- Calendar apps ignore the custom bookmark property, honour cancelled events and match events by id when a file is imported again.
- Claude Desktop can write to `Documents` without extra permission on Windows, and with a redirected Documents folder (iCloud, OneDrive). Checked on macOS only; see **Verified**.
- The install commands for each client.

## Not in version 1

Edits that last across conversations, a calendar connector that updates events directly, a hosted server, a deadline-warning tool, and train, ferry and car-hire leg kinds.
