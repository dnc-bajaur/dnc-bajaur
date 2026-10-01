/**
 * What is wrong with the district's configuration, right now — W-01.
 *
 * Not a health check. `/health` answers *is the server up*; this answers *would an emergency
 * reported in the next ten minutes actually reach a human*, which is a different question
 * with a much worse failure mode. Every finding here is a gap that is silent today and
 * expensive at 02:00.
 *
 * **It reports. It never fixes.** Everything it finds is either a decision for the district
 * (a post nobody has filled) or a fact somebody has to look at (two officers on one handset).
 * A sweep that quietly corrected things would destroy the evidence that anything was wrong,
 * which is the opposite of what this project does with gaps (ADR-0005).
 *
 * Findings carry a severity, and the scale is deliberately about **consequence**, not
 * tidiness:
 *
 *   `blocking` — an emergency will be lost or will reach nobody. Fix today.
 *   `serious`  — the system will work but somebody will be surprised. Fix this week.
 *   `note`     — real, and possibly fine. Somebody should have seen it.
 *
 * Read the queries as the specification: each one is a sentence about how the district can
 * be misconfigured, and the comment above it says what happens when it is.
 */

import type { Pool } from '../db/pool.js';

export type FindingSeverity = 'blocking' | 'serious' | 'note';

export interface Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  /** One sentence, in the district's terms, not the schema's. */
  readonly what: string;
  /** What it costs, stated concretely. Never "this may cause issues". */
  readonly consequence: string;
  readonly count: number;
  /** Up to ten, so the report is actionable without being a data dump. */
  readonly examples: readonly string[];
  // ⚠️ `examplesAre` is gone — ADR-0031, phase 4. Its one value was `'department'`, and the
  // console screen it deep-linked to (the department editor) went with ADR-0030. Every check's
  // examples are now post titles or numbers, which no screen opens directly.
}

export interface IntegrityReport {
  readonly asOf: string;
  readonly findings: readonly Finding[];
  readonly summary: {
    readonly blocking: number;
    readonly serious: number;
    readonly notes: number;
    readonly departments: number;
    readonly posts: number;
    readonly people: number;
  };
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocking', 'serious', 'note'];

interface Check {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly what: string;
  readonly consequence: string;
  readonly sql: string;
  /**
   * A second pass over the rows, in TypeScript, for a question SQL should not be asked.
   *
   * Exists for exactly one check today (M7-22) and is deliberately narrow. The alternative was
   * to express the learning threshold — 60% of a category's dispatches, at least five times —
   * as a `HAVING` clause, which would be **a second implementation of `proposalsFor`**. This
   * project has already paid for that mistake once: `docs/01-invariants.md` records that the
   * escalation rule is never duplicated in SQL, the query narrows candidates and
   * `checkEscalation` decides. Same shape, same rule.
   */
  readonly refine?: (
    pool: Pool,
    rows: readonly { readonly id: string | null; readonly label: string | null }[],
  ) => Promise<readonly { readonly id: string | null; readonly label: string | null }[]>;
}

/**
 * Every check, as data.
 *
 * A list rather than a function per check, for the same reason the authority rules are a
 * table (ADR-0003): somebody who is not a programmer should be able to read down this and
 * say "that one is wrong for Bajaur". Each query returns rows of `label`.
 */
const CHECKS: readonly Check[] = [
  {
    code: 'department-with-no-post',
    severity: 'blocking',
    what: 'Departments with no post at all',
    /**
     * **This one is real under every model the district has had, and it stayed real.**
     *
     * Two neighbouring findings — one about departments no signal reached, one about
     * departments nothing would pre-tick — were removed with routing (ADR-0022). Neither
     * survived the district taking assignment back by hand. This one only sharpened: the
     * control room *chooses* this department in the "who should know" list, is told the
     * message went, and nobody was ever reachable. That is the failure INV-03 exists to make
     * visible, and it is the one row on this screen worth acting on today.
     */
    consequence:
      'ADR-0030 removed departments, so this check can never fire and is kept as a shape only. ' +
      'What it asked — is there anybody behind this name — is now asked by vacant-post, which ' +
      'is the same question about the thing the district actually picks from.',
    // ⚠️ Returns nothing without touching the database. The table is gone (migration 0039), so
    // the old query would throw and take the whole sweep — every other check with it — down.
    sql: `SELECT NULL::text AS label WHERE false`,
  },
  {
    code: 'no-administration',
    severity: 'blocking',
    what: 'The district has no administrative office',
    consequence:
      'Nobody can set deadlines, create departments or assign an unheld emergency. ADR-0010 ' +
      'says two offices hold the district; this reports when there are none.',
    // ADR-0030 — the tick is on the CONTACT now, so this asks the seat. Still `blocking`, and
    // it matters more than it did: with the department gone this column is the ONLY thing
    // deciding who may issue an advisory, and nothing fails at the moment nobody carries it.
    sql: `SELECT 'no contact is marked as the DC Office or AC Headquarter' AS label
           WHERE NOT EXISTS (
                   SELECT 1 FROM seat
                    WHERE is_administration AND retired_at IS NULL
                 )`,
  },
  {
    code: 'vacant-post',
    severity: 'serious',
    what: 'Posts nobody currently holds',
    consequence:
      'An alert addressed to one is recorded as failed rather than delivered. Correct ' +
      'behaviour, and still a person who has not been told.',
    sql: `SELECT s.title AS label
            FROM seat s
           WHERE s.retired_at IS NULL
             AND NOT EXISTS (
                   SELECT 1 FROM duty_assignment da
                    WHERE da.seat_id = s.seat_id AND da.to_at IS NULL
                 )
           ORDER BY 1`,
  },
  {
    code: 'placeholder-number',
    severity: 'serious',
    what: 'Posts held by somebody with a stand-in number',
    consequence:
      'The post looks filled and cannot be reached. Nothing is ever dialled at these ' +
      'numbers — see R-01.',
    sql: `SELECT s.title || ' (' || p.full_name || ')' AS label
            FROM person p
            JOIN duty_assignment da ON da.person_id = p.person_id AND da.to_at IS NULL
            JOIN seat s ON s.seat_id = da.seat_id
           WHERE p.placeholder AND p.removed_at IS NULL
           ORDER BY 1`,
  },
  {
    code: 'unregistered-department',
    severity: 'serious',
    what: 'Departments created by the migration backfill, never named by anybody',
    consequence:
      'These were seats pointing at a department id that did not exist when migration 0005 ' +
      'added the foreign key. ADR-0030 removed the registry they were gaps in, so this can ' +
      'never fire again.',
    // ⚠️ Returns nothing without touching the database — see department-with-no-post above.
    sql: `SELECT NULL::text AS label WHERE false`,
  },
  {
    code: 'account-without-post',
    severity: 'serious',
    what: 'People who can sign in but hold no post',
    consequence:
      'They can authenticate and can do nothing — correct (ADR-0004), and confusing enough ' +
      'to be reported as a broken system. Either give them a post or disable the account.',
    sql: `SELECT p.full_name AS label
            FROM person p
           WHERE p.password_hash IS NOT NULL
             AND p.disabled_at IS NULL
             AND p.removed_at IS NULL
             AND NOT EXISTS (
                   SELECT 1 FROM duty_assignment da
                    WHERE da.person_id = p.person_id AND da.to_at IS NULL
                 )
           ORDER BY p.full_name`,
  },
  {
    code: 'shared-handset',
    severity: 'note',
    what: 'One number listed against more than one person',
    consequence:
      'Ordinary here — an office handset covering two posts (Q-19). It is also exactly the ' +
      'shape of a mistyped digit, and nothing in the data tells the two apart.',
    sql: `SELECT string_agg(full_name, ' / ' ORDER BY full_name) AS label
            FROM person
           WHERE removed_at IS NULL
           GROUP BY phone
          HAVING count(*) > 1
           ORDER BY 1`,
  },
  /**
   * **`open-unassigned` was here and was removed on 2026-08-06, by the owner.**
   *
   * It counted open emergencies routing had matched to nobody, as `serious`, and its own
   * consequence line still said they *"sit on both administrative dashboards"* — the two-office
   * phrasing of a model the control room replaced.
   *
   * Two reasons, and the second is the one that generalises:
   *
   * **It was the third place saying one thing.** The board carries it, the dashboard's
   * `Nobody told` counter carries it better, and this said it a third time in a louder colour.
   * The dashboard's `Unassigned` tile went the same day for the same reason: two alarms for one
   * situation is how a district learns to read neither.
   *
   * **And it did not belong in this file at all.** Read the header: this sweep answers *would
   * an emergency reported in the next ten minutes reach a human* — it is about **configuration**,
   * about posts and numbers and signals. An open emergency is live operational state. It was the
   * only check here that was not a settings fault, and mixing the two means somebody scanning
   * this screen for things they can *fix* has to skip a row that only time fixes.
   *
   * Nothing about the underlying fact changed: the empty `routed` event is still appended, and
   * *we looked and found nobody* is still a recorded fact rather than an inference (ADR-0005).
   */

  {
    code: 'tier-disagrees-with-tick',
    severity: 'blocking',
    what: 'Posts whose tier disagrees with the administration tick on the seat',
    consequence:
      'A district-tier post that nothing ticked can read every incident in Bajaur. ' +
      'Migration 0042 derives tier by trigger from `is_administration`, so this should be ' +
      'impossible — if it fires, something bypassed the trigger and the read model is wider ' +
      'than anybody intended.',
    sql: `SELECT s.title || ' (' || s.tier || ')' AS label
            FROM seat s
           WHERE s.tier <> CASE WHEN s.is_administration THEN 'district' ELSE 'post' END
           ORDER BY 1`,
  },
];

/**
 * Run every check.
 *
 * Sequential rather than parallel, deliberately: this is a report somebody runs while
 * looking at it, not a request path, and a burst of eleven scans is a rude thing to do to a
 * single-node district server that is also handling emergencies (ADR-0007).
 */
export async function sweep(pool: Pool, options: { now?: string } = {}): Promise<IntegrityReport> {
  const findings: Finding[] = [];

  for (const check of CHECKS) {
    const { rows } = await pool.query<{ id?: string | null; label: string | null }>(check.sql);
    // Refined before the emptiness test, so a check whose every row is explained away
    // disappears from the report rather than appearing with a count of zero.
    const kept =
      check.refine === undefined
        ? rows
        : await check.refine(
            pool,
            rows.map((r) => ({ id: r.id ?? null, label: r.label })),
          );
    if (kept.length === 0) continue;

    findings.push({
      code: check.code,
      severity: check.severity,
      what: check.what,
      consequence: check.consequence,
      count: kept.length,
      examples: kept.slice(0, 10).map((r) => r.label ?? '(unnamed)'),
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );

  const totals = await pool.query<{ departments: string; posts: string; people: string }>(
    // ADR-0030 — `departments` is a literal zero. The field stays on the reply so the console's
    // own overview does not change in this commit; the number it prints is now true.
    `SELECT 0 AS departments,
            (SELECT count(*) FROM seat WHERE retired_at IS NULL)       AS posts,
            (SELECT count(*) FROM person WHERE removed_at IS NULL)     AS people`,
  );

  return {
    asOf: options.now ?? new Date().toISOString(),
    findings,
    summary: {
      blocking: findings.filter((f) => f.severity === 'blocking').length,
      serious: findings.filter((f) => f.severity === 'serious').length,
      notes: findings.filter((f) => f.severity === 'note').length,
      departments: Number(totals.rows[0]?.departments ?? 0),
      posts: Number(totals.rows[0]?.posts ?? 0),
      people: Number(totals.rows[0]?.people ?? 0),
    },
  };
}

/** The report as text, for a terminal or a runbook. */
export function formatReport(report: IntegrityReport): string {
  const lines: string[] = [];
  const s = report.summary;

  lines.push(`District configuration sweep — ${report.asOf}`);
  lines.push(
    `${String(s.departments)} departments · ${String(s.posts)} posts · ${String(s.people)} people`,
  );
  lines.push(
    `${String(s.blocking)} blocking · ${String(s.serious)} serious · ${String(s.notes)} notes`,
  );
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('Nothing to report. Every department has a post, a signal and somebody to call.');
    return lines.join('\n');
  }

  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.what} — ${String(f.count)}`);
    lines.push(`  ${f.consequence}`);
    for (const example of f.examples) lines.push(`    · ${example}`);
    if (f.count > f.examples.length) {
      lines.push(`    … and ${String(f.count - f.examples.length)} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
