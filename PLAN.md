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
- [ ] **CI green on GitHub.** First full run (2026-10-01): 2086 of 2095 tests pass; **9 fail in 3
      files** — `lifecycleInWhatsApp`, `acknowledgementThanks.e2e`, `availabilityInWhatsApp`.
      Inherited, not caused by the clean-up (no logic changed): the tests expect an *Acknowledge*
      tap to leave the incident `acknowledged`, the code now moves it to `responding` (see the
      2026-09-04 note in `src/api/webhooks.ts` ~line 917). **Owner decided (b): an Acknowledge tap
      goes straight to Responding**, as the code does — the 9 tests were updated to match.

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

## 4. To verify (open points)

- Legal pages (`installer/cloud/*.html`) name the controller of the data — re-read them with the
  DC office before publishing.
- `docs/06-open-questions.md` still holds the original deployment's questions; go through it
  and keep only what applies to Bajaur.
- Local database for development: not set up yet. Until then the full test suite runs only in
  GitHub Actions. (A portable PostgreSQL could be placed inside `D:\VIBE CODING\DNC Bajaur`.)
