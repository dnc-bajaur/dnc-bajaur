# District Nerve Center — Bajaur

**Project reference for Claude Code and any other agent working in this repository.**
Read the four isolation rules first. They outrank everything else in this file.

---

## ⛔ THE FOUR ISOLATION RULES — READ BEFORE ANYTHING ELSE (NON-NEGOTIABLE)

This codebase began as a copy of the District Nerve Center built for another district. It is
now **Bajaur's own, separate application**. The owner has set these rules; breaking any of them
is a serious failure, and the agent that breaks one is responsible for the damage.

1. **NEVER TOUCH THE OTHER DISTRICT'S PROJECT.** Do not read, edit, add to, remove from, run
   commands in, or push to the original project, its repository, its server or its accounts.
   Bajaur is an entirely separate codebase in its own GitHub repository. **The two must never
   mix, in any way.**

2. **WORK ONLY INSIDE `D:\VIBE CODING\DNC Bajaur`.** Every change, cleanup and deletion happens
   inside that folder and nowhere else. **The `D:\Vibe Coading\Nawaz` folder is PROHIBITED —
   do not open it, list it, read it, or run any command (including any `git` command) that
   touches it.** Do not touch it until the owner explicitly says so.

3. **NO OTHER DISTRICT'S DATA IN THIS REPOSITORY.** No phone number, officer name, department,
   domain, seal, server address, account ID or any other fact belonging to another district may
   exist anywhere in this repo — code, tests, comments, docs or history. Bajaur's own facts come
   only from the owner.

4. **THE ONLY ALLOWED REMOTE IS `https://github.com/dnc-bajaur/dnc-bajaur.git`.** Every commit
   and push goes there and **nowhere else**. Before every push, run `git remote -v` and confirm
   it. A `pre-push` hook (`scripts/git-hooks/pre-push`, enabled with
   `git config core.hooksPath scripts/git-hooks`) refuses any other destination — **never bypass it**
   (`--no-verify` is forbidden). Never add a second remote.

**Also:** the repository is public for now. Never commit `.env`, secrets, tokens, or real
officers' phone numbers (`app/db/seed/directory.json` is gitignored for exactly this reason).
Git history is permanent — a secret committed once must be treated as leaked.

---

## 1. What we are building

A district-wide operational platform for **Bajaur, Khyber Pakhtunkhwa, Pakistan**, whose purpose
is fast, coordinated, accountable emergency response — plus routine district operations
coordination — run from the DC office's control room.

**It is not a dashboard.** It is the system of record for what happens in the district.

## 2. The root idea (immutable)

1. One district-wide operational platform, not a dashboard.
2. A central view of the whole district, live.
3. **One source of truth** — data is never duplicated into a second copy.
4. Emergency management is the point: captured, assigned by the control room, acknowledged
   under a server-enforced SLA, escalated when silent, closed with a complete audit trail.
5. The control room operates the system; officers are reached over WhatsApp, not given accounts.

## 3. Load-bearing decisions

The *why* behind the code lives in **`docs/adr/`** — read the relevant ADR before changing
anything structural. The index with status and reversal cost is `docs/adr/README.md`.

The ones most often needed:

| ADR | Decision |
|---|---|
| 0001 | The event log is the record; state is a projection. Never mutate — append an event. |
| 0002 | Offline is the substrate. Every client write is a UUID-stamped event in a durable outbox. |
| 0003 / 0024 | Authority is data (policy table), enforced server-side. The control room does everything. |
| 0004 / 0029 | Route to a post (seat), not a department. A contact is name + number + post. |
| 0014 / 0034 | The software sends over one WhatsApp number the district owns; delivery must be *known*. |
| 0019 | One primary database in the cloud. Everything else is a copy. Never two writable records. |
| 0020 / 0021 | One district day is the unit; the Dashboard is the day, the Record is everything else. |
| 0022 | The control room assigns. Nothing routes itself. |
| 0027 | Each incident gets a human number, `DNC-BAJAUR-1, 2, …` (`src/domain/reference.ts`). |
| 0032 | Settings panel: roles (`owner`/`admin`/`operator`/`viewer`) + allow/deny overrides. |
| 0038 | **Bajaur:** `member` role — officers sign in for Activities only; one gate (`requireSeat`) keeps them out of every operational route. |
| 0039 | **Bajaur:** Activities — a separate module (own tables, own Department list), soft/hard delete, 30-day retention. Never touches incidents or evidence. |
| 0040 | **Bajaur:** WhatsApp media to the district number becomes Activities; unknown senders → Pending list. |

**Note on older text:** the ADRs, `docs/` and many code comments were written while building
the original deployment. Their *reasoning* applies here; their *examples, counts and dated
anecdotes* (e.g. "the district has 79 departments", "confirmed on 2026-08-16") are illustrative
and are **not verified facts about Bajaur**. References in comments to `CHANGELOG.md`,
`backlog/…` or numbered sections of an older `CLAUDE.md` point at history that is not part of
this repository.

## 4. Invariants — what must never happen

Full text and test mapping in `docs/01-invariants.md`. Each has a permanent test.

- **INV-01** An emergency is never lost.
- **INV-02** Stale data is never rendered as current. *(ADR-0037 is a known, deliberate exception.)*
- **INV-03** A notification failure is never invisible.
- **INV-04** An aggregate never hides a critical.
- **INV-05** The UI is never the enforcement layer.
- **INV-06** No sensitive action is unattributable.
- **INV-07** An SLA clock never runs on a client.
- **INV-08** Recovery never produces a notification storm.

## 5. Current state

> **This is the handoff between sessions.** A new session reads it first and starts from **Next**.
> At the end of every task: rewrite these lines (what is done, what is next), tick `PLAN.md`,
> commit and push. Keep it **under ~20 lines** — replace, never append history.

- **2026-10-01** — Repository created from the original codebase; all other-district data
  removed, neutral placeholders in its place (`PLAN.md` §2). **Not deployed:** no server,
  domain, WhatsApp number or backup bucket for Bajaur yet.
- **2026-10-02** — Every name that could collide with the other district on a shared machine,
  server or browser is Bajaur's own (`PLAN.md` §6).
- **Local dev works:** Bajaur's own PostgreSQL 17 (`D:\dnc-bajaur-postgres`, data
  `D:\dnc-bajaur-pgdata`, port 5434, `scripts/dev-db.ps1 start`), `app/.env` (gitignored),
  app via `npm start` on `localhost:3100`; `npm run dev:account` / `npm run demo` for dev data.
  Never use the other district's cluster on this machine. Full suite runs locally (files run one
  at a time). Rarely a test process dies mid-run here ("Worker exited unexpectedly"; cause
  unknown, never seen in CI). The run's end now names the file (`testing/crashTrace.ts`,
  trace in `app/var/test-trace.log`). Seen so far: `groups`, `integrity`, `wall`, `acknowledgement` —
  different files, dying before any test runs, no exit code; not reproducible on demand.
- **Built (ADR-0038):** B1 `member` role + deny-by-default gate (gated `resolveSession` in
  `api/server.ts`, pinned by `memberGate.test.ts`; members land on `/activities.html`). B2
  Activities permissions (`domain/roles.ts`). B3 accounts with Post, `member` by default,
  "Give login" on a contact (`POST /settings/accounts/:id/grant`).
  ⚠️ Any role other than `member` still acts as the full control room.
- **Built (ADR-0039) C1:** Activities with photos — migration 0050, `api/activities.ts`
  (routes under `/activities/`, the one extra `resolveAnySession`), page `web/activities.html`.
  Photos in `var/activities/`.
- **Built (ADR-0039) C2:** migration 0051; hourly housekeeping `jobs/activitiesRetention.ts`
  (30-day expiry → bucket deletes → encrypted copy to `ACTIVITIES_S3_BUCKET`); DC warning +
  ZIP (`/activities/expiring[.zip]`, `ops/zip.ts`). No media bucket exists yet.
- **Built A:** "Install this app" banner (`web/src/install.ts`) on the shell and Activities.
- **Built (ADR-0039) C3:** videos — migration 0052, chunked resumable upload
  (`/activities/posts/:id/videos`, `/activities/uploads/:id`), converter `jobs/activitiesVideo.ts`
  (ffmpeg → 720p + poster; missing ffmpeg = wait, not fail), Range playback. Local ffmpeg:
  `D:\dnc-bajaur-ffmpeg` via `FFMPEG_PATH`/`FFPROBE_PATH` in `app/.env`. `/activities` never
  cached by the service worker (v263).
- **Next:** D — WhatsApp → Activities (ADR-0040; buildable locally, go-live needs Bajaur's Meta
  account). Small open items in `PLAN.md` §4 (C3 notes, known bugs).

## 6. Repository map

```
DNC-Bajaur/
├── CLAUDE.md            ← this file
├── PLAN.md              ← Bajaur's plan: what is pending, what is needed, go-live checklist
├── README.md            ← orientation for a new reader
├── .github/workflows/   ← CI: real PostgreSQL 17 + Chromium, runs `npm run check`
├── docs/                ← thesis, invariants, data model, authority model, stack, runbook
│   ├── 06-open-questions.md ← unknowns; unverified facts go here, never into code
│   └── adr/             ← architecture decision records (the "why")
├── scripts/dev-db.ps1   ← portable local PostgreSQL helper (Windows)
├── scripts/git-hooks/   ← pre-push guard: refuses any remote but dnc-bajaur/dnc-bajaur
├── installer/           ← Windows installer, cloud setup (setup.sh), legal pages, proxy
└── app/                 ← the application (Node ≥ 22, TypeScript, PostgreSQL 17)
    ├── .env.example     ← copy to .env; .env is gitignored — never commit it
    ├── build.mjs        ← esbuild for the web client → web/dist (gitignored)
    ├── db/migrations/   ← forward-only SQL, applied in order (src/db/pool.ts)
    ├── db/seed/         ← directory.example.json is the shape; directory.json (real) is gitignored
    ├── scripts/         ← doctor, demo data, WhatsApp setup, template submit, test reset…
    ├── src/
    │   ├── api/         ← HTTP routes (server.ts is the router)
    │   ├── auth/        ← passwords, sessions, throttling
    │   ├── db/          ← stores (event store, roster, groups, WhatsApp…)
    │   ├── domain/      ← pure logic: events, incident fold, SLA, authority, reports
    │   ├── jobs/        ← escalation, notify, nightly, proactive, scheduler
    │   ├── ops/         ← backup/restore, offsite, WhatsApp, weather, news, integrity
    │   ├── outbox/      ← client-side durable outbox (IndexedDB)
    │   └── main.ts      ← server entry point
    └── web/             ← the single-page client: index.html, src/*.ts, css, icons
```

## 7. Commands (run inside `app/`)

| Command | What it does |
|---|---|
| `npm ci` | Install dependencies exactly from the lockfile |
| `npm run check` | typecheck + lint + format check + all tests — **must be green before any commit** |
| `npm run build` | Build the web client |
| `npm run shell:record` | Re-record the web shell digest. **Required after any change under `web/`**, or `shellVersion.test.ts` fails |
| `npm start` | Build and run the server |
| `npm run doctor` | Read-only "is this ready to go live?" report |

Database-backed tests need `TEST_DATABASE_URL` (see `.env.example`). Without it they skip
locally and **fail** in CI by design.

## 8. Engineering rules

- **Never invent domain facts about Bajaur** — its officers, departments, numbers, procedures.
  Unverified → `docs/06-open-questions.md`, or a visibly fake placeholder listed in `PLAN.md`.
- **A placeholder must be visibly a placeholder** (`0000-000000`, `example.com`, the neutral seal).
- One source of truth. Never mutate emergency state in place — append an event.
- Authorisation is server-side, through the authority model. Hiding a button is not security.
- SLA timers and escalation run on the server, never on a client.
- No AI in the critical path: it may assist an operator; it never routes, closes, or records fact.
- No hardcoded secrets, credentials, keyed endpoints or demo data in any shipped path.
- Smallest coherent change. No broad rewrite without an ADR. Every behaviour change gets a test.
- New dependency → answer first: who restarts it when it fails, and how do they know?

## 9. Definition of Done

- Acceptance criteria demonstrated, not asserted.
- `npm run check` green (CI green for database suites).
- Server-side authorisation verified; sensitive actions auditable; offline path tested for writes.
- No unrelated changes, no debug code, no secrets, no other district's data.
- `PLAN.md` updated if the plan moved; §5 above updated if the current state changed.
- **Pushed only to `dnc-bajaur/dnc-bajaur`, after checking `git remote -v`.**
