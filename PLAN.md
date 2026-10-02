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
       `docs/whatsapp-template.md`). This takes days — start early.
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
| A | **"Install this app" banner** — one tap on Android/Windows (Chrome, Edge); "Share → Add to Home Screen" steps on iPhone | — | domain + HTTPS (D-04) |
| C3 | Activities, **videos**: resumable chunks, ≤3 min, server → 720p (ffmpeg), processing/ready/failed, `doctor` lists failures | ADR-0039 | ffmpeg on server |
| D | **WhatsApp → Activities**, same number; open emergency → two buttons; unknown numbers → Pending list | [ADR-0040](docs/adr/ADR-0040-whatsapp-to-activities.md) | Bajaur's **new** Meta portfolio |

C1 notes (2026-10-02):
- Activities are **online only** — no offline outbox (ADR-0002 is for emergencies). A post is
  saved first, then each photo is its own request; failed photos can be sent again.
- **HEIC:** the phone converts it when the browser can read it (iPhone Safari does); otherwise
  the page asks for a JPEG/PNG. Server-side conversion is left for C3, which brings ffmpeg.
- A hard delete removes rows and files on the server. Backup copies do not exist yet — removing
  them is part of C2.

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
- [ ] `installer/runtime/first-run.mjs` still inserts into the dropped `department` table — the
      Windows installer cannot create the first account. Fix before any Windows install.
- [x] `npm run dev:account` and `npm run demo` used the dropped `department` table — fixed.
- [ ] `web/src/admin.ts` contact cards are built with `innerHTML` from the contact's name,
      post and number, unescaped. Only the administration enters those, but a name containing
      markup would run in every admin's console. Fix (build with `textContent`) before go-live.

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
