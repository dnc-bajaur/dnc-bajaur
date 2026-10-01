/**
 * The contact list — ADR-0029, over HTTP, against a real PostgreSQL.
 *
 * The district asked for one thing and said it plainly:
 *
 *   > *"Mujhe simple phone ki tarha contact add karne ka option chahiye, jis mein main Name,
 *   >  phone, post/designation de sakta hoon."*
 *
 * So most of this file is about the three fields and the two refusals. The refusals are the
 * part worth keeping, because both of them fail silently if they are ever removed:
 *
 * - **A duplicate phone number.** The district's own rule (*"just same phone number pehle se
 *   save ho to phir ye msg aana chahiye"*): two contacts on one handset are a mistyped digit.
 *   Sharing a designation is fine — *"AC Salarzai"* and *"TMO Salarzai"* are two real people.
 * - **Removing the last administration tick** leaves a district in which nobody can issue an
 *   advisory, edit the directory or maintain a group. Nothing fails at the moment it is done;
 *   the first person to find out is the control room at 02:00.
 *
 * ## Why the last tick is guarded HERE and not in migration 0038
 *
 * O-40. Migration `0031` refused to run when the district's data contradicted it, correctly —
 * and because migrations run at boot, the refusal served 502 for 34 minutes across ~98
 * restarts. A guard whose only way of speaking is to kill the service is not a guard. This one
 * answers an HTTP request, which is an error message.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/**
 * A fresh 11-digit `03…` number per call. The phone is unique across live contacts now
 * (the district's rule), and the local test database is never reset — hardcoded numbers
 * would collide with an earlier run and the first `add` in a test would 409, not 201.
 */
let phoneSeq = Math.floor(Math.random() * 900_000_000);
const newPhone = (): string => `03${String((phoneSeq += 1)).padStart(9, '0')}`;

interface Contact {
  seatId: string;
  personId: string;
  fullName: string;
  designation: string;
  phone: string;
  isAdministration: boolean;
}

describe.skipIf(dbUrl === undefined)('the contact list (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  /** The control room. Everything here is theirs to do. */
  let dcToken: string;
  /** Test 7 needs it: since ADR-0030 the caller's own seat is where their authority lives. */
  let dcSeatId: string;
  /** An ordinary officer, so "only the two offices" can be told from "anybody signed in". */
  let wingToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (contacts ${RUN})`);
    const dc = await seedActor(pool, {
      title: `DC (contacts ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });
    dcToken = dc.token;
    dcSeatId = dc.seatId;

    const wingDept = await seedDepartment(pool, `Quiet Wing (contacts ${RUN})`);
    wingToken = (
      await seedActor(pool, { title: `Wing Duty (contacts ${RUN})`, departmentId: wingDept })
    ).token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function add(
    token: string,
    fields: Partial<Record<'fullName' | 'designation' | 'phone', string>> & {
      isAdministration?: boolean;
    },
  ): Promise<Response> {
    return call('POST', '/roster/contacts', token, fields);
  }

  it('1. adds a contact from three fields, and hands it straight back', async () => {
    const phone = newPhone();
    const res = await add(dcToken, {
      fullName: `Noor Rahman (${RUN})`,
      designation: `District Emergency Officer (${RUN})`,
      phone,
    });
    expect(res.status).toBe(201);

    const contact = (await res.json()) as Contact;
    expect(contact.fullName).toBe(`Noor Rahman (${RUN})`);
    expect(contact.designation).toBe(`District Emergency Officer (${RUN})`);
    expect(contact.phone).toBe(phone);
    expect(contact.isAdministration).toBe(false);

    /**
     * 🔴 **THE HOLDER IS THE POINT, AND IT IS WHY THIS IS ONE TRANSACTION.**
     *
     * A seat written without its duty assignment is a **vacancy** — precisely what the district
     * has just asked to stop seeing — and it would look like a successful add on every screen.
     * The list is the only place that difference shows, so the list is where it is asserted.
     */
    const list = (await (await call('GET', '/roster/contacts', dcToken)).json()) as {
      contacts: Contact[];
      editable: boolean;
    };
    const mine = list.contacts.find((c) => c.seatId === contact.seatId);
    expect(mine, 'the contact was created and does not appear in the list').toBeDefined();
    expect(mine?.fullName).toBe(`Noor Rahman (${RUN})`);
  });

  it('2. allows a second contact under the same designation, and refuses a repeated phone', async () => {
    const designation = `SP Traffic (${RUN})`;
    const phone = newPhone();
    const first = await add(dcToken, {
      fullName: `Fazal Ud Din (${RUN})`,
      designation,
      phone,
    });
    expect(first.status).toBe(201);

    // The district asked for this: *"same designation ki upar chahe to kitne bhi contacts add
    // ho sakte hain"*. AC Salarzai and TMO Salarzai are two officers, not one.
    const sameDesignation = await add(dcToken, {
      fullName: `Somebody Else (${RUN})`,
      designation,
      phone: newPhone(),
    });
    expect(sameDesignation.status).toBe(201);

    // The phone is what is unique — and the same number written with a country code still
    // collides, because only the last ten digits are compared.
    const spaced = `+92 ${phone.slice(1, 4)} ${phone.slice(4)}`;
    const samePhone = await add(dcToken, {
      fullName: `Third Officer (${RUN})`,
      designation: `A Different Post (${RUN})`,
      phone: spaced,
    });
    expect(samePhone.status).toBe(409);
    expect(((await samePhone.json()) as { error: string }).error).toContain(
      'phone number already exists',
    );
  });

  it('3. refuses a contact with no number, rather than creating a vacancy', async () => {
    const res = await add(dcToken, {
      fullName: `No Number (${RUN})`,
      designation: `No Number Post (${RUN})`,
    });

    /**
     * ⚠️ **This is NOT the same refusal as a vacancy, and the wording says so.**
     *
     * Four of Bajaur's contacts genuinely hold a named officer whose number was never recorded
     * (R-01, ADR-0029 §3) — including Rescue 1122's District Emergency Officer. Those exist
     * because somebody could not find the number, never because a form let it through empty.
     */
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('do not have it yet');
  });

  it('4. edits any of the three fields in one call', async () => {
    const created = (await (
      await add(dcToken, {
        fullName: `Before (${RUN})`,
        designation: `Editable Post (${RUN})`,
        phone: newPhone(),
      })
    ).json()) as Contact;

    const nextPhone = newPhone();
    const res = await call('PATCH', `/roster/contacts/${created.seatId}`, dcToken, {
      fullName: `After (${RUN})`,
      phone: nextPhone,
    });
    expect(res.status).toBe(200);

    const edited = (await res.json()) as Contact;
    expect(edited.fullName).toBe(`After (${RUN})`);
    expect(edited.phone).toBe(nextPhone);
    // Untouched fields survive — the name and the number live on `person`, the designation on
    // `seat`, and the district does not know that and should not have to.
    expect(edited.designation).toBe(`Editable Post (${RUN})`);
  });

  it('5. removing a contact takes it off the list and leaves the row in the record', async () => {
    const created = (await (
      await add(dcToken, {
        fullName: `Removable (${RUN})`,
        designation: `Removable Post (${RUN})`,
        phone: newPhone(),
      })
    ).json()) as Contact;

    expect((await call('DELETE', `/roster/contacts/${created.seatId}`, dcToken)).status).toBe(200);

    const list = (await (await call('GET', '/roster/contacts', dcToken)).json()) as {
      contacts: Contact[];
    };
    expect(list.contacts.some((c) => c.seatId === created.seatId)).toBe(false);

    /**
     * 🔴 **RETIRED, NOT DELETED — and the district's word for it is still "delete".**
     *
     * They get removal: the row is off every list. The row itself stays because past incidents
     * name their seats, and a DELETE would either break those references or rewrite the record,
     * which ADR-0001 does not permit. Asserted against the database rather than the API,
     * because the API is the surface that is supposed to have stopped showing it.
     */
    const row = await pool.query<{ retired_at: string | null }>(
      'SELECT retired_at FROM seat WHERE seat_id = $1',
      [created.seatId],
    );
    expect(row.rows[0], 'the seat row was deleted rather than retired').toBeDefined();
    expect(row.rows[0]?.retired_at).not.toBeNull();
  });

  it('6. only the two offices may edit the list, and everybody signed in may read it', async () => {
    const denied = await add(wingToken, {
      fullName: `Not Allowed (${RUN})`,
      designation: `Not Allowed Post (${RUN})`,
      phone: newPhone(),
    });
    expect(denied.status).toBe(403);

    /**
     * Reading is deliberately NOT gated on administration.
     *
     * Everybody signed in is the control room (ADR-0018, ADR-0024) and the list of who to ring
     * is the thing they signed in to use. `editable` is what a screen renders read-only from,
     * so the two questions stay separate rather than one answer doing both jobs badly.
     */
    const read = await call('GET', '/roster/contacts', wingToken);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { editable: boolean }).editable).toBe(false);
  });

  it('7. refuses to remove the LAST administration tick', async () => {
    const a = (await (
      await add(dcToken, {
        fullName: `Admin One (${RUN})`,
        designation: `AC HQ (${RUN})`,
        phone: newPhone(),
        isAdministration: true,
      })
    ).json()) as Contact;
    expect(a.isAdministration).toBe(true);

    /**
     * 🔴 **THE ONLY TEST HERE THAT GUARDS AN OUTAGE.**
     *
     * Untick every contact and nobody can issue an advisory, edit the directory or maintain a
     * group — and nothing fails at the moment it happens. This asserts the refusal is real by
     * emptying the district of ticks first, so the last one genuinely is the last one.
     *
     * ⚠️ **THE LAST TICK LEFT STANDING IS THE CALLER'S OWN, AND ADR-0030 IS WHY.**
     *
     * It used to be the contact this test had just created, and the caller kept acting because
     * their authority came from their DEPARTMENT — a second source, which 0038 read alongside
     * the seat. Migration 0039 removed it, so clearing every seat tick now clears the caller's
     * as well: this test asked to be unticked and then asked to act, and got **403 where it
     * expected 409**.
     *
     * That is the feature, not a broken test. With one source, *"remove every tick"* and
     * *"still be allowed to act"* are contradictory — and the version of this test that passed
     * before was only ever passing because they were not.
     */
    await pool.query('UPDATE seat SET is_administration = false WHERE seat_id <> $1', [dcSeatId]);

    const refused = await call('POST', `/roster/contacts/${dcSeatId}/administration`, dcToken, {
      on: false,
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('last contact');

    // And with a second tick in place it is allowed — the guard is about the LAST one, not
    // about the act. A refusal that never lifts is a setting nobody can correct.
    const b = (await (
      await add(dcToken, {
        fullName: `Admin Two (${RUN})`,
        designation: `DC Office (${RUN})`,
        phone: newPhone(),
        isAdministration: true,
      })
    ).json()) as Contact;
    expect(b.isAdministration).toBe(true);

    const allowed = await call('POST', `/roster/contacts/${a.seatId}/administration`, dcToken, {
      on: false,
    });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { isAdministration: boolean }).isAdministration).toBe(false);
  });

  it('8. a removed contact frees its phone number for the same contact to be re-added', async () => {
    /**
     * The district reported it: delete a contact, try to add the same one back, and the form
     * refuses with *"a contact with that phone number already exists"* about a contact that is
     * off every screen. `removeContact` retired the seat and left `person.removed_at` NULL, so
     * `createContact`'s phone-duplicate check — `WHERE removed_at IS NULL` — kept counting it.
     */
    const phone = newPhone();
    const first = (await (
      await add(dcToken, {
        fullName: `Re-added (${RUN})`,
        designation: `Re-added Post (${RUN})`,
        phone,
      })
    ).json()) as Contact;

    expect((await call('DELETE', `/roster/contacts/${first.seatId}`, dcToken)).status).toBe(200);

    // The holder is marked removed, so the number is no longer claimed.
    const holder = await pool.query<{ removed_at: string | null }>(
      'SELECT removed_at FROM person WHERE person_id = $1',
      [first.personId],
    );
    expect(holder.rows[0]?.removed_at).not.toBeNull();

    const again = await add(dcToken, {
      fullName: `Re-added Again (${RUN})`,
      designation: `Re-added Post (${RUN})`,
      phone,
    });
    expect(again.status).toBe(201);

    const list = (await (await call('GET', '/roster/contacts', dcToken)).json()) as {
      contacts: Contact[];
    };
    expect(list.contacts.some((c) => c.phone === phone)).toBe(true);
  });

  it('9. a number held by a person who is not a live contact does not block the directory', async () => {
    /**
     * The re-add bug had a second face, and it is the one migration 0047 could not reach: a
     * `person` row that is **not** a removed contact but was never a contact at all — a
     * sign-in account made through Settings (ADR-0032), or a directory person parked without a
     * post. `createContact`'s phone check counted every `person` with `removed_at` NULL, so
     * making yourself an account and then trying to add the matching contact answered *"a
     * contact with that phone number already exists"* about a row that is on no contact screen.
     *
     * The check now joins to a live, non-retired seat — `listContacts`'s own definition of a
     * contact — so a number is "taken" only when an actual contact holds it.
     */
    const phone = newPhone();
    const parked = await call('POST', '/roster/people', dcToken, {
      fullName: `Parked Person (${RUN})`,
      phone,
    });
    expect(parked.status).toBe(201);

    const asContact = await add(dcToken, {
      fullName: `Parked Person (${RUN})`,
      designation: `Now A Contact (${RUN})`,
      phone,
    });
    expect(asContact.status).toBe(201);

    // And a live contact on that same handset IS still refused — the mistyped-digit case the
    // district actually asked to be caught.
    const sameHandset = await add(dcToken, {
      fullName: `Same Handset (${RUN})`,
      designation: `A Third Post (${RUN})`,
      phone,
    });
    expect(sameHandset.status).toBe(409);
    expect(((await sameHandset.json()) as { error: string }).error).toContain(
      'phone number already exists',
    );
  });
});
