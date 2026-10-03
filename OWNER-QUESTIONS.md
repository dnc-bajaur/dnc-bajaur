# Owner questions — for the morning

Things that need you. Work did not stop for any of them: where a choice was needed, the safest
reversible default was taken and is written here so you can change it. Delete an item once
answered.

## Your tasks, in the order that saves the most time (updated 2026-10-03)

Everything that could be built without you is built (`PLAN.md` §4 and §4a). What is left is
yours. Details for each are in `PLAN.md` §2 and §3.

| # | What you do | Why this order |
|---|---|---|
| 1 | **Open Bajaur's own Meta Business account and get a new WhatsApp number** (never one already on a WhatsApp app). Then tell me, and I submit the templates | Meta's approval takes days; everything on WhatsApp waits for it |
| 2 | **Choose a server and a domain** (D-04) | sign-in links, "Install this app" and WhatsApp all need the HTTPS address |
| 3 | **Give me the district's facts**: officers' list (D-01), DC seal (D-02), control-room number (D-03), official email (D-05), office address (D-06), which offices are the administration (D-07), utility names (D-09) | placeholders stay on screen until then |
| 4 | **A backup bucket and a passphrase kept offline** (PLAN §3 step 7), and a media bucket for Activities | until then nothing leaves the server |
| 5 | **Read the Urdu wording** in `app/web/ur.json` (items 3–5 and 13 below) | officers will read it on day one |
| 6 | **Read the "How to use" guide** in the app, English and Urdu (item 7 below) | it was rewritten for Bajaur today |
| 7 | **Decide on git history** (item 6 below) | cannot be undone once done |
| 8 | **Run one full installer build** (item 10 below), only if the Windows installer will be used | I could not build `setup.exe` here |
| 9 | **Make the repository private** (PLAN §3 step 12) | it is public now |

## From E3 — fewer tabs (2026-10-03)

1. **Where should Departments live?** Your E3 list did not name it. It is now a section at the
   bottom of the **Officers** tab (same people may use it). Say if you want it elsewhere.
2. **History opens on the Log** (Recycle bin is one tap away). Say if the bin should come first.

## From E4 — Urdu / English (2026-10-03)

3. **Please read the Urdu wording** in `app/web/ur.json` (English left, Urdu right). It is my
   draft. Correct any line directly, or tell me what to change. Some choices to check:
   *History* → "تاریخچہ" (*Record* is "ریکارڈ"), *Pending* → "زیرِ التوا", *Retire (a department)* → "ختم کریں",
   *Recycle bin* → "ری سائیکل بِن".
4. **Font:** Urdu screens use a Naskh-style face (Segoe UI / Noto Naskh), not Nastaliq —
   Nastaliq needs twice the line height and the control room screens would not fit. Say if you
   want Nastaliq at least on Activities.
5. **Digits stay 0-9** (not ۰-۹), because phone and incident numbers are read out and typed back.

## ⚠️ Other-district officer names were in the code — removed (2026-10-03)

6. While translating, I found **real-looking officer names from the original deployment's
   directory** in comments, tests, two ADRs, a migration comment and the old
   `docs/06-open-questions.md` (e.g. officers sharing a handset, a Rescue 1122 officer, "the
   district's own shape" examples) — some described as facts *about Bajaur*. That breaks
   isolation rule 3, so **I replaced every one with visible placeholders** ("Officer Alpha",
   "Officer Bravo", …) and rewrote `docs/06-open-questions.md` for Bajaur (the old one held the
   other district's answers). Nothing that runs depends on these names; the tests pass.
   **Still your decision:** the names remain in **git history** (earlier commits). Removing them
   from history means rewriting it and force-pushing, which cannot be undone and changes every
   commit id — I did not do that. Tell me if you want it. Your own name ("Imtiaz Ahmad") appeared
   as an example post-holder and was replaced too.

## The "How to use" guide was rewritten for Bajaur (2026-10-03)

7. **Please read the guide** (*How to use* in the app), in English and in Urdu. It now has
   chapters for **Activities**, **Settings**, and **Urdu / installing the app**; signing in
   explains the roles and the sign-in link; what no longer exists is gone ("departments have no
   logins", "My shift", "79 departments"). No Bajaur fact was invented. Three things to check:
   - It calls the people who run Activities' Pending, Officers and History tabs **"the DC
     office"**. Say if another name is right.
   - Its example screens still show **"Rescue 1122", "TMO Bajaur" and "Police Station Khar"** as
     sample recipients. They are examples, not your directory — say if you want other names.
   - Its sign-in example shows the address **`dnc.example.com`** until you give the domain (D-04).
13. **62 new Urdu paragraphs** for the guide are my draft, like the rest. In `app/web/ur.json`
    they follow the line that starts *"A designation with nobody currently holding it"*.

## From E5 — sign-in link (2026-10-03)

8. **A sign-in link lasts 72 hours** and works once. Say if you want it shorter or longer.
9. **To send it by WhatsApp**, the new template `dnc_bajaur_login_link` must be submitted to Meta
   with the others (text in `docs/whatsapp-template.md`) and `WHATSAPP_TEMPLATE_LOGIN` set once
   approved. Until then "Give login" shows the DC the link with a Copy button — it works today.

## Installer (2026-10-03)

10. **The installer now carries ffmpeg** (for Activities videos): about 210 MB more on disk
    (≈ 70 MB more in `setup.exe`). ffmpeg is GPL — it is shipped unmodified, as a separate
    program, with its licence beside it. Say if you would rather install ffmpeg separately
    (`-NoFfmpeg`). **Please run one full `build-installer.ps1` before a release** — I could
    only check the script, not build `setup.exe` here.
11. **Fixed (2026-10-03):** re-running the installer used to rewrite `app\.env` from scratch and
    lose the settings added by hand (WhatsApp keys, backup bucket). It now keeps them. Tested
    in code only — the full build in item 10 is the real test. Until you have run it once,
    still keep a copy of `.env` before reinstalling.
12. **Server-side HEIC was not built** (iPhone photos). WhatsApp and iPhone Safari already send
    JPEG; details in PLAN §4 C3 notes. Say if officers run into it.

## From the loose ends F1–F6 (2026-10-03)

14. **Viewer accounts can now be issued.** A `viewer` reads the Dashboard, the Record and
    Status and can change nothing: no Report tab, "Read-only account" beside the name. Say if a
    viewer should also be kept out of Activities posting (today a viewer may post there, like
    every account).
15. **Small screens (768–896 px wide, e.g. a tablet held upright):** the Record now shows cards,
    as on a phone, instead of a table cut off at the edge. Say if you would rather have the
    table there.
16. **Nothing to do, for your information:** the Pending count in Activities now updates every
    minute; the Activities ZIP no longer stops at 4 GB.
