# Trip Agent MCP

An MCP server that checks a traveller's trip for what is missing and exports it as a calendar file on their own computer. The traveller's own Claude reads their email and assembles the trip; the server keeps no trips.

## Language

**Trip**:
A journey with dates, a home city, travellers and a set of bookings and legs.
_Avoid_: Itinerary, plan

**Booking**:
A single reservation with a vendor and, usually, a confirmation reference. A thing the traveller arranged themselves, such as a dinner, has no reference. One booking can cover several legs, and it carries the cost and any deadlines.
_Avoid_: Reservation, order

**Leg**:
One segment of a trip: a journey from one place to another by some mode, one stay, or one activity. Movement legs and lodging legs are both legs. A flight is a journey whose mode is flight.
_Avoid_: Segment, item

**Journey**:
The movement a travel leg makes from one place to another: a place, a local time and a time zone at each end, a mode, and sometimes a number such as a flight number.
_Avoid_: Trip (a trip is the whole thing), route

**Mode**:
How a journey moves the traveller: flight, train, ferry, bus, car, or other. A journey may carry a number that names it (a flight number, a train number) or none.
_Avoid_: Transport type, vehicle

**Traveller**:
A person going on a trip, listed by name on it.
_Avoid_: Passenger, guest

**Deadline**:
A date on a booking by which the traveller must act: free cancellation ends, or payment is due. Recorded only when the email states it.
_Avoid_: Reminder, cut-off

**Gap**:
Something a trip is missing, found by plain rules: an unbooked night, a broken location chain, a missing return. It appears on the calendar as a placeholder until it is fixed.
_Avoid_: Warning, issue

**Idea**:
A leg the traveller is considering but has not decided on, such as a candidate restaurant. It never counts as coverage or travel, and it is left out of the calendar export.
_Avoid_: Option, maybe

**Planned**:
A leg the traveller intends but has not booked, such as a hotel shuttle on offer. It appears on the calendar as tentative. "Needs booking" is not a status; it is a planned leg with no booking.
_Avoid_: Needs booking, pending

**Cancelled**:
A leg that was booked and no longer stands. It stays in the trip and is exported as a cancelled event with the same identity as the original, because importing a file never removes events that are merely missing from it.
_Avoid_: Deleted, removed

**Mailbox**:
The traveller's email account, read by their own Claude through the traveller's own email connector. This server never reads it.
_Avoid_: Email source, inbox

**Source**:
A pointer from a fact back to one email: message id, sender domain and received date, and the link to that one message when the mail connector supplies it. Never the email's content. It becomes the link on a calendar event.
_Avoid_: Attachment, copy, reference

**Calendar export**:
A file in the iCalendar (.ics) format that lists a trip's legs, deadlines and gaps as calendar events, written into a folder the traveller chose, never one the model chose. The same leg always gets the same event identity, so importing the file again updates its events instead of duplicating them.
_Avoid_: Calendar sync, backup

**Bookmark**:
The date of the latest email processed for a trip, recorded in its calendar export so the next run searches the Mailbox from there instead of from the beginning.
_Avoid_: Cursor, checkpoint, last sync
