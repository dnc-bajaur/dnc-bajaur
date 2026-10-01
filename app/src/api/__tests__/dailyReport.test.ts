/**
 * One day's report — M9-46…51.
 *
 * Real database, real HTTP, real fold. What is pinned here is the set of things a report gets
 * wrong quietly:
 *
 * **The day boundary** (M9-49). Bajaur is UTC+05:00, so the start of 13 August locally is
 * 12 August at 19:00 UTC. A report keyed to an instant files five hours of every evening under
 * the wrong day, and `reports.ts` has already paid for that lesson once. Test 5 puts an
 * emergency inside that five-hour window and asserts which report it lands in.
 *
 * **The empty day** (M9-51). A blank file is a fault somebody chases; a sentence is an answer.
 *
 * **The scope** (M9-50). A report is a file that gets emailed onward, which makes it the worst
 * place in the system for a leak to appear.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { saveGroup } from '../../db/groupStore.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { districtDate } from '../../domain/districtTime.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the daily report', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let controlToken: string;
  let otherToken: string;
  let rescueSeat: string;
  let rescueDept: string;
  let today: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (day ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (day ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (day ${RUN})`);
    const rescue = rescueDept;
    rescueSeat = (
      await seedActor(pool, { title: `Duty Officer (day ${RUN})`, departmentId: rescue })
    ).seatId;

    // A department with nothing of its own on this day, for the scoping test.
    const quiet = await seedDepartment(pool, `Quiet Wing (day ${RUN})`);
    otherToken = (
      await seedActor(pool, { title: `Wing Officer (day ${RUN})`, departmentId: quiet })
    ).token;

    today = districtDate(new Date());
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function report(token: string, query = ''): Promise<Response> {
    return fetch(`${base}/reports/daily${query}`, { headers: authHeaders(token) });
  }

  it('1. an empty day says so, in a sentence — never a blank page', async () => {
    // A day nothing happened on, chosen far enough back that nothing this suite creates
    // can reach it.
    const page = await report(controlToken, '?date=2019-03-04');
    expect(page.status).toBe(200);

    const html = await page.text();
    expect(html).toContain('Nothing was recorded');
    // Still a whole document: headings, sections, the lot. A reader must be able to tell the
    // difference between "nothing happened" and "the export failed".
    expect(html).toContain('<h1>Daily report');
    expect(html).toContain('Emergencies');
  });

  it('2. the empty day is a sentence in the CSV too, not a zero-byte file', async () => {
    const csv = await report(controlToken, '?date=2019-03-04&format=csv');
    const bytes = new Uint8Array(await csv.arrayBuffer());

    expect(csv.headers.get('content-disposition')).toContain('daily-2019-03-04.csv');
    /**
     * The BOM the district's other exports carry, so Excel opens Urdu and Pashto names
     * correctly rather than as mojibake.
     *
     * Asserted on the **bytes**. `Response.text()` decodes UTF-8 and strips the BOM per the
     * encoding standard, so a `startsWith` check on the string is a check that can never pass —
     * and would have been "fixed" by deleting the BOM, which is the mojibake back.
     */
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain('Nothing was recorded on this day.');
  });

  it('3. an emergency appears, with its stage and who was told', async () => {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: 'fire', severity: 'high', description: `day ${RUN}` }),
      })
    ).json()) as { incidentId: string };

    /**
     * Routed **explicitly**, and that is the point of this line rather than an incidental
     * setup step.
     *
     * The first draft dispatched to a post and then asserted that Rescue appeared under
     * "Responsible". It passed, and it was passing for a reason the test did not control:
     * `dispatch-to` records who was *told*, which is a different fact from who the emergency
     * is *routed to* — the department only appeared when the district's routing signals
     * happened to match "fire". A test that asserts a fact it did not establish is a test that
     * goes red on a day somebody edits a signal, in a file about reports.
     */
    /**
     * **Route, or reassign — kept, though only one of them can happen now.**
     *
     * Intake used to run an automatic routing pass, so an emergency could already be routed by
     * the district's own signals before this line ran, and `route` would answer 409 *"already
     * routed; use reassign"*. The first draft called `route`, ignored the 409, and asserted a
     * department that appeared only when no signal happened to match — a test passing on
     * configuration it did not own, which is the same shape as the fixtures §5 warns about.
     *
     * ADR-0022 removed the automatic pass, so nothing routes this before the line below and
     * the 409 branch cannot fire from intake. The fallback stays because the shape of the
     * mistake has not gone anywhere: the 409 is still correct if anything else in the suite
     * ever assigns first, and a test that assumes it owns an incident it did not create is
     * exactly what this comment exists to stop being written again.
     */
    const routed = await fetch(`${base}/incidents/${created.incidentId}/route`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ departmentIds: [rescueDept], reason: `day ${RUN}` }),
    });
    if (routed.status === 409) {
      const moved = await fetch(`${base}/incidents/${created.incidentId}/reassign`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ departmentIds: [rescueDept], reason: `day ${RUN}` }),
      });
      expect(moved.status, 'neither route nor reassign was accepted').toBe(200);
    } else {
      expect(routed.status).toBe(200);
    }
    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: rescueSeat }] }),
    });

    const html = await (await report(controlToken, `?date=${today}`)).text();
    expect(html).toContain('fire');
    // The district's four words, from the same table the board uses (M9-25).
    expect(html).toMatch(/Issued|Acknowledged|Responded|Resolved/);

    /**
     * ⚠️ **IT ASSERTED THE DEPARTMENT'S NAME HERE UNTIL ADR-0030, AND WHAT REPLACES IT IS THE
     * REGRESSION THAT WOULD OTHERWISE HAVE SHIPPED.**
     *
     * The name came from a registry migration 0039 dropped, and the renderer's `?? id` fallback
     * — correct while a department could vanish from a registry that still existed — would have
     * printed thirty-six characters of hexadecimal in the *Responsible* column of the morning
     * report. On paper, filed, read by somebody who was not there. So an unnameable id is
     * dropped now, as `performance.ts` already drops one, and this asserts the outcome rather
     * than the mechanism: **no uuid reaches the page.**
     */
    const table = /<table[\s\S]*<\/table>/.exec(html)?.[0] ?? '';
    expect(table).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('4. leads with what is wrong, because one line is what most people read', async () => {
    const html = await (await report(controlToken, `?date=${today}`)).text();

    /**
     * The emergency above was dispatched and nobody has responded to it. A summary that opened
     * with "1 emergency" and buried that would be technically complete and practically silent.
     *
     * The sentence itself was reworded 2026-09-04 (`domain/dailyReport.ts`'s `summarise`) — this
     * asserts the same underlying fact, in its current words.
     */
    const summary = /<p class="summary">([^<]*)<\/p>/.exec(html)?.[1] ?? '';
    expect(summary).toContain('nobody responded to');
    /**
     * And the row itself carries **a** gap sentence, beside the incident it is about — INV-03's
     * rule that a failure is spelled out where it belongs rather than counted in a corner.
     *
     * **Which** sentence is not this test's to decide, and asserting one was a mistake it got
     * away with only on a dirty database. `gapOf` returns the most actionable gap first: with
     * no WhatsApp account configured the dispatched attempt is unmet, so the row correctly says
     * *"1 of 1 were not reached"* rather than *"nobody acknowledged it"*. Both are true; the
     * first is the one to act on.
     */
    expect(html).toMatch(/nobody was told|were not reached|nobody acknowledged it/);
  });

  it('5. files an emergency by the DISTRICT’s day, not the server’s — M9-49', async () => {
    /**
     * 19:30 UTC on 12 August is **01:30 on 13 August in Bajaur**. A report keyed to an instant
     * would file it under the 12th; the district would open the 13th's report and find their
     * own night missing. `reports.ts` shipped exactly this bug once.
     */
    const id = randomUUID();
    await pool.query(
      `INSERT INTO incident_event
         (event_id, incident_id, occurred_at, recorded_at, client_seq, actor_person_id,
          actor_seat_id, source_channel, type, payload)
       VALUES ($1, $2, '2026-08-12T19:30:00.000Z', '2026-08-12T19:30:00.000Z', 1, NULL, $3,
               'web', 'reported', $4)`,
      [
        randomUUID(),
        id,
        rescueSeat,
        JSON.stringify({
          reportId: randomUUID(),
          category: 'flood',
          severity: 'high',
          description: `boundary ${RUN}`,
        }),
      ],
    );

    const thirteenth = await (await report(controlToken, '?date=2026-08-13&format=csv')).text();
    const twelfth = await (await report(controlToken, '?date=2026-08-12&format=csv')).text();

    expect(thirteenth, 'the district’s own night is missing from its own report').toContain(
      'flood',
    );
    expect(twelfth).not.toContain(`boundary ${RUN}`);
  });

  it('6. the report is the district’s, and still carries only what the reader may read', async () => {
    const mine = await (await report(otherToken, `?date=${today}`)).text();

    /**
     * 🔴 **THE HALF THAT MUST NOT MOVE, AND IT IS THE FIRST LINE.**
     *
     * The fire above belongs to Rescue. A wing officer's report must not carry it, and that is
     * `evaluateRead` running per incident — untouched by ADR-0029, which changed the paper's
     * title and one `WHERE` clause and nothing about who may read what. If this assertion ever
     * goes green by widening rather than by scoping, a report is a file that gets emailed
     * onward and the leak leaves the building with it.
     */
    expect(mine).not.toContain(`Rescue (day ${RUN})`);

    /**
     * ⚠️ **THIS ASSERTION IS THE REVERSE OF WHAT IT WAS, AND THE OLD ONE WAS RIGHT WHEN WRITTEN.**
     *
     * M9-50 required the paper to name the reader's own department — *"Quiet Wing"* — so two
     * reports on one desk could not be mistaken for each other. That was correct under a model
     * where a department signed in.
     *
     * **ADR-0024 removed those accounts on 2026-08-22 and ADR-0029 removed the layer.** There is
     * one reader now, the control room, and one document. A scope derived from whoever printed
     * it is a report whose title changes per reader, which is the one property a document that
     * gets filed must not have — so it is **stated**, and the same words come out every time.
     */
    expect(mine).toContain('District Bajaur');
    expect(mine).not.toContain('Quiet Wing (day');
  });

  it('7. refuses a date that is not a date, rather than inventing one', async () => {
    const bad = await report(controlToken, '?date=2026-02-30');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('YYYY-MM-DD');
  });

  it('8. the printed page IS the page on screen — no second layout', async () => {
    const html = await (await report(controlToken, `?date=${today}`)).text();

    // ADR-0007 refuses a PDF library. The print rules change only what paper cannot do; if a
    // second document ever appears, this is where it will show up first.
    expect(html).toContain('@media print');
    expect(html).toContain('break-inside: avoid');
    // Self-contained: no script, no external stylesheet. It is opened on an office machine
    // with a fussy connection and the one thing it must do is render.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
  });

  it('9. orders deterministically, so two people can diff the same day', async () => {
    const a = await (await report(controlToken, `?date=${today}&format=csv`)).text();
    const b = await (await report(controlToken, `?date=${today}&format=csv`)).text();

    // Everything but the generated-at line, which is the one thing that must differ.
    const strip = (s: string): string =>
      s
        .split('\r\n')
        .filter((line) => !line.includes('Generated '))
        .join('\r\n');

    expect(strip(a)).toBe(strip(b));
  });

  it('10. refuses a caller holding no seat', async () => {
    const nobody = await fetch(`${base}/reports/daily`);
    expect(nobody.status).toBe(401);
  });

  /**
   * **`?format=json` — the same day, for the app to draw itself (M11-27, server half).**
   *
   * The district asked to read its reports **inside** the software rather than only by
   * downloading them. This is the half that ships alone: it emits nothing into `web/dist`, so no
   * `CACHE` bump and nothing on any screen behaves differently until a client renders it.
   *
   * ⚠️ **What is really under test is that the three forms are ONE report.** Three renderers over
   * one object is the whole point — `domain/dailyReport.ts` writes `summary` itself precisely so
   * the printed page, the spreadsheet and a later screen cannot each summarise one day
   * differently. A JSON form built from a second fold, or reshaped on the way out, would be the
   * fourth instance of the fault this milestone keeps finding.
   */
  describe('11. the same day, as JSON, for the app to render (M11-27)', () => {
    it('answers with the report itself, and the summary the other two forms print', async () => {
      const res = await report(controlToken, '?date=2026-08-13&format=json');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);

      const body = (await res.json()) as {
        date: string;
        scope: string;
        summary: string;
        empty: boolean;
        totals: Record<string, number>;
        emergencies: unknown[];
        outstanding?: unknown[];
      };

      // The district's own day, as a name and never an instant (M9-49).
      expect(body.date).toBe('2026-08-13');
      expect(typeof body.scope).toBe('string');
      expect(typeof body.empty).toBe('boolean');
      expect(Array.isArray(body.emergencies)).toBe(true);

      /**
       * The lede is **byte-identical** to the one the printed page carries. Asserted against the
       * HTML rather than against a string written here, because a literal in a test would pass
       * while the two renderers drifted apart — which is what it exists to prevent.
       */
      const html = await (await report(controlToken, '?date=2026-08-13')).text();
      expect(body.summary.length).toBeGreaterThan(0);
      expect(html).toContain(body.summary);

      // Every figure the report is answerable for is present, and none of them is invented here.
      for (const key of [
        'emergencies',
        'communications',
        'advisories',
        'availability',
        'unacknowledged',
        'unresolved',
        'nobodyTold',
        'unmet',
      ]) {
        expect(typeof body.totals[key], key).toBe('number');
      }
    });

    /**
     * ⚠️ **M11-29: nothing that downloads today stops downloading.** The JSON form is an
     * addition, not a replacement — the HTML page is what `Print → Save as PDF` produces
     * (ADR-0007 refuses a PDF library so the printed page *is* the page that was read), and the
     * CSV is what the district already emails onward.
     */
    it('takes nothing away from the page or the spreadsheet', async () => {
      const html = await report(controlToken, '?date=2026-08-13');
      expect(html.status).toBe(200);
      expect(html.headers.get('content-type')).toMatch(/text\/html/);
      // No `content-disposition`: the page opens, it does not save.
      expect(html.headers.get('content-disposition')).toBeNull();

      const csv = await report(controlToken, '?date=2026-08-13&format=csv');
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
      expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="daily-/);
    });

    it('scopes and refuses exactly as the other two forms do', async () => {
      // Same session rule, same seat rule — there is no separate report permission to fall out
      // of step with the incident's own authority (INV-05).
      const nobody = await fetch(`${base}/reports/daily?format=json`);
      expect(nobody.status).toBe(401);

      // A malformed day is refused rather than answered with a different one.
      const bad = await report(controlToken, '?date=not-a-day&format=json');
      expect(bad.status).toBe(400);
    });
  });

  /**
   * **The group a dispatch expanded, named beside the count — Case 3, 2026-09-10.**
   *
   * The daily line has no per-recipient list to partition — `told` is already a bare count — so
   * the group's name rides beside it in its own column, on the JSON, the CSV and nowhere else
   * (the printed page has no recipient count at all to attach it to). `[]` / blank for an
   * incident dispatched only by hand.
   */
  describe('13. the group a dispatch expanded, on the daily line (Case 3)', () => {
    it('names the group in the JSON row and the CSV column; a hand dispatch carries neither', async () => {
      const groupName = `All Tehsildars ${RUN}`;
      const a = await seedActor(pool, { title: `Tehsildar One (day ${RUN})` });
      const b = await seedActor(pool, { title: `Tehsildar Two (day ${RUN})` });
      const saved = await saveGroup(
        pool,
        {
          name: groupName,
          members: [
            { kind: 'post', id: a.seatId },
            { kind: 'post', id: b.seatId },
          ],
        },
        { seatId: null, personId: null },
      );
      if (!saved.ok) throw new Error(`saveGroup: ${saved.problem.kind}`);

      const grouped = (await (
        await fetch(`${base}/incidents`, {
          method: 'POST',
          headers: authHeaders(controlToken),
          body: JSON.stringify({ category: `grouped-${RUN}`, severity: 'high' }),
        })
      ).json()) as { incidentId: string };
      await fetch(`${base}/incidents/${grouped.incidentId}/dispatch-to`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ groups: [saved.group.groupId], reason: 'every tehsildar' }),
      });

      const byHand = (await (
        await fetch(`${base}/incidents`, {
          method: 'POST',
          headers: authHeaders(controlToken),
          body: JSON.stringify({ category: `byhand-${RUN}`, severity: 'high' }),
        })
      ).json()) as { incidentId: string };
      await fetch(`${base}/incidents/${byHand.incidentId}/dispatch-to`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ targets: [{ kind: 'post', id: a.seatId }] }),
      });

      const body = (await (await report(controlToken, `?date=${today}&format=json`)).json()) as {
        emergencies: { category: string; toldGroups: string[] }[];
      };
      const groupedRow = body.emergencies.find((r) => r.category === `grouped-${RUN}`);
      const handRow = body.emergencies.find((r) => r.category === `byhand-${RUN}`);
      expect(groupedRow?.toldGroups).toEqual([groupName]);
      expect(handRow?.toldGroups).toEqual([]);

      const csv = await (await report(controlToken, `?date=${today}&format=csv`)).text();
      expect(csv).toContain('told via group');
      expect(csv).toContain(groupName);
    });
  });

  it('12. carries the district’s official letterhead, above its own title', async () => {
    const html = await (await report(controlToken, `?date=${today}`)).text();

    // The masthead the district files this under — the Deputy Commissioner’s office,
    // not only the software’s name.
    expect(html).toContain('Office of the Deputy Commissioner');
    expect(html).toContain('Khyber Pakhtunkhwa');
    expect(html).toContain('DNC Bajaur');

    // The seal travels inside the document — ADR-0007, the page renders with no network.
    expect(html).toContain(
      'class="letterhead-seal" alt="Seal of the Deputy Commissioner, Bajaur" src="data:image/jpeg;base64,',
    );
    // Still self-contained (mirrors test 8).
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');

    // Above the report title, not instead of it.
    expect(html.indexOf('class="letterhead"')).toBeGreaterThan(-1);
    expect(html.indexOf('class="letterhead"')).toBeLessThan(html.indexOf('<h1>Daily report'));
  });

  it('13. the letterhead is the printed page only — the CSV keeps its own header', async () => {
    const csv = await (await report(controlToken, `?date=${today}&format=csv`)).text();
    expect(csv).not.toContain('Office of the Deputy Commissioner');
    expect(csv).not.toContain('data:image/jpeg');
    expect(csv).toContain('Daily report — District Bajaur');
  });
});
