# ADR-0039 — Activities: departments' daily pictures and videos, inside the app, for 30 days

**Status:** Accepted · 2026-10-01
**Decided by:** the owner, for the Deputy Commissioner Bajaur.
**Rests on:** [ADR-0038](ADR-0038-member-accounts.md) (who may upload and see),
[ADR-0007](ADR-0007-boring-stack.md) (one new dependency: ffmpeg).
**Does NOT touch:** incidents, evidence (never deleted — [ADR-0001](ADR-0001-event-log-as-record.md)),
seats, or the removed department layer
([ADR-0029](ADR-0029-the-department-layer-is-removed.md)/[0030](ADR-0030-the-department-table-is-dropped.md)/[0031](ADR-0031-no-department-vocabulary.md)).
**Reversal cost:** Low — a self-contained module and its own tables.

## Context

Departments send pictures of their daily activities to the DC over WhatsApp, where they are hard
to find and review. The DC wants them inside the app, all together and by department, with the
DC in control of who sees and deletes what. These are **not** emergency records, so deleting
them is allowed — unlike evidence, which is never deleted.

## Decision

1. **A separate module** with its own tables: `activity_unit` (shown as "Department"),
   `activity_post`, `activity_media`, and `activity_log` (who did what, when). Nothing is
   written to the incident event log or to the `evidence` table.
2. **Departments for Activities only.** The DC creates, renames and retires them from inside
   Activities. Each account has a default department; a post may choose another. Used for
   filtering only — **no authority attaches to it**.
3. **A post:** department, activity date (date picker, never in the future), caption, optional
   place, up to 10 photos and 3 videos.
4. **Compression without visible loss.**
   - Photos are compressed on the phone before upload (long edge 2048 px, high quality).
     iPhone HEIC is converted where the browser can, otherwise on the server.
   - Videos upload in resumable chunks (max 3 minutes, max 300 MB original). The server converts
     them to 720p H.264 with ffmpeg and then deletes the original. The post shows
     *processing* / *ready* / *failed*.
5. **Views:** all departments together, by department, by person, by date range — limited by
   the viewer's permission (own posts / all posts, ADR-0038).
6. **Delete.**
   - The uploader deleting their own post → **hard delete**, immediately.
   - DC / DNC → **soft delete** (hidden, kept in a Recycle bin), **restore**, or **hard delete**.

   A hard delete removes the files from the server **and** from the backup. The log keeps one
   line — who deleted which post, and when — never the media.
7. **Retention: 30 days from upload.** A nightly job hard-deletes anything older, Recycle bin
   included. Three days before, the DC sees a warning and can download a ZIP.
8. **Backup:** new media is copied nightly to a separate Bajaur-owned bucket. Deletes are applied
   there too, and a 30-day lifecycle rule on the bucket is the safety net. Post records travel
   with the normal database backup.

## Rationale

A separate module keeps the emergency system exactly as it is: no new meaning for evidence, no
department concept in the operational code, and deletion confined to data that is allowed to be
deleted.

## Consequences

### We gain
- One place for every department's activity record, filterable by department, person and date.

### We give up
- Anything older than 30 days. By design; the ZIP download is the way to keep something.

### We must therefore also
- Size the server disk for the rolling 30 days (estimate ~13 GB: ~3.75 GB photos + ~9 GB video).
- Install ffmpeg on the server. It runs per job; a failure marks that video *failed* and is
  listed by `npm run doctor`, so nothing fails silently.
- Make every create, delete and restore attributable (INV-06).

## Alternatives considered

- **Reuse the evidence system** — evidence belongs to incidents and is never deleted. Rejected.
- **Bring back departments for the whole app** — would undo ADR-0029/0030/0031 across the code.
  Rejected; Activities gets its own list.
- **Compress video on the phone** — unreliable across Android and iPhone browsers, slow and heavy
  on battery. Rejected in favour of server conversion.

## How we would know this was wrong

- Uploads regularly fail on weak connections despite chunking.
- Disk use climbs well past the estimate.
- The DC routinely needs pictures older than 30 days.
