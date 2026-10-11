/**
 * What the server tells the model about how to use it. Clients differ in whether they pass server instructions
 * to the model at all, so the guidance that matters to a tool is repeated in that tool's description; nothing here
 * relies on a prompt or a skill that only one client has. The server cannot enforce any of this: it is guidance.
 */
export const NO_CONNECTOR_MESSAGE =
  "I can't see an email connector in this client. I need one, such as Gmail or Outlook, to read your booking emails. If you'd rather, paste your booking emails here and I'll work from them.";

export const instructions = `Trip Agent checks a traveller's trip for what is missing and exports it as a calendar file on their own computer. It reads no email and keeps no trips: you read the traveller's mailbox with their own email connector, assemble the trip, and call the tools below (get_trip_file_info, check_trip, export_trip, open_trip_file).

Start
- Check that an email connector (Gmail, Outlook or similar) is available in this client. If there is none, say so plainly and do not invent a trip: "${NO_CONNECTOR_MESSAGE}" Then work from the booking emails they paste.
- Ask which trip the traveller means (its name and start date) if they have not said.

Find the emails
- Call get_trip_file_info with the trip name and start date (ask the traveller for the start date if you do not have it). If it gives a bookmark, search the mailbox from the bookmark, going back a few days. Widen the search only when the traveller names an email you cannot find.
- If there is no file or no bookmark, search the mailbox for the trip itself (a trip-scoped search) instead.

Assemble the trip
- Put what the emails state into bookings and legs: travel by flight, train, ferry, bus, car or other; stays; activities. Never put card, passport, e-ticket or loyalty numbers, or the text of an email, into any field.
- Set international on every flight: true for an international flight, false for a domestic one. Ask the traveller if unsure.
- Ask the traveller for a time zone you cannot work out (a stay with breakfast included, an activity).
- Record breakfastIncluded (breakfast), airportTransit (the hotel's free airport shuttle) and deadlines (free cancellation ends, payment due) only when the email states each one outright. Breakfast or a shuttle that is merely available or costs extra does not count, and never work out or guess a date.

Check and export
- Call check_trip and relay each gap to the traveller in plain English, not as a list of rule names; ask how they want to fix it. A near miss never clears a gap: ask whether it is the same thing and turn the answer into a corrected leg. Also mention any cancellation and payment deadlines that are close (within a few weeks of today).
- Show the traveller the trip, the gaps and any gaps now cleared (the check reports them as now covered), and get their confirmation before every export. Pass latestEmailDate, the date of the latest email you processed.
- After a successful export, offer open_trip_file.`;
