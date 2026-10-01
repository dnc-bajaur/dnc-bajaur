/**
 * "Who should know?" and "Who was told", as their own file — M7-26, and the M1 gate made me.
 *
 * ## Why this is not in the shell
 *
 * The shell is what a **field officer** downloads at a scene on a weak connection, and the M1
 * gate holds it to 160 KB from `docs/00-thesis.md`. M7 pushed it to 161 KB: the recipient
 * picker grew groups (M7-14), learned proposals with the sentence that explains each one
 * (M7-18), and the control an operator uses to record what they were told on the telephone
 * (M7-08).
 *
 * **The answer is not a bigger number.** Every one of those is control-room work. Under
 * ADR-0018 nobody outside the control room signs in at all, so an officer at a road accident
 * will never open this panel — and a control room is a laptop on a desk with the district's
 * own line, which is the connection this file is fetched over.
 *
 * Same trade the post-incident report, search and the office screens already made, for the same
 * reason and with the same rule: **lazy-loading is for screens somebody chooses to open, never
 * for the one they land on.** Intake stays in the shell, and so does the outbox under it — an
 * emergency can still be reported with no network and no connection to this file.
 *
 * ## Why one bundle and not two
 *
 * `renderWhoWasTold` is the receiving half of `mountDispatch`, and they already share this
 * module's types and its `make` helper. Two entry points would put a copy of both in each file.
 */

/**
 * ## And why the take-action panel is here too — Phase 8c
 *
 * Same argument, one screen along. *Follow up · escalate · mark resolved · close* is control-room
 * work by definition: an officer at a road accident never chases anybody, and every one of the
 * four acts reaches across the network anyway, so nothing is lost by fetching it. The shell stood
 * at **160,498 bytes of 163,840** before this phase — 3,342 bytes of headroom — and the panel's
 * markup and confirmations are several times that. **The budget is not the thing that moves.**
 *
 * It joins this bundle rather than becoming a fourth entry point because it is drawn on the same
 * screen as `renderWhoWasTold`, by the same fetch, from the same `make` helper. A file of its own
 * would put a second copy of that helper on the wire and add a second thing that can be
 * half-loaded on a bad connection.
 */
export { mountDispatch, renderTakeAction, renderWhoWasTold } from './dispatch.js';
export type {
  ActionKind,
  ActionOutcome,
  DispatchPanel,
  RecordOutcome,
  TakeActionState,
  ToldEntry,
} from './dispatch.js';
