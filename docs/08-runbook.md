# Runbook

Written for the person on the other end of the phone at 02:00, who did not build this.

If you are reading this during an incident, the only section you need is
[**Restore from backup**](#restore-from-backup). Start there.

---

## Restore from backup

**The drill (M0-38) is not complete until somebody who did not write this system has
performed it, end to end, timed, and written down what actually happened.** A restore
procedure that has only ever been run by its author is not a backup strategy — it is a
document. That is why this section exists and why the gate stays open until it has been
used.

### What you need

- The dump file. Backups are written to the configured backup directory, named
  `dnc-<timestamp>.sql`.
- `psql` on the machine you are restoring to.
- A **new, empty database**. Never restore over the live one — see *Why never in place*.

### Steps

1. **Find the most recent good backup.**

   ```sql
   SELECT finished_at, path, bytes, event_count, sha256
     FROM backup_run
    WHERE status = 'ok'
    ORDER BY finished_at DESC
    LIMIT 5;
   ```

   If that query cannot be run because the database is gone, the files are in the backup
   directory and the newest is the one you want.

2. **Check the file is the file.**

   ```
   sha256sum dnc-<timestamp>.sql        # Linux
   Get-FileHash dnc-<timestamp>.sql     # Windows
   ```

   Compare against `sha256` from the ledger. A mismatch means a truncated or corrupted
   copy — use the previous backup rather than restoring a partial one.

3. **Create an empty target.**

   ```sql
   CREATE DATABASE dnc_restore_YYYYMMDD;
   ```

4. **Replay it. `ON_ERROR_STOP` is not optional.**

   ```
   psql --set ON_ERROR_STOP=1 --file dnc-<timestamp>.sql "postgresql://.../dnc_restore_YYYYMMDD"
   ```

   Without that flag `psql` reports success after replaying a dump that half-failed. You get
   a database, it is missing things, and nothing said so.

5. **Verify — do not trust the exit code.**

   ```sql
   SELECT count(*) FROM incident_event;          -- compare against event_count in the ledger
   SELECT count(*) FROM schema_migration;        -- must not be zero
   SELECT tgname FROM pg_trigger
    WHERE tgrelid = 'incident_event'::regclass AND NOT tgisinternal;
   ```

   The last one matters more than it looks. A restore that brings back the rows but not the
   append-only triggers gives you a database where the event log **can be edited**, and
   nobody finds out until an audit. The data would be back and the guarantee would be gone.

   `verifyRestoredIntegrity` in `app/src/ops/restore.ts` runs all three, including actually
   attempting a forbidden `UPDATE` inside a transaction it always rolls back.

   **Since 2026-08-20 `restoreInto` calls it for you and refuses a restore whose guard is
   missing** (O-37). Until that date it reported `ok` on two facts — `psql` exited cleanly and the
   event count was not short — and **neither of them can see the triggers**, which a `pg_dump`
   writes at the very end of the file. Measured on a real dump: the event data begins at **43%**
   and the first `CREATE TRIGGER` sits at **85%**, so a dump truncated between the two restored
   every row, satisfied both checks and reported success. The check existed and nothing called it.

   ⚠️ **Run the three queries anyway.** This step's own rule is that you do not trust an exit
   code, and that applies to ours as much as to `psql`'s.

   ⚠️ **A restore of a district with no events reports `ok` and lists what it could not prove**,
   under `unproven` — the guard is demonstrated by attempting that forbidden `UPDATE` on a real
   row, and an empty table gives it nothing to attempt. That is not a failure. **It is also not a
   pass**: read the sentence, and if you expected events, stop.

6. **Write down how long it took**, and what went wrong. An untimed restore is an untested
   one, and the number matters: it is how long the district is without its record.

### Why never in place

Every restore goes into a database you name. A tool whose easiest path overwrites production
is a tool that will eventually overwrite production — at 02:00, by someone tired, who meant
to type something else. Swapping a verified restore into place is a separate, deliberate
step taken by someone awake.

---

## Backups

- Taken by `runBackup` (`app/src/ops/backup.ts`), which records every attempt in
  `backup_run` **before** the dump starts. A process killed mid-dump therefore leaves a
  visible `running` row rather than no row at all.
- Plain SQL, not the custom format: you can read it, grep it, and replay it with `psql`
  alone (ADR-0007). One fewer tool to have installed and be wrong about under pressure.
- A dump is **verified, not assumed**. `pg_dump` exiting 0 proves nothing — size, checksum
  and the event count inside the file are all checked, and a dump holding fewer events than
  the live database is recorded as a failure.

### The schedule — **hourly since 2026-08-14**

Started with the server (`app/src/jobs/nightly.ts`). It **checks every ten minutes whether this
hour's backup has been taken**, rather than sleeping until the top of the hour — a district server
gets rebooted, loses power and is occasionally a laptop somebody closed, and a timer set hours out
is a timer that never fires. A machine that was off when the hour turned takes one the moment it
comes back.

**Why it changed, because the number is the point.** It ran once a night. A machine lost at 20:00
restored to 02:57 that morning, and **everything in between was gone — not delayed, gone**: every
emergency reported that day, every acknowledgement, every record of who was told. Restoring gave
you yesterday's district with today erased.

And the consequence that is easiest to miss: **the reporters.** Somebody rang at 10:00 about a
fire, that report is gone, and **nobody knows to ring them back.** The district does not know what
it does not know.

The dump is about 200 KB, so twenty-four a day is roughly 5 MB. **Seventeen hours of the district's
record, traded for a few megabytes.** The owner decided it on 2026-08-14.

**Local dumps are pruned to the newest 48** (two days). This exists *because* of hourly: at one a
night nothing needed pruning, and at twenty-four a day a directory nobody empties fills a disk —
which does not merely stop the backup, it stops PostgreSQL. **Only files named `dnc-*.sql` are
touched**, so `restored.sql` sitting in that directory during a restore is never deleted by
housekeeping. **The off-site copies are never pruned by this**; they are the record, the local
files are a convenience.

### The off-site copy

After a dump verifies, it is **encrypted and sent to object storage** (ADR-0011).

**Which store, on the day it matters.** Two are supported and the choice is made by `.env`
alone: an **S3-compatible** bucket (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_REGION` — Cloudflare R2 uses `auto`), or **Google Cloud Storage**
(`GCS_BUCKET`, `GCS_TOKEN`). **`S3_BUCKET` wins if both are set.**

> **Bajaur is on S3, not GCS.** This section said "Google Cloud Storage" until 2026-08-13 and was
> wrong about the district's actual deployment — the kind of error that costs an hour at 02:00,
> looking in an empty bucket. Verified on 2026-08-12 by listing the bucket itself rather than by
> reading the ledger: one object, `dnc-2026-08-12T21-57-10-685Z.sql.enc`, 160,676 bytes.
> **Check `/opt/dnc/app/.env` before trusting any sentence here about where the copy is.**

- **AES-256-GCM**, key derived from `BACKUP_PASSPHRASE` by scrypt. GCM authenticates, so a
  file altered in the bucket refuses to decrypt rather than restoring quietly wrong.
- **The passphrase is not in the file** and is not in the bucket. If it is lost, **every off-site
  copy is scrap** — that is the point of it, and it is also the single most likely way this whole
  system fails in practice.

  **Where it is kept, decided by the owner on 2026-08-14:** on the server **and on the control
  room's own system**. That is a genuine improvement and for a reason worth stating — the server is
  in **Helsinki** and the control room is in **Bajaur**, so the event that destroys one does not
  touch the other.

  **Two things still to do, and both are an afternoon's work:**

  1. **A second place that does not fail with the first.** One copy on one machine is still one
     copy: if the control room's system dies, is stolen, or is reinstalled, every off-site copy
     becomes unreadable — **and nobody finds out until the day it is needed.**
  2. **One copy that is not a computer.** A sealed envelope in the DC's safe. It looks
     old-fashioned, and it works on precisely the day every computer has failed.
- **No passphrase, no upload.** The job refuses rather than sending the district's record out
  in the clear. A dump holds every reporter's number in Bajaur.
- **"Not attempted" is recorded as not attempted.** `backup_run.offsite_at` is null and
  `offsite_error` says why — a district with no bucket must never see the same green tick as
  one that has a copy safely out of the building.

#### Restoring from an off-site copy

The file in the bucket ends `.sql.enc` and is not directly usable by `psql`. Decrypt it
first:

```
node -e "
  const { readFileSync, writeFileSync } = require('node:fs');
  const { decryptDump } = require('./app/dist/ops/offsite.js');
  writeFileSync('restored.sql', decryptDump(readFileSync(process.argv[1]), process.env.BACKUP_PASSPHRASE));
" dnc-2026-08-03.sql.enc
```

Then follow **Restore from backup** above, using `restored.sql`. If decryption throws, the
file has been altered or the passphrase is wrong — and either way, **do not go looking for a
way to force it**. That error is the check working.

### Is the backup working?

```
curl http://<host>/health
```

`degraded: true` with `backup.ok: false` means no successful backup in 24 hours, or a run that
started and never finished. **That threshold is still 24 hours and was deliberately left alone**
when the schedule became hourly: tightening it to an hour would page somebody for a single missed
run, and one missed hourly backup is not the failure worth waking a district for. **Twenty-four
consecutive misses is.**

`replication` sits beside it. `role: "standalone"` means **the district is running on one
machine** — a failure of it stops Bajaur until somebody repairs it (R-07). `role: "primary"`
with a `lagSeconds` above 60 means a failover right now would lose that much of the record.

The two administrative offices see all of this on **Administration → Backups**, along with
the last twenty runs and a "take a backup now" button.

**`/health` returns 200 even when the backup is stale.** That is deliberate: a 503 would
take the node out of a load balancer and stop the district reporting emergencies because a
dump was old. INV-01 outranks a stale backup. Monitor `degraded`, not the status code.

---

## Things that are not yet true

Recorded here rather than discovered at 02:00:

- ~~**Nothing schedules the backup yet.**~~ **Done, 2026-08-03** (M0-53). It runs nightly and
  sends an encrypted copy off-site — when there is somewhere to send it (R-06).
- ~~**The off-site copy has nowhere to go** (R-06).~~ **Done, and it is new.** The two runs
  before 12 Aug recorded `no bucket or service account yet`; the copy began working **between
  12 Aug 02:06 and 12 Aug 21:57**. Verified by listing the bucket, not by reading
  `backup_run`. **The very first thing anyone should do with a one-day-old safety net is pull
  on it** — which is M0-38 below.
- **No standby exists yet** (R-07). `/health` reports `standalone`, which is honest and is
  also the single largest gap in ADR-0011's plan: one machine holds the district's record.
- **Nobody has restored this system by hand.** The path below is executed by the test suite on
  every push, and that is a different fact from a person having done it under time pressure
  (M0-38, R-08). Note what the suite proves and what it does not: it round-trips a **local**
  dump. The off-site copy is a different artefact — encrypted, on somebody else's storage, and
  the only one that survives losing the machine. **Nobody has ever decrypted one.**
- **Nothing pages a human.** `degraded` is reported and nobody is watching it. That is M5.
- **The restore drill has not been performed by a second person.** M0-38, and the last open
  item on the M0 gate. The drill sheet is written and waiting at **`backlog/restore-drill.md`**,
  against the district's verified state. It needs two people and a clock; the number it exists
  to produce is **how long Bajaur would be without its emergency record**, and nobody knows it.
- **There is exactly one off-site copy and only one machine.** Those two facts together are why
  the drill is urgent rather than tidy.
