/**
 * What the system fills in when nobody said, and the name it uses for it.
 *
 * These lived in `api/lifecycle.ts` because intake was the only thing that needed them.
 * More than one layer needs them — a placeholder must never read as an assessment — and a
 * domain module importing from the API layer would have the dependency backwards. So they
 * moved down to where both can reach them.
 *
 * Both constants are the **same string** on purpose. `unknown` is not a category and not a
 * severity level; it is the system saying *nobody told us*, in the one place a value is
 * required. Everything downstream keys off that: ADR-0009 keeps it out of severity
 * aggregates, and every screen that shows a category renders it as the absence it is.
 */

import type { Severity } from './events.js';

/** What intake records when a caller gave no category. See `api/lifecycle.ts` → `intake`. */
export const ASSUMED_CATEGORY = 'unknown';

/**
 * The severity an unstated report is given: none. See ADR-0009.
 *
 * An earlier version guessed `high` and recorded `assumed: ['severity']` alongside it. The
 * reasoning was sound — `low` lets an unassessed emergency sink below routine work, INV-04
 * by the back door — but it has one fatal property: **on a screen, an assumption is
 * indistinguishable from an assessment.** The urgency now lives in the SLA target for
 * `unknown`, which is the `high` deadline, so an unassessed report still reaches a human
 * fast without the record claiming anyone judged it.
 */
export const ASSUMED_SEVERITY: Severity = 'unknown';
