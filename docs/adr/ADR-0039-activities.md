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

### Implementation note (2026-10-02, C1 — photos)

Migration `0050_activities.sql` adds `activity_unit`, `activity_post`, `activity_media`,
`activity_log` (append-only by trigger) and `person.activity_unit_id`. The routes are in
`api/activities.ts`, under `/activities/`, and are the one place besides `/auth/me` that calls
the ungated session resolver (pinned by `memberGate.test.ts`); every handler asks the
Activities permissions itself. A post is created first and each photo is then sent in its own
request, with a small thumbnail made on the phone in the same request. Photos are stored only
if their bytes are JPEG, PNG or WebP, and are served inline with the sniffed type, `nosniff` and
a sandboxing CSP. Soft-deleted posts are seen only by moderators, in the Recycle bin. Posting is
refused until a forced password change is done. Retention, the warning, the ZIP and the backup
are C2; videos are C3.

### Implementation note (2026-10-02, C2 — thirty days and the backup)

Migration `0051_activities_retention.sql`. One housekeeping job (`jobs/activitiesRetention.ts`,
own advisory lock, separate from the escalation scheduler) runs **hourly rather than nightly** —
the same reasoning as the database backup in `jobs/nightly.ts`: every step is idempotent, and a
timer hours away never fires on a rebooted server. Each pass, in order:

1. **Expire** — posts uploaded 30+ days ago (Recycle bin included) are hard-deleted through the
   same `removePost` a person's delete uses, logged as `expired` with no actor.
2. **Remove from the bucket** — a hard delete queues its objects in `activity_backup_removal` in
   the same transaction that removes the rows; the job deletes them from the bucket. A refusal
   stays queued with its reason.
3. **Copy** — new photos and thumbnails are encrypted with `BACKUP_PASSPHRASE` (as the dumps
   are) and sent to `ACTIVITIES_S3_BUCKET`, a separate bucket on the same S3 keys. Refused
   without a passphrase of 16+ characters.

**Warning and ZIP** (moderators only): `GET /activities/expiring` says what goes in the next 3
days and whether the backup is behind (photos not copied, or deletes waiting, for over a day);
`GET /activities/expiring.zip` streams those posts — a folder each, plus `activities.csv` — and
logs `zip_downloaded`. The ZIP is written by `ops/zip.ts` (stored, no ZIP64, no dependency).
Every post card shows its automatic delete date in its last 3 days. `npm run doctor` reports
whether the media bucket is configured.

### Implementation note (2026-10-02, C3 — videos)

Migration `0052_activities_videos.sql`: a video is an `activity_media` row of kind `video` with a
`status` — `uploading` → `processing` → `ready`, or `failed` with a `failure` reason. Photos are
`ready` from the start.

- **Upload, resumable.** `POST /activities/posts/:id/videos` (JSON: size, type, and the length
  when the phone can read it) gives a place; `PUT /activities/uploads/:id` with
  `x-upload-offset` sends the next chunk (4 MB from the page, 8 MB cap); `GET` on the same path
  says how much arrived. A chunk at the wrong offset is refused with 409 and the page asks where
  to carry on. The first chunk is checked by its bytes (MP4 / QuickTime only); a non-video is
  refused and its place given back. Limits: 300 MB, 3 per post (a failed video gives its place
  back), 3 minutes (the phone checks first; the converter checks the file). An upload with no
  chunk for 24 hours is given up by the hourly housekeeping.
- **Conversion.** `jobs/activitiesVideo.ts`, one video at a time under its own advisory lock,
  woken by the last chunk and on a one-minute timer: ffprobe for the length, ffmpeg to 720p
  (short edge, never enlarged) H.264 + AAC with `+faststart`, a 480 px poster frame, then the
  original is deleted. Written as `.part` and renamed, so a half-made file is never served; a
  restart converts the video again. A refusal or a video over 3 minutes is `failed`, logged as
  `video_failed` (no actor) and listed by `npm run doctor`. **ffmpeg missing is not a failure:**
  the video waits as `processing`, and `doctor` and the DC's Activities warning (after an hour)
  say so. `FFMPEG_PATH` / `FFPROBE_PATH` point at a copy that is not on the PATH.
- **Playback.** `GET /activities/media/:id` serves the converted MP4 with byte ranges (iPhone
  will not play a video without them); `?size=thumb` is the poster. Never before `ready`.
- **Backup, ZIP, warning:** only `ready` videos are copied to the bucket, counted in the 30-day
  warning, and put in the ZIP (`video-01.mp4`, …).
- **Service worker:** `/activities` joined `NEVER_CACHE` (shell v263). Since C1 the list after a
  post had been answered from the shell's cache — the post looked lost.
- Server-side HEIC conversion (§4) is **not** part of C3: the phone still converts HEIC where the
  browser can, and otherwise asks for a JPEG/PNG.

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
