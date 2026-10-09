# Trip Agent MCP

An MCP server that keeps a traveller's trip as structured data on their own computer, checks it for what is missing, and exports it as a calendar file.

## Language

**Trip**:
A journey with dates, a home city, travellers and a set of bookings and legs.
_Avoid_: Itinerary, plan

**Booking**:
A single reservation with a vendor and a confirmation reference. One booking can cover several legs, and it carries the cost.
_Avoid_: Reservation, order

**Leg**:
One segment of a trip: one flight number, or one stay. Movement legs and lodging legs are both legs.
_Avoid_: Segment, item, flight (a flight is one kind of leg)

**Traveller**:
A person going on a trip, listed by name on it. May or may not have an account.
_Avoid_: Passenger, guest

**Gap**:
Something a trip is missing, found by plain rules: an unbooked night, a broken location chain, a missing return.
_Avoid_: Warning, issue

**Idea**:
A leg the traveller is considering but has not decided on, such as a candidate restaurant. Shown dotted. It never counts as coverage or travel.
_Avoid_: Option, maybe

**Planned**:
A leg the traveller intends but has not booked. "Needs booking" is not a status; it is a planned leg with no booking.
_Avoid_: Needs booking, pending

**Manual edit**:
A change the traveller made by hand. It wins over anything imported.
_Avoid_: Override, correction

**Mailbox**:
The traveller's email account as seen by the app: somewhere to search and read messages, never to send or delete.
_Avoid_: Email source, inbox

**Import**:
A traveller-initiated run that reads the Mailbox and turns confirmation emails into bookings and legs.
_Avoid_: Sync, scan

**Source**:
A pointer from a stored fact back to one email: message id, thread id, sender domain and received date. Never the email's content. A booking built from several emails has one source per email.
_Avoid_: Attachment, copy, reference

**Calendar export**:
A file in the iCalendar (.ics) format that lists a trip's legs as calendar events, written by the trip tools into a folder the traveller chose, never one the model chose. The same leg always gets the same event identity, so importing the file again updates its events instead of duplicating them.
_Avoid_: Calendar sync, backup

