# PLAN — District Nerve Center, Bajaur

The working plan for Bajaur's deployment. **Update it whenever the plan moves**: tick what is
done, add what is new, delete what no longer applies. It is a plan, not a diary — keep it short.

The isolation rules in `CLAUDE.md` apply to every step below.

---

## 1. Where we are (2026-10-01)

- [x] Clean copy of the code made in `D:\VIBE CODING\DNC Bajaur\DNC-Bajaur` (no old git history,
      no `.env`, no backups, no build output, no other district's directory).
- [x] All other-district data removed: names, phone numbers, Meta IDs, domain, emails, address,
      seal, place names, coordinates. Neutral placeholders put in their place (§2).
- [x] Baseline verified after the clean-up: typecheck, lint, format clean; 933 tests pass
      (same as before the clean-up). Database-backed tests run in CI.
- [x] New `CLAUDE.md` (short, isolation rules on top). Old `CHANGELOG.md` and Rule 0 dropped;
      this file replaces them.
- [x] First commit made locally (`main`), remote set to `dnc-bajaur/dnc-bajaur`, pre-push guard on.
- [x] Pushed to `dnc-bajaur/dnc-bajaur` (`imtiazai004` added as a collaborator with push access).
- [x] **CI green on GitHub** — all 148 test files, database suites included. The first run had 9
      inherited failures (tests expected an *Acknowledge* tap to stay `acknowledged`; the code
      moves it to `responding`). **Owner decided: an Acknowledge tap goes straight to Responding**,
      as the code does — the tests were updated to match.
      Note: `board.e2e` test 24 failed once and passed on re-run (flaky; untouched).

## 2. Information needed from the owner

Each item says where the answer goes. Until it is filled, the placeholder shown stays — and it
is deliberately obvious so it can never pass for real data.

| # | What | Placeholder now | Where it goes |
|---|---|---|---|
| D-01 | **Officers' contact list** (name, designation, WhatsApp number) | none — empty directory | `app/db/seed/directory.json` (gitignored; shape in `directory.example.json`), loaded with `installer/cloud/load-directory.mjs` |
| D-02 | **DC Bajaur's seal** (image, square, clear) | neutral app icon | `app/web/icons/dc-crest.jpg` + the base64 `DC_SEAL` in `app/src/api/dailyReport.ts` and `app/web/src/report.ts` |
| D-03 | **Control-room phone number** (sent to officers on WhatsApp) | `0000-000000` | `app/src/domain/acknowledgementThanks.ts` (3 texts) + its tests |
| D-04 | **Domain** for the app (e.g. `dnc.<something>`) | `dnc.example.com` | `installer/cloud/setup.sh`, legal pages in `installer/cloud/*.html`, `app/src/ops/news.ts` user-agent, help page |
| D-05 | **Official email** for the DC office | `dc-office@example.com` | sign-in footer in `app/web/index.html`, `installer/cloud/{privacy,terms,data-deletion}.html` |
| D-06 | **Office address** | `Khar, Bajaur, Khyber Pakhtunkhwa` | sign-in footer in `app/web/index.html` |
| D-07 | **Which two offices are "administration"** (today: DC Office + AC HQ) and their exact names in the directory | code `assistant-commissioner-bajaur`, title `AC HQ Bajaur` | `installer/cloud/load-directory.mjs:108`, `installer/runtime/first-run.mjs:482`, migration `0007` |
| D-08 | **Weather point** (DC office, or a tehsil that floods first) | Khar ≈ 34.7167, 71.5167 | `.env`: `WEATHER_LAT` / `WEATHER_LON` (default in `app/src/ops/weather.ts`) |
| D-09 | **Utilities shown on the Status board** — confirm names (e.g. electricity company: PESCO or TESCO?) | `Electricity (PESCO)`, `Water supply`, `Sui Gas`, `Internet`, `PTCL / Landline` | renamed from the console after go-live; or migration `0015` before first deploy |
| D-10 | **District facts** — tehsils, union councils, population, area | empty | entered from the console (District panel) |

## 3. Go-live checklist (in order)

Accounts and services must be **new and Bajaur's own** — never reuse the other district's.

1. [ ] **Server** — choose a host; run `installer/cloud/setup.sh <domain> <admin-email>`.
2. [ ] **Domain + DNS** — point D-04 at the server; TLS is issued by the setup.
3. [ ] **Database** — fresh PostgreSQL 17; migrations run on first start.
4. [ ] **`.env`** — written fresh from `app/.env.example`. New secrets only.
5. [ ] **WhatsApp** — new Meta Business account + new number for Bajaur
       (`npm run setup:whatsapp`). Note: the number must not already be on a WhatsApp app.
6. [ ] **WhatsApp templates** — their text now says *Bajaur*, so every template must be
       **submitted again and approved by Meta** (`npm run submit:template`; texts in
       `docs/whatsapp-template.md`), the sign-in link's `dnc_bajaur_login_link` included.
       This takes days — start early.
7. [ ] **Offsite backups** — new S3/R2 bucket + new `BACKUP_PASSPHRASE` (store it offline).
8. [ ] **Directory** — load D-01; mark the administration offices (D-07).
9. [ ] **First account** — owner login (`installer/cloud/grant-login.mjs`).
10. [ ] **`npm run doctor`** on the server — every line green.
11. [ ] **Restore drill** — restore a backup beside production once (`docs/08-runbook.md`).
12. [ ] Repository → **private** (owner).

## 4. Bajaur's own requirements (agreed 2026-10-01, order revised 2026-10-02)

Nothing here changes how the control room works today. **Revised order:** B first, because it
is the safety gate (until it ships no officer may have an account) and needs nothing external.
Everything below can be built and tested on `localhost:3100` now; only go-live waits on §2/§3.

| Step | What | Decision | Needs before go-live |
|---|---|---|---|
| B1 ✅ | `member` role + **one deny-by-default gate**: a member reaches only Activities, own password, sign-out and the app shell. Permanent test walks **every** route (INV-05) | [ADR-0038](docs/adr/ADR-0038-member-accounts.md) | — |
| B2 ✅ | Activities permissions in `domain/roles.ts` (table in ADR-0038 §3) + per-account allow/deny | ADR-0038 | — |
| B3 ✅ | Accounts by Name / Post (`person.designation`) / Phone, `member` by default; a contact's number is refused there and given its login from the contact drawer ("Give login", same row); temporary password, changed at first sign-in. *Default Activity department moves to C1, where the Department list is made.* | ADR-0038 | — |
| C1 ✅ | Activities, **photos**: tables, Department list (DC), post (date, caption, place, ≤10 photos, compressed on the phone), views by department / person / date, soft + hard delete, Recycle bin, log | [ADR-0039](docs/adr/ADR-0039-activities.md) | server disk |
| C2 ✅ | 30-day auto-delete + 3-day warning + ZIP download; media backup | ADR-0039 | Bajaur's media bucket (`ACTIVITIES_S3_BUCKET`, 30-day lifecycle rule) |
| A ✅ | **"Install this app" banner** — one tap on Android/Windows (Chrome, Edge); "Share → Add to Home Screen" steps on iPhone | — | domain + HTTPS (D-04) |
| C3 ✅ | Activities, **videos**: resumable chunks, ≤3 min, server → 720p (ffmpeg), processing/ready/failed, `doctor` lists failures | ADR-0039 | ffmpeg on server |
| D ✅ | **WhatsApp → Activities**, same number; open emergency → two buttons; unknown numbers → Pending list | [ADR-0040](docs/adr/ADR-0040-whatsapp-to-activities.md) | Bajaur's **new** Meta portfolio |
| E1 ✅ | **Simpler:** any Directory contact posts by WhatsApp with no login; "General" department when none; no answer in an hour → the emergency; voice notes; an unknown number's words → Pending; "Add to Directory" and one-tap Approve on Pending; every account sees every post; Give login takes a department | [ADR-0041](docs/adr/ADR-0041-directory-contacts-post-activities.md) | Bajaur's **new** Meta portfolio |
| E2 ✅ | **Officers tab** in Activities: every Directory contact — department, Activities on/off, Give login (always member) — and Departments becomes the folder list only | [ADR-0041 §9](docs/adr/ADR-0041-directory-contacts-post-activities.md) | — |
| E3 ✅ | **Fewer tabs:** DC — Activities · New post · Pending (with count) · Officers · History (Log + Recycle bin) · My account; member — Activities · New post · My account | — | — |
| E4 ✅ | **Urdu / English toggle**, across the whole app (control room too). Urdu wording checked by the owner; right-to-left layout. **E4a ✅** switch + engine + Activities in Urdu; **E4b ✅** sign-in and control room screens; **E4c ✅** the How-to-use guide | [ADR-0042](docs/adr/ADR-0042-urdu-english.md) | owner reads `app/web/ur.json` |
| E5 ✅ | **Sign-in link on WhatsApp** when a login is given — the officer sets their own password; also "Send sign-in link" for a forgotten password. Until the template is approved the DC is shown the link to send by hand | [ADR-0043](docs/adr/ADR-0043-sign-in-link.md) | Meta account + approved `dnc_bajaur_login_link` template (`WHATSAPP_TEMPLATE_LOGIN`) |

E5 notes (2026-10-03):
- "Give login" (Officers tab and the contact drawer) sends a sign-in link by default; a typed
  temporary password is still possible. The link: single-use, 72 hours, only its hash stored;
  opening it spends nothing; using it sets the password, signs other sessions out and signs in.
- Without the login template the DC is shown the link and a Copy button (works today, no Meta);
  with it, the link goes from the district number and the DC is told sent / failed (INV-03).
- Migration 0055 (`login_link`, two access-log types). Pinned by `loginLink.test.ts` (stubbed
  Meta) and `setPassword.e2e.test.ts`. Not tried against Meta itself.

E4 notes (2026-10-03):
- `web/src/i18n.ts` replaces whole known English phrases with Urdu from `web/ur.json` as they
  reach the page; `translate="no"` marks people's words. Per device (`dnc-bajaur.lang`), set
  before the first paint, page held ≤ 4 s for the word list. Pinned by `i18n.test.ts` and
  `activitiesUrdu.e2e.test.ts`.
- E4a: Activities is fully in the list. E4b: the control room (sign-in, Dashboard, Report, Record,
  incident, Administration, Settings, Status) — found by crawling every screen in Urdu; dates in
  Urdu (`dateLocale()`), dialogs translated at `confirm`/`prompt`/`alert`, lines of labels joined
  by " · " or " — " translated label by label. What stays English on purpose: names, headlines,
  service names and other data people typed; the WhatsApp message (Meta-approved text).
- E4c: the guide is translated paragraph by paragraph (`help.ts` marks each block
  `data-i18n="html"`; its keys in `ur.json` are generated from that marking). Every stylesheet's
  left/right margins, paddings, borders and alignment are now logical properties (unchanged in
  English).
- RTL: the ticker runs the other way; `overflow-x: clip` on an RTL page, the dashboard and the
  Record (an overhang past the left edge made them slide sideways).
- Known, inherited (also in English): at 1366 px the Record's last column header ("Action")
  hangs past the right edge.

E3 notes (2026-10-03):
- The Department list now sits under **Officers** (same permission, `activities.departments`).
  **History** opens on the Log, with a switch to the Recycle bin. The Pending count is read when
  the page opens and each time Pending is opened — it does not update live.
- Activities' selected buttons now use `--on-accent` (the dark-mode faint-text note under A is fixed).
- Pinned by `activitiesTabs.e2e.test.ts` (shell v266).

E1 notes (2026-10-02):
- Decided by the owner in conversation: Directory = known sender; unanswered → emergency; every
  account reads all posts (DC narrows one with a `deny` of `activities.read_all`); an unknown
  number's words go to the Activities Pending list (not the control room) with only *Add to
  Directory* / *Delete*; voice notes are activities.
- ⚠️ *Add to Directory* makes the number a Directory contact, which can be sent emergency alerts.
- A known person's stray words with no alert from us are still dropped, as before (only unknown
  numbers' words are kept). Documents from unknown numbers are kept as a line of text, not the file.
- Voice notes are stored as sent (Ogg/Opus); older iPhone browsers may not play them.

D notes (2026-10-02):
- Built and tested locally with a stubbed Meta (`whatsappActivities.test.ts`); **go-live needs
  Bajaur's new Meta portfolio and number** (§3). On unless `WHATSAPP_ACTIVITIES=off`.
- Decisions the ADR left open are written down in ADR-0040's implementation notes (button titles,
  what counts as an open emergency, replies, late taps, the 30-day rule for held media).
- New in the app: **Pending** tab (DC/DNC, `activities.pending`), **Change date** on a post, and
  "sent on WhatsApp" on posts that came that way.
- Not yet tried against Meta itself: a real album, a real video (WhatsApp sends ≤16 MB MP4), and
  the two-button question on a real handset.

C1 notes (2026-10-02):
- Activities are **online only** — no offline outbox (ADR-0002 is for emergencies). A post is
  saved first, then each photo is its own request; failed photos can be sent again.
- **HEIC:** the phone converts it when the browser can read it (iPhone Safari does); otherwise
  the page asks for a JPEG/PNG. Server-side conversion is left for C3, which brings ffmpeg.
- A hard delete removes rows and files on the server. Backup copies do not exist yet — removing
  them is part of C2.

A notes (2026-10-02):
- `web/src/install.ts`, on the shell and on Activities (which now links the manifest). Chrome/
  Edge show it only when they consider the page installable — over HTTPS, so not on a bare IP
  address. iPhone gets the Share steps. "Not now" is remembered in that browser for 14 days.

C3 notes (2026-10-02):
- Resumable chunked upload (4 MB chunks; a drop carries on from what arrived), converted one at a
  time by `jobs/activitiesVideo.ts` to 720p H.264 + a poster frame; the original is deleted.
  `setup.sh` installs ffmpeg. Without ffmpeg, videos **wait** (not *failed*); `doctor` and the
  DC's warning say so. Local dev: portable copy in `D:\dnc-bajaur-ffmpeg`, `FFMPEG_PATH` /
  `FFPROBE_PATH` in `app/.env`.
- Fixed on the way: the service worker answered `/activities/…` reads from its cache since C1
  (a new post did not appear in the list). `/activities` is now never cached (shell v263).
- Open: the **Windows installer** does not ship ffmpeg yet; server-side **HEIC** conversion
  (ADR-0039 §4) is not built.
- [x] "Remove this video" on a video that could not be used (2026-10-03): the author or a
  moderator, a failed video only, logged `video_removed` with the reason (migration 0056).

C2 notes (2026-10-02):
- Housekeeping runs **hourly** (expire → bucket deletes → copy), not once a night; see the
  ADR-0039 C2 note. Until `ACTIVITIES_S3_BUCKET` is set, photos exist only on the server — the
  DC's Activities warning and `npm run doctor` both say so. The 30-day rule runs regardless.
- The ZIP holds only what expires in the next 3 days. Past 4 GB it is refused (no ZIP64).

Rules that hold until these ship:
- **B1 shipped (2026-10-02):** a `member` account is refused every operational route. Accounts
  of the other roles (`operator`, `viewer`, `admin`) still act as the full control room.
- Existing gap: the `viewer` role is not enforced on operational writes. Do not issue viewer
  accounts until it is.
- WhatsApp setup and template submission happen **only** on Bajaur's new Meta business
  portfolio — never on any other district's.

Known inherited bugs (found 2026-10-02):
- [x] `installer/runtime/first-run.mjs` and `installer/cloud/grant-login.mjs` used the dropped
      `department` table — fixed 2026-10-02. Both now make the first account the **owner** (role,
      ADR-0032) and tick its post as the administration (district tier); grant-login gives every
      later login `member` (ADR-0038). Checked against scratch databases; no automated test.
- [x] `npm run dev:account` and `npm run demo` used the dropped `department` table — fixed.
- [x] `web/src/admin.ts` contact **and group** cards were built with unescaped `innerHTML` —
      fixed 2026-10-02 (built with `textContent`; pinned by `admin.e2e.test.ts` 4f).
- [x] The administration tick (`seat.is_administration`) had an API route but no control —
      fixed 2026-10-03: a tick in the contact drawer (Administration → Directory → Edit), asked
      about first; the last ticked post is shown as such instead of offering the box (`admin.e2e` 4g).

## 5. To verify (open points)

- Legal pages (`installer/cloud/*.html`) name the controller of the data — re-read them with the
  DC office before publishing.
- `docs/06-open-questions.md` still holds the original deployment's questions; go through it
  and keep only what applies to Bajaur.
- [x] **Local database** (2026-10-02): Bajaur's own portable PostgreSQL 17.11 — binaries in
      `D:\dnc-bajaur-postgres`, data in `D:\dnc-bajaur-pgdata`, port 5434, databases
      `dnc_bajaur_dev` / `dnc_bajaur_test`; app on `localhost:3100`. The full suite, database
      tests included, now runs locally.

## 6. Kept apart from the other district (2026-10-02)

Names that would collide if both districts ever met on one machine, server or browser are now
Bajaur's own: local dev cluster (path + port 5434), dev port 3100, browser keys
(`dnc_bajaur_session` cookie, `dnc-bajaur-outbox`, device-id, theme), Windows installer (new
AppId, `District Nerve Center Bajaur` folders / task / firewall rule, `DNCBajaurProxy`), cloud
server (`/opt/dnc-bajaur`, user `dnc-bajaur`, database `dnc_bajaur`, `dnc-bajaur.service`).
Still the owner's to keep separate: new server, domain, Meta/WhatsApp account, backup bucket.
