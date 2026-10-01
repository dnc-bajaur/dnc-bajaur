# ADR-0011 — One record, two offices, and an off-site copy

**Status:** Accepted · 2026-08-02
**Resolves:** P-08. Constrains `ADR-0002` (offline-first) and `M0-37` (backup scheduling).
**Source:** project owner, 2026-08-02.

## Context

`P-08` asked where the application actually runs. It had been carried as "a deployment-time
fork, built so either works", and it stopped being deferrable once the backup system existed
with nothing to schedule it.

The owner's answer:

> It will run on systems in the **DC and AC Headquarter offices**, with **Google Cloud
> connected** so data auto-uploads regularly or weekly. If a rented database is necessary we
> can discuss it.

And, separately and emphatically:

> **Offline does not mean that it stops working for someone who has no internet.**

That last sentence is the design constraint, not a footnote. It rules out the answer most
systems give by default.

## Decision

### 1. The district owns the data, on district hardware

PostgreSQL runs on a machine in the **DC office**. The district's emergency record lives on a
disk inside a district building, under district control. Not on a rented database.

**A rented database is rejected**, and for one reason: it inverts the failure mode. With
Postgres in the DC office, an internet outage costs the district its field reports until the
line returns — the control room keeps working. With a rented database, an internet outage
costs the district **everything, including its own control room**, during exactly the kind of
event that takes internet lines down. Cloudflare in particular does not offer managed
Postgres at all (D1 is SQLite; Hyperdrive is a connection pooler), so it is not the shape of
thing this needs even setting the argument aside.

### 2. One primary, one standby — not two systems

"Systems in the DC and AC Headquarter offices" is read as **two machines, one record**:

- **DC office — primary.** Serves every request. Holds the authoritative event log.
- **AC Headquarter office — warm standby.** A streaming replica of the primary. Read-only in
  normal operation. Promoted by hand if the DC machine or building is lost.

**Two independent primaries is rejected as unsafe.** Two offices each accepting writes into
their own database produces two divergent records of the same district, and event-sourcing
does not rescue that — it gives you two append-only logs, both authoritative, both correct by
their own lights, and no principled way to merge them. There would be no answer to "what
happened in Bajaur on Tuesday". One record, or none.

The standby costs almost nothing to run and covers the failure that actually worries us: the
DC machine dies at 02:00 on a bad night. It requires a network link between the two offices.

### 3. Reachable from outside, because offline must not mean unusable

The server is reachable from the public internet — static IP, or a VPN, or a tunnel. This is
what makes the owner's constraint true:

- An officer **with no internet** captures the emergency on their handset. It is stored
  durably on the device and delivers itself when a network appears. Already built (ADR-0002),
  already proven end to end.
- An officer **with internet, anywhere in the district**, reaches the server directly.
- If **district internet fails**, the control room, the DC office and everyone on the local
  network keep operating against the primary. Field reports queue on handsets.

The system therefore has no state in which nobody can work. That is the whole point.

### 4. Off-site copies go to Google Cloud — **nightly, not weekly**

The verified dump from `M0-37` uploads to Google Cloud Storage after each successful backup.

**Weekly is rejected.** A weekly cadence means that on a bad day the district loses up to
seven days of emergency record — every incident, every acknowledgement, every closure. The
cost of nightly over weekly is a few hundred megabytes of transfer. There is no trade here.

The two copies cover different failures, and both are needed:

| Failure | Covered by |
|---|---|
| Disk or machine dies in the DC office | AC Headquarter standby — seconds of loss |
| Bad data, wrong restore, corruption | Local dump ledger — restore to a point in time |
| Fire, flood, theft, the building itself | Google Cloud copy — up to 24 hours of loss |

A backup on the same disk as the database is not a backup. A backup in the same building is
not much better.

## Consequences

**Good**

- The district's data never leaves the district except as an encrypted backup.
- No single machine failure and no single building failure loses the record.
- The offline story is honest: a handset with no signal works, and a district with no
  internet still has its control room.

**Costs, accepted**

- Power, hardware and the UPS are the district's responsibility. This is why the runbook and
  the restore drill (M0-38) exist and are not optional.
- The standby needs a link between the two offices, and it needs someone to notice it has
  stopped replicating. `/health` must report replication lag, or the standby is a comforting
  fiction rather than a standby.
- A Google Cloud Storage bucket and a service account are now a real prerequisite with a real
  cost, small as it is.
- **Backups leave the district.** They must be encrypted before upload, and the bucket must
  not be public. A dump contains every reporter's phone number in the district.

**Follow-up work this creates**

- `M0-53` — schedule the nightly backup and upload it to GCS, encrypted.
- `M0-54` — streaming replication to the AC Headquarter standby, with lag on `/health`.
- The scheduling half of `M0-37` is unblocked. It was the only thing P-08 was holding.
