# ADR-0038 — Member accounts: officers sign in, for Activities only, unless the DC says more

**Status:** Accepted · 2026-10-01
**Decided by:** the owner, for the Deputy Commissioner Bajaur.
**Amends:** [ADR-0018](ADR-0018-control-room-only.md) (only the control room signs in) and
[ADR-0024](ADR-0024-no-department-holds-a-seat.md) (no department holds a seat) — narrowly:
other people may now sign in, but they get nothing operational by default.
**Extends:** [ADR-0032](ADR-0032-settings-is-its-own-panel.md) (roles + allow/deny overrides).
**Reversal cost:** Low — remove the role and its gate; no operational data depends on it.

## Context

The DC wants up to ~50 officers (Rescue, TMA, Health…) to have their own accounts, mainly to
upload their daily activity pictures ([ADR-0039](ADR-0039-activities.md)). There is no
department layer, and none must come back into the operational code.

Today every account without a seat is treated as a district control-room seat
(`api/lifecycle.ts` `seatOf`, `api/dashboard.ts` `viewerFor`, `api/server.ts` `requireSeat`),
and the `viewer` role is not enforced on any write. So an account created today — of **any**
role — can read every emergency, message the whole district and close incidents. Issuing
officer accounts on the current code would hand every one of them the control room.

## Decision

1. **A fifth role, `member`.** `owner`, `admin`, `operator` and `viewer` are unchanged.
2. **One gate, at the place the code reserved for it.** `requireSeat` (`api/server.ts`) —
   documented as *"the one place to re-tighten if account types ever diverge again"* — refuses
   a `member` on every route except Activities, their own password change, sign-out and the
   app shell. `seatOf` / `viewerFor` are never reached for a member, so the control room's
   behaviour does not change.
3. **Default Activities permissions** (new permissions in `domain/roles.ts`):

   | Role | Activities by default |
   |---|---|
   | `owner` (DC), `admin` (DNC) | everything: upload, see all, soft/hard delete and restore any post, departments, Pending list |
   | `operator` | upload, see all, hard-delete own posts |
   | `viewer` | upload, see all, hard-delete own posts |
   | `member` | upload, see **own** posts only, hard-delete own posts |

   Two rules hold for every role: **upload and deleting one's own post are always included**,
   and **the DC (owner) and DNC (admin) can allow or deny any of these per account** through
   the existing overrides.
4. **Operational access is a role change.** The DC makes a member an `operator` (the full
   control room) or back. A member promoted to operator keeps their posts and keeps uploading.
   There are no per-feature operational permissions — that would touch the incident, dispatch,
   WhatsApp and Record code, and is deferred until a need is proven.
5. **Creating accounts** (owner and admin only — the existing `accounts.create`):
   - Settings → Add account: Name, Post (new nullable `person.designation`), Phone, default
     Activity department, role (default `member`);
   - or from the contact list: "Give login", reusing the contact's own name, post and phone,
     so one person never appears twice.

   A temporary password is set and must be changed at first sign-in (existing behaviour).

### Implementation note (2026-10-02, B1)

`requireSeat` guarded only ten routes, so the gate is one level lower: `api/server.ts` imports
the session resolver as `resolveAnySession` and wraps it in a local `resolveSession` that throws
for a `member` (answered 403). Every operational route already authenticates through that name,
so the gate is **deny by default** — a route added later is closed to members without anyone
remembering. Only `/auth/me` (and, from Phase C, Activities) calls `resolveAnySession`;
`memberGate.test.ts` walks every route read from the router's source and counts those calls.
`requireSeat` refuses a member too. A stored role the code does not know is now read as
`member` (least privilege), not `viewer`. The client sends a member to `/activities.html`, a
page of its own that the service worker never answers with the shell.

## Rationale

Adding a role and closing one reserved gate is the smallest change that makes officer accounts
safe. Every operational path keeps running exactly as it does for the control room, because
those paths are simply never reached by a member.

## Consequences

### We gain
- Officer accounts the DC controls, without any department concept in the operational code.

### We give up
- Fine-grained operational permissions (e.g. "may dispatch but not close"). Role-level only.

### We must therefore also
- Add a permanent test that walks **every** route and proves a member is refused everywhere
  outside Activities (INV-05).
- Track the pre-existing gap: `viewer` is not enforced on operational writes. Do not issue
  viewer accounts until it is (PLAN.md §4).

## Alternatives considered

- **Issue accounts as they are today** — every account becomes the control room. Rejected.
- **Use `viewer` for officers** — not enforced, and would show them every emergency and every
  contact's number. Rejected.
- **Per-feature operational permissions** — touches dozens of existing call sites; deferred.

## How we would know this was wrong

The DC repeatedly promotes members to operator only to then wish they could not do one specific
thing (e.g. close emergencies). That is the signal to design per-feature permissions, in their
own ADR.
