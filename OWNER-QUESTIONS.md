# Owner questions — for the morning

Things that need you. Work did not stop for any of them: where a choice was needed, the safest
reversible default was taken and is written here so you can change it. Delete an item once
answered.

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

## The "How to use" guide is out of date (found 2026-10-03, while translating it)

7. The guide inside the app still describes the original deployment: it says *departments have
   no logins* (Bajaur now gives officers `member` logins for Activities), it never mentions
   **Activities** or the WhatsApp → Activities path, and it speaks of "all 79 departments".
   I translated it faithfully as it stands. **Should I rewrite it for Bajaur** (add an
   Activities chapter, drop what no longer applies)? I will not invent Bajaur facts in it.

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
11. ⚠️ **Inherited, worth knowing:** re-running the installer rewrites `app\.env` from scratch,
    so settings added to it by hand afterwards (WhatsApp keys, backup bucket) would be lost on
    a reinstall. Keep a copy of `.env` before reinstalling. I did not change this.
12. **Server-side HEIC was not built** (iPhone photos). WhatsApp and iPhone Safari already send
    JPEG; details in PLAN §4 C3 notes. Say if officers run into it.
