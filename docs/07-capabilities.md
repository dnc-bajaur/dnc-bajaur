# Capabilities — what the system includes

Plain-language capability list, written for the people who will use and approve the
system rather than for engineers. This is the scope document: if something is not here or
in `backlog/milestones.md`, it is not in scope.

**Published version (for sharing):** https://claude.ai/code/artifact/3c83fe83-eee2-46c4-b85a-7daacdb3768a

---

## In one paragraph

One system for running Bajaur district. Any emergency — reported by anyone, from anywhere,
on any kind of phone, even with no internet — enters the system, reaches the officer
actually on duty in the responsible department, appears on the DC's screen, and stays
visible until acknowledged, responded to and closed. Every step is permanently recorded.

Each department gets its own workspace for its own incidents, staff, vehicles and
resources. The district administration sees everything and can step in where it has
authority, with the reason recorded every time.

**Owned and run by the district, independent of government-issued software** (see
`06-open-questions.md`, Q-01).

---

## One emergency, from start to finish

The system in a single read. Everything else supports these nine steps.

1. **Someone reports it** — app in under 15 seconds, or a call entered by the control room,
   or an SMS. All land in the same place.
2. **Saved immediately, even with no signal** — held on the device, sent when signal
   returns, clearly marked as not yet sent.
3. **Duplicate reports joined** — five reports of one accident become one incident, and the
   count of reporters is itself a severity signal.
4. **Routed to the right department and the right person** — to whoever is on duty now, not
   a general inbox. Failed alerts are shown, never hidden.
5. **The duty officer accepts it** — one tap on the link in their own WhatsApp, or a reply, or
   the control room ringing them and recording what they said. The clock has been running since
   the report. **The three are counted separately and never added together**, because a tap the
   system saw and an operator's account of a telephone call are not the same kind of evidence.
   That same link then carries them through the rest: **Acknowledged → Responded → Resolved**,
   all without signing in, all on one approved WhatsApp button.
6. **If nobody responds, it escalates automatically** — on the server, so it works even with
   every device switched off.
7. **The response is carried out and recorded** — teams, vehicles, actions, evidence.
8. **The district administration can step in** — raise severity, reassign, escalate. Reason
   required. The department's original entry survives alongside.
9. **Closed, with a permanent record** — the full history is reconstructable months later
   and cannot be quietly edited.

---

## The thirteen capability groups

### 1. Reporting an emergency
Rapid report (3 fields, under 15 seconds) · any channel: app, control room, SMS, radio,
walk-in · works with no internet · layered location capture (map pin, landmark,
tehsil→UC→village, or free text) · photos and voice notes · **nothing is ever refused** ·
duplicate reports linked into one incident.

### 2. Getting it to the right people
Automatic routing by type and location · sent to the duty holder, not a mailbox ·
multiple departments on one incident without duplicating it · alerts by app, SMS,
WhatsApp, email, voice · delivery tracked · **failed alerts become visible tasks** ·
one-tap call and WhatsApp from inside the incident · **tell a whole department at once**,
which collapses to one row rather than forty ticks · the picker **counts who cannot be
reached** and lets an administrator add a missing officer or department **from the screen where
the gap is discovered**, mid-call, rather than four navigations away.

### 3. Response deadlines and escalation
Deadlines set per severity and department · visible countdown · automatic escalation
senior → control room → provincial · **runs server-side, works with all devices off** ·
escalation reason recorded · vacant-post fallback escalates upward rather than dropping.

### 4. Carrying out the response
One-tap acknowledge · assign teams, vehicles, resources · log each action as it happens ·
attach evidence · record resolution and close · reopen with reason, history intact ·
**four plain stages instead of seven statuses** — Issued, Acknowledged, Responded, Resolved ·
the whole lifecycle driven from the officer's own WhatsApp **without an account**, each link
single-use and bound to one officer · **"where are you?"** answered the same way — present,
in the office, in the field, absent, on leave, with an end time required for the three that
need one.

### 5. The District Dashboard
Every active emergency across all departments on one screen · sorted by what needs
attention · map view with hospitals, police stations, rescue posts · department-by-
department status · **"not heard from" warnings instead of false green** · district brief ·
every figure shows its age · live updates without refresh, pushed rather than polled ·
**the last 24 hours of activity**, advisories and emergency updates in one ordering, twenty at
a time, saying in words how many are held back · weather · Pakistan headlines, **labelled with
their source and carrying two ages** — the story's and the fetch's — because nothing on that
panel is the district's own information · the panels themselves are **configuration**, so the
district composes its own screen (ADR-0015).

### 6. Department workspaces
One per department · their own incidents, alerts, staff, teams, vehicles, equipment,
duty roster, reports · departments see only their own data unless an emergency is shared ·
**configurable per department without changing the software**.

### 7. District control and accountability
Full visibility across departments · authorised corrections (severity, reassignment,
escalation, closure) · **reason required every time** · department's original entry
survives and is shown alongside · affected department notified immediately · complete
per-incident history · history cannot be edited or deleted · emergency powers available to
the DC, flagged prominently and reviewed afterwards.

**Correcting something already sent.** A separate act, and the honest one. *"Correct this"*
records what was wrong and, optionally, what is true — and says **before** anything is recorded,
and again afterwards, that **it does not unsend the message, and nothing can. Tell them again or
ring them.** Correctable after closure, because that is when mistakes are noticed, and
correctable twice. Nothing is struck through: a crossed-out line reads as *this did not happen*,
and it did. There is no delete and no undo anywhere in this system, and there never will be.

### 8. Officers, posts and duty rosters
**Built around posts, not people** — transfers handled automatically, departing officers
lose access the same day · formal handover with explicit acceptance of open matters ·
duty roster and shifts · contact directory per post · permissions by role · new department
added through settings in hours.

### 9. Reports and records
Post-incident report generated from the incident's own history · response time reports ·
department performance · district summaries for any period · **export in the formats
departments already submit upward** — work done once, not twice · full-history search ·
printable and spreadsheet output.

**The daily report** — one named district day on one page: emergencies, communications,
advisories issued, and where officers said they were, with the four stages, timestamps, actors
and notification outcomes. Opens to be read and printed; downloads as CSV to be filed. **A gap
is stated on the row it belongs to and never omitted**, the summary leads with what is wrong,
and an empty day says so rather than showing an empty table. Advisories are the ones *issued*
that day — otherwise yesterday's report would change every time somebody read it.

### 10. Working when the network does not
Five defined levels, from full connectivity to total blackout — see
`02-connectivity-ladder.md`. Full · slow · device offline (saves locally, marks pending) ·
district internet down (SMS and voice into the same system) · complete shutdown (printed
forms matching the screens, entered afterwards, timeline rebuilt with correct original
times). **No alert flood on recovery. Honest timings** — a two-hour delay is recorded as
two hours, not disguised as an instant response.

### 11. Language and ease of use
Urdu, Pashto, English, with proper right-to-left layout · works on inexpensive Android
phones · installs like an app but updates instantly, no app store delay · built for stress
(large buttons, few fields) · critical alerts do not rely on colour alone · designed for
control room screens as well as phones · written guides per department.

### 12. Security, privacy and safekeeping
Citizen contact details restricted and excluded from general exports · departments cannot
see each other's data · **security enforced server-side, not by hiding buttons** · every
sensitive action recorded · hosted in Pakistan with on-premise option · automatic backups
with a genuinely tested restore · second control room location · independent security
review before go-live.

### 13. The district's other traffic — not everything sent is an emergency
Meetings, schedules, notices and orders go out through the same directory, the same delivery
record and the same permanent log — **and are never dressed as emergencies.** A communication
has no acknowledgement clock and no escalation ladder; it shows **what it is** where a severity
would be, and says *sent · no answer needed* or *answered* rather than *unacknowledged*. On a
control-room screen at a glance, the old behaviour read as an emergency nobody had answered.

**Attaching a file** · one link per recipient, openable twice, by an officer with no account.
It **travels as a link, not as a file** — Meta will only put a document on a template approved
to carry one, and Bajaur's is not. The guide says so in those words, so nobody waits for an
attachment that is not coming.

---

## Deliberately not included

Stated openly. Each is a decision, not an oversight.

| Not included | Why |
|---|---|
| Connection to government-issued systems | Owner's decision — the district runs independently. Report **export** still provided, so upward reporting is not double work |
| Public citizen reporting app, v1 | Large decision with real implications; revisit after the system is proven (Q-13) |
| AI making decisions | May later help summarise; will never route, close, or state something as fact. A confident wrong answer on an emergency board is worse than none |
| Replacement for radio and phone in a total blackout | The system's job is to prepare for its own absence and rebuild the record afterwards |
| Advanced trend analytics at launch | Needs real history. Charts on invented data mislead |
| Routine non-emergency department work | Revenue, agriculture, education reporting — real, but after the emergency spine is proven |

---

## The test

Not how many screens it has. Whether an emergency reported from a village with no signal,
at night, still reaches the right officer and stays visible until somebody closes it.
