# The public MCP keeps no trips: it checks and exports what Claude gives it

The first design had the server keep a trip in a local file, so it could hold manual edits and refresh after an amendment. We decided against that. The traveller's own Claude reads their mailbox through the traveller's own email connector and assembles the trip in the conversation. The server checks that trip for gaps and writes it as a calendar file on the traveller's computer. It keeps no trip store and reads no email. The only thing it remembers is inside the `.ics` it wrote: a bookmark (the date of the latest email processed) and the ids of the gap events it last exported.

This partly supersedes ADR 0001. The no-database and own-repository decisions stand. The local trip file, the shared-code ownership and the private application depending on the published package do not: the private application (Supabase, its own transformation) carries on independently, and the two codebases are written separately. Sharing code later is a separate decision.

## Considered options

- **A local trip file** (ADR 0001). It would keep manual edits across conversations, but it means a store, schema migrations and write-safety for a first release whose job is to prove one route: email, to schema, to calendar file. Rejected for now; the `.ics` can be made to carry the trip later if cross-conversation edits matter in real use.
- **A hosted server.** It works on phones and needs nothing installed, but the traveller's trips would pass through a server we run, and the file would not land on their own computer. Rejected for version 1.

## Consequences

- A manual edit ("dinner at 8pm") lasts only for the conversation it was made in. A new conversation rebuilds the trip from email, starting at the bookmark.
- Event identity cannot be looked up, so it is derived from facts that do not change (the booking reference plus the mode and number of a journey, or the property of a stay), never from times or dates.
- Anything missing from a re-export, such as a cancelled leg or a gap that has since been fixed, has to be written out as a cancelled event, because importing a file never removes events. Fixed gaps are known only from the ids recorded in the file.
- The server must run on the traveller's own computer, because that is where the file is written.
