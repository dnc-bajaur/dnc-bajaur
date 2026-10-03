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

## ⚠️ Possible other-district name in the code (found 2026-10-03)

6. The name **"Nawaz"** appears in this repository as an example officer name and in old notes:
   `db/migrations/0020_dispatch.sql:53`, `src/api/contacts.ts:275`, `src/jobs/whatsappChannel.ts:764`,
   `src/domain/notifications.ts:42,184`, `src/domain/events.ts:120,454`,
   `src/domain/__tests__/notifications.test.ts` (test id `person-nawaz`),
   `src/api/__tests__/board.test.ts:354`, `web/src/__tests__/duplicates.test.ts:21`, and
   `web/src/sw.ts:1027-1048` ("nawaz-ae's parallel … change" — looks like the other project's
   branch names). **If this is a real person or name from the other district, say so and I will
   replace every one with a neutral placeholder** (a migration file's comment included — comments
   in an applied migration can be edited safely). I did not change them on my own because most
   are only illustrative and the change touches many files. The one place a user could see it —
   the "How to use" guide's example screen — now says "Duty Officer" instead.

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
