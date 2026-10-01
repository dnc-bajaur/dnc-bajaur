/**
 * **The district answers the acknowledgement, in their own words** — their request, 2026-08-23.
 *
 * *"Jub bhi koi officer alert, emergency meeting etc etc k msg ko acknowledge kr de tou un ko aik
 * automated msg chala jaye"* — with three texts they wrote themselves, split by what the message
 * was about. This proves the whole road: a notice goes out on the real template, an officer taps
 * *Acknowledge* on a handset, and the sentence that comes back is the one the Deputy
 * Commissioner's office signed off for **that kind of message**.
 *
 * End to end against real PostgreSQL and the real webhook route, with only Meta stubbed.
 *
 * ## The four assertions, and each is a different way of getting this wrong
 *
 *   * **The right sentence per kind.** An officer summoned to a meeting must not be handed the
 *     control room's telephone number instead of *"kindly make it convenient to attend"*.
 *   * 🔴 **Exactly one message per acknowledgement.** This is a **cost** assertion, not a tidiness
 *     one. A message already went back on this route, so the district's words were folded into it
 *     rather than sent beside it — and from 1 October 2026 Meta charges for free-form replies
 *     inside the service window that are free today. A second send would be a second bill per
 *     acknowledgement, for ever, and nothing on any screen would ever show it.
 *   * **The lifecycle survives it.** The buttons that were the whole of this message before are
 *     still on it; the district's text opens the message, it does not replace it.
 *   * **A stage tap is never thanked for an acknowledgement.** *Responding* is not an
 *     acknowledgement, and telling an officer it was is the software claiming an act they did not
 *     perform.
 *
 * ⚠️ **The `security`/`flood` branch is proved in `domain/__tests__/acknowledgementThanks.test.ts`
 * and deliberately not here.** Creating an incident under a real category invites the routing
 * signals to add recipients this test never asked for — a lesson `whatsappLoop.test.ts` paid for
 * three times. The mapping is pure; the road through the webhook is what needs a database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { runNotifyPass } from '../../jobs/notify.js';
import { whatsappChannel } from '../../jobs/whatsappChannel.js';
import { ACKNOWLEDGED_LINE, RESPONSE_THANKS, THANKS } from '../../domain/acknowledgementThanks.js';
import { ACKNOWLEDGE_REPLY, DECLINED_REPLY } from '../../ops/whatsappTemplate.js';
import type { WhatsAppConfig } from '../../ops/whatsapp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const config: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
  /** Named, so a meeting and a notice go out on the template whose buttons this test taps. */
  noticeTemplate: { name: 'district_notice_v2', language: 'en' },
};

/** What the stub was asked to send. A read receipt is not a message and is filtered out. */
interface Outbound {
  readonly type?: string;
  readonly status?: string;
  readonly text?: { body?: string };
  readonly interactive?: {
    body?: { text?: string };
    action?: {
      buttons?: readonly { reply?: { id?: string; title?: string } }[];
      /** What the officer taps to open the sheet — `Tap to reply` since 2026-08-26. */
      button?: string;
      /**
       * The district's response options — 2026-08-24. A **list**, not buttons, because the
       * longest of their categories is five options and Meta carries at most three buttons.
       */
      sections?: readonly {
        rows?: readonly { id: string; title: string; description?: string }[];
      }[];
    };
  };
}

describe.skipIf(dbUrl === undefined)('the district answers an acknowledgement', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;

  let sent: { url: string; body: string }[];

  /**
   * ⚠️ **Monotonic, and NEVER `sent.length`** — which is what this was, and it cost half an hour.
   *
   * `sent` is cleared between fixtures so each test reads only its own traffic. Numbering the
   * stubbed message ids off its length therefore restarted at 1 for every incident, and
   * `recordSent` stores them `ON CONFLICT (provider_message_id) DO NOTHING` — so the second and
   * third notices were **silently not recorded at all**. `lastMessageTo` went on returning the
   * first alert, every tap landed on it, and the meeting read back the urgent text: a mapping
   * bug that was not a mapping bug.
   */
  let wamids = 0;

  const stubFetch = (async (url: string, init?: { body?: string }) => {
    sent.push({ url: String(url), body: init?.body ?? '' });
    wamids += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${RUN}.${wamids}` }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const channel = (): ReturnType<typeof whatsappChannel> =>
    whatsappChannel({
      pool,
      config,
      publicOrigin: 'https://dnc.example.invalid',
      fetchImpl: stubFetch,
    });

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    sent = [];

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
      get whatsappChannel() {
        return channel();
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (thanks ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (thanks ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (thanks ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (thanks ${RUN})`,
      departmentId: rescue,
    });
    officerPerson = duty.personId;
    officerPhone = duty.phone;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /**
   * Something sent to one named officer, actually delivered, with `sent` cleared behind it.
   *
   * A per-run category throughout: a category no routing signal can match cannot pull in a
   * department this test never named — `whatsappLoop.test.ts`'s lesson, and the reason the
   * `flood` branch is proved in the pure test instead of here.
   */
  async function tellOfficer(body: Record<string, unknown>): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: `thx-${RUN}`, severity: 'low', ...body }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: officerPerson }] }),
    });

    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });

    /**
     * ⚠️ **The fixture guards itself, and this is not ceremony.** An inbound tap is matched to
     * *the most recent alert sent to that number*, so a notice that silently failed to go out
     * leaves the tap landing on the **previous** test's alert — and every assertion below would
     * then be reading the right sentence about the wrong incident. That is exactly how the
     * meeting case first failed here, and it looked like a mapping bug for ten minutes.
     */
    expect(
      sent.length,
      'nothing was sent, so a tap would match an earlier incident',
    ).toBeGreaterThan(0);
    sent = [];
    return created.incidentId;
  }

  /** One inbound message, signed as Meta signs it. */
  async function inbound(message: unknown): Promise<number> {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const signature = `sha256=${createHmac('sha256', config.appSecret)
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;

    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    return res.status;
  }

  /** A tap on one of the template's approved quick replies — words and nothing else. */
  const tap = (label: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    id: `wamid.theirs.${randomUUID().slice(0, 8)}`,
    button: { text: label, payload: label },
  });

  /**
   * Words an officer typed into the thread.
   *
   * ⚠️ **Seconds later than the tap before it, and that is not cosmetic.** Meta's inbound
   * timestamp is whole **seconds** while `appendAcknowledgement` stamps milliseconds, so a tap
   * and a reply inside one second fold with the acknowledgement last (ADR-0008: causal, never
   * arrival) — and the status this path reads back is then the one before the tap. In a district
   * these are minutes apart; in a test they are one tick.
   */
  const typed = (words: string, secondsLater = 2): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000) + secondsLater),
    id: `wamid.theirs.${randomUUID().slice(0, 8)}`,
    text: { body: words },
  });

  /**
   * A tap on a row of one of the district's option lists — 2026-08-24.
   *
   * ⚠️ **`list_reply`, not `button_reply`.** Meta uses a different envelope for a list, and
   * `readWebhook` has read both since the interactive path was built; a test that sent the button
   * shape here would pass while the real thing was being dropped as unrecognised.
   */
  const rowTap = (id: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000) + 1),
    id: `wamid.theirs.${randomUUID().slice(0, 8)}`,
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id, title: 'chosen' } },
  });

  /** A tap on a button this software built, which carries an id the officer never sees. */
  const chose = (id: string, title: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    id: `wamid.theirs.${randomUUID().slice(0, 8)}`,
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title } },
  });

  /**
   * Everything the district actually **said**, in order.
   *
   * Read receipts are stripped: Phase 7 puts two blue ticks on the officer's own message, which
   * is not a message and costs nothing. Counting it would make the cost assertion below lie in
   * the safe direction, which is the worse direction for an assertion about money.
   */
  function messages(): Outbound[] {
    return sent
      .map((s) => JSON.parse(s.body || '{}') as Outbound)
      .filter((b) => b.status !== 'read' && b.type !== undefined);
  }

  /** The body text of an outbound, whether it went as plain text or with buttons attached. */
  function said(m: Outbound | undefined): string {
    return m?.text?.body ?? m?.interactive?.body?.text ?? '';
  }

  /**
   * 🔴 **The district moved their own thank-you on 2026-08-24, and this is what replaced it.**
   *
   * Their *Official WhatsApp Response and Acknowledgement Workflow* asks that the message after an
   * acknowledgement be the category's **options**, with the closing sentence held back until the
   * officer has answered — *"har category k lye wo msg ka workflow bani"*.
   *
   * ⚠️ **The acknowledgement is still thanked, in the first line.** Their closing message thanks
   * the officer for their *response*, which is a different act; if the whole thank-you waited for
   * an answer that never came, an officer who taps at 02:00 and puts the phone down would get
   * nothing at all — worse than what they had.
   */
  it('answers an alert with the district’s own options, and still thanks them', async () => {
    await tellOfficer({ kind: 'alert', description: `Movement advisory ${RUN}` });

    expect(await inbound(tap(ACKNOWLEDGE_REPLY))).toBe(200);

    /**
     * 🔴 **One.** The cost argument is unchanged and still binding: the thank-you rides the
     * message that was going anyway. If this ever reads 2, every acknowledgement in Bajaur costs an
     * extra message from 1 October 2026 and no screen says so.
     */
    const out = messages();
    expect(out).toHaveLength(1);

    expect(said(out[0])).toContain(ACKNOWLEDGED_LINE);
    expect(out[0]?.type).toBe('interactive');

    const rows = out[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    expect(rows.map((r) => r.description)).toEqual([
      'Alert Noted — Taking Necessary Action',
      'Relevant Staff / Field Team Alerted',
      'Matter Already Under Control',
      'Further Information Required',
      'Unable to Respond',
    ]);

    /**
     * 🔴 **Meta's 24-character row title, asserted where it is actually sent.** The domain test
     * holds the same cap on the catalogue; this one proves the sender did not put the district's
     * long sentence in the title field, which is a 400 from Meta on a real night.
     */
    for (const row of rows) expect(row.title.length).toBeLessThanOrEqual(24);

    /** And the closing sentence has NOT been spent yet — it belongs to the answer. */
    expect(said(out[0])).not.toContain('0000-000000');
  });

  /**
   * 🔴 **The owner's correction of 2026-08-23 still holds, and it holds from the other side.**
   *
   * Their words were *"ye chunki action wale msgs nhe hote hain just a thank you msg hote hain es
   * lye es pr action wale button nhe hone chaye hai."* — **a thank-you carries no controls.**
   *
   * The district's workflow does not undo that. The first message is no longer a thank-you at
   * all: it is a **question**, and a question is allowed to carry the controls that answer it.
   * What must stay bare is the closing sentence, and this asserts exactly that — the officer
   * answers, and what comes back is words and nothing else.
   */
  it('puts no action buttons under the district’s closing message', async () => {
    await tellOfficer({ kind: 'alert', description: `Canal breach warning ${RUN}` });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    const asked = messages();
    const row = asked[0]?.interactive?.action?.sections?.[0]?.rows?.[0];
    expect(row).toBeDefined();

    sent.length = 0;
    expect(await inbound(rowTap(row!.id))).toBe(200);

    const out = messages();
    expect(out).toHaveLength(1);
    expect(said(out[0])).toContain(RESPONSE_THANKS);
    expect(out[0]?.type).toBe('text');
    expect(out[0]?.interactive).toBeUndefined();
  });

  it('asks a meeting’s officer to attend, and never gives them a telephone number', async () => {
    await tellOfficer({
      kind: 'meeting',
      description: `District coordination meeting ${RUN}`,
      details: { subject: `District coordination ${RUN}` },
    });

    expect(await inbound(tap(ACKNOWLEDGE_REPLY))).toBe(200);

    const out = messages();
    expect(out).toHaveLength(1);
    expect(said(out[0])).toContain(THANKS.meeting);
    /**
     * The assertion that would have caught the obvious implementation. One text for everybody is
     * what this feature looks like when the mapping is skipped, and the district would have read
     * *"in case of any emergency, ring the control room"* under a notice about a meeting.
     */
    expect(said(out[0])).not.toContain('In case of any emergency');
  });

  /**
   * 🔴 **A meeting's *Not Attending* asks why, and closes with the district's own sentence** —
   * RW-10 and the owner's decision of 2026-08-25.
   *
   * Two things are pinned here and they fail for different reasons.
   *
   * **The question exists at all.** *Not Attending* has been a tappable answer since the notice
   * template was approved and it was always recorded — what the district never got was the
   * sentence after it, which is the whole of what a control room does with a declined meeting.
   *
   * **The closing message is theirs, not one of ours.** This shipped for a day with a meeting
   * getting a sentence of its own, on the argument that an officer who cannot attend Thursday has
   * no use for an emergency telephone number. The owner was asked and answered plainly — *"pdf
   * wala msg hi closing msg ho"* — so one sentence now closes every path, theirs.
   *
   * ⚠️ **The BUTTON is untouched throughout.** It is approved at Meta by position on
   * `district_notice_v2`; everything here happens inside the window that tap itself opened.
   */
  it('asks a meeting’s officer why, and closes with the district’s own sentence', async () => {
    await tellOfficer({
      kind: 'meeting',
      description: `Coordination meeting ${RUN}`,
      details: { subject: `Coordination ${RUN}` },
    });

    expect(await inbound(tap(DECLINED_REPLY))).toBe(200);

    const asked = messages();
    expect(said(asked[0])).toContain('Reason for not attending');
    /** A sentence, not a list: *"court date"* and *"my son’s wedding"* fit no three buttons. */
    expect(asked[0]?.interactive).toBeUndefined();

    sent.length = 0;
    expect(await inbound(typed('Court date in Peshawar'))).toBe(200);

    const out = messages();
    expect(out).toHaveLength(1);
    expect(said(out[0])).toContain(RESPONSE_THANKS);
    /** And it is bare — the owner’s rule of 2026-08-23, still standing. */
    expect(out[0]?.type).toBe('text');
    expect(out[0]?.interactive).toBeUndefined();
  });
  it('points a notice at the control room for further information', async () => {
    await tellOfficer({
      kind: 'other',
      description: `Office timings notice ${RUN}`,
      details: { subject: `Office timings ${RUN}` },
    });

    expect(await inbound(tap(ACKNOWLEDGE_REPLY))).toBe(200);

    /**
     * 🔴 **A notice gets the district's *Information* list now, not their third sentence.**
     *
     * `THANKS.information` is not gone — it is the fallback for a shut service window or a refused
     * send, which is asserted below. What changed is the ordinary path.
     */
    const out = messages();
    expect(out).toHaveLength(1);
    expect(said(out[0])).toContain(ACKNOWLEDGED_LINE);

    const rows = out[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    expect(rows.map((r) => r.description)).toEqual([
      'Information Noted',
      'Information Conveyed to Relevant Staff',
      'Necessary Action Being Taken',
      'Information Requires Further Clarification',
    ]);
  });

  /**
   * 🔴 **The district's own sentence reaches the record, never the handset's short headline.**
   *
   * The headline exists because Meta caps a list row's title at 24 characters. If it were what
   * got written, the board, the daily report and the export would all quote a sentence the Deputy
   * Commissioner's office never wrote — which is the one change nobody here may make.
   */
  /**
   * 🔴 **The district’s options are readable without opening anything** — the owner, 2026-08-26.
   *
   * A WhatsApp list is a **button** with its rows in a sheet behind it. Nothing in Meta’s
   * interactive message draws a row inline, and the only control that sits directly under a
   * message is a reply button — three of them, at twenty characters, against lists of four and
   * five. So the officer saw a button and no hint of what was behind it, and the answer was to
   * write the options into the body as well.
   *
   * ⚠️ **Still one message.** The options ride the message that was already going; the cost
   * argument that has governed this file since August is untouched.
   */
  it('writes the options into the message, and names the button for what it does', async () => {
    await tellOfficer({ kind: 'emergency', category: 'rta', description: `Bypass ${RUN}` });

    expect(await inbound(tap(ACKNOWLEDGE_REPLY))).toBe(200);

    const out = messages();
    expect(out).toHaveLength(1);

    const body = said(out[0]);
    expect(body).toContain(ACKNOWLEDGED_LINE);

    /** Every one of the district’s five, numbered, in their own words. */
    expect(body).toContain('1. Proceeding to the Site');
    expect(body).toContain('2. Relevant Team Being Dispatched');
    expect(body).toContain('3. Matter Already Being Attended');
    expect(body).toContain('4. Police / Rescue / Relevant Department Informed');
    expect(body).toContain('5. Unable to Respond');

    /**
     * ⚠️ **The 24-character row label must not leak into the message.** It exists to fit Meta’s
     * title field; the body has room for the sentence the record will actually carry.
     */
    expect(body).not.toContain('Proceeding to the site');

    expect(out[0]?.interactive?.action?.button).toBe('Tap to reply');

    /** And the rows are untouched — the sheet still works exactly as it did. */
    const rows = out[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.title.length).toBeLessThanOrEqual(24);

    /** The closing sentence still belongs to the answer, not to this. */
    expect(body).not.toContain('0000-000000');
  });

  /**
   * 🔴 **Typing `2` is the same answer as opening the sheet and tapping the second row.**
   *
   * Writing the options out invites exactly this, so it had to become an answer rather than a
   * stray word. What made the old behaviour worth fixing is that it failed **quietly**:
   * `action_logged` moves an acknowledged incident to `responding` for any typed reply, so the
   * board looked answered while the record of *what* was answered read `2`.
   */
  it('takes a typed number as the option the officer could see', async () => {
    const incidentId = await tellOfficer({
      kind: 'emergency',
      category: 'rta',
      description: `Khar Road typed ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    sent.length = 0;

    expect(await inbound(typed('2'))).toBe(200);

    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const detail = (await res.json()) as {
      state: { notifications: { said?: string }[]; status: string };
    };

    /**
     * 🔴 **The district’s sentence on the record, not the character they typed.** `optionOfSaid`
     * reads an option back out of this field on every screen and in the export; a `2` here is an
     * answer nothing can interpret six weeks later.
     */
    expect(
      detail.state.notifications.some((n) => n.said === 'Relevant Team Being Dispatched'),
    ).toBe(true);
    expect(detail.state.notifications.some((n) => n.said === '2')).toBe(false);

    expect(detail.state.status).toBe('responding');

    /** And the district closes the exchange, so the officer knows the answer landed. */
    expect(said(messages()[messages().length - 1])).toContain(RESPONSE_THANKS);
  });

  /**
   * 🔴 **The loss this actually repairs: a typed option that CLOSES an emergency.**
   *
   * *Matter Already Being Handled* records `resolved` — the district’s own answer of 2026-08-25,
   * *“Already being handlled ka matlab khatm hai”*. Typed, it used to reach `responding` through
   * `action_logged` like any other sentence, and the emergency stayed open on the board with the
   * word `3` against it. This is the assertion that would have caught that.
   */
  it('lets a typed option close an emergency, exactly as the row does', async () => {
    const incidentId = await tellOfficer({
      kind: 'emergency',
      category: 'fire',
      description: `Timber market typed ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    sent.length = 0;

    expect(await inbound(typed('3'))).toBe(200);

    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const detail = (await res.json()) as {
      state: { notifications: { said?: string }[]; status: string };
    };

    expect(detail.state.status).toBe('resolved');
    expect(detail.state.notifications.some((n) => n.said === 'Matter Already Being Handled')).toBe(
      true,
    );
  });

  /**
   * 🔴 **A typed *Unable to Respond* is asked why — the district’s §9, reached by typing.**
   *
   * The branch asking why is the whole of what a control room does with a decline, and it never
   * went for a typed answer. `5` is the last row of the accident list.
   */
  it('asks a typed decline for its reason', async () => {
    await tellOfficer({
      kind: 'emergency',
      category: 'rta',
      description: `Bajaur bypass decline ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    sent.length = 0;

    expect(await inbound(typed('5'))).toBe(200);

    const asked = messages();
    expect(asked).toHaveLength(1);
    expect(said(asked[0])).toContain('Unable to Respond');

    /** The three the district named, offered as a list exactly as the tap offers them. */
    const rows = asked[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    expect(rows.map((r) => r.description)).toEqual([
      'Sending a Responsible Representative',
      'On Leave',
      'Otherwise Unavailable',
    ]);

    /** And the branch is readable without opening it, on the same rule as the first list. */
    expect(said(asked[0])).toContain('1. Sending a Responsible Representative');
  });

  /**
   * ⚠️ **A sentence that merely begins with a digit is NOT an option**, and this is the assertion
   * that keeps the feature from inventing answers. *“1 casualty, ambulance on the way”* is an
   * officer telling the district something; recorded as *Proceeding to the Site* it would be an
   * answer nobody gave, and it would stop a clock.
   */
  it('leaves an officer’s own words alone', async () => {
    const incidentId = await tellOfficer({
      kind: 'emergency',
      category: 'rta',
      description: `Own words ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    sent.length = 0;

    expect(await inbound(typed('1 casualty, ambulance on the way'))).toBe(200);

    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const detail = (await res.json()) as {
      state: { notifications: { said?: string }[]; status: string };
    };

    /**
     * 🔴 **The assertion that matters: their sentence was NOT turned into one of the
     * district’s answers.** A leading digit is the trap — `optionTyped` refuses anything but a
     * bare number, because recording this as *Proceeding to the Site* would put an answer on
     * the record that nobody gave, and that answer stops an SLA clock.
     */
    expect(detail.state.notifications.some((n) => n.said === 'Proceeding to the Site')).toBe(false);

    /** Their words are an action, so the incident moves — as it did before any of this. */
    expect(detail.state.status).toBe('responding');

    /**
     * 🔴 **And it took the ordinary road, proved by the message that comes back.**
     *
     * An officer who names an option gets `askWhatFollows` — the closing sentence, or the
     * question the option asks — and the stage buttons are suppressed. An officer who types
     * their own words gets exactly what they always got: *"Thank you. When there is something
     * to record, tap below."*, with the controls under it. This is the fork, asserted from the
     * outside.
     */
    const back = messages();
    expect(back).toHaveLength(1);
    expect(said(back[0])).toContain('When there is something to record, tap below.');
    expect(said(back[0])).not.toContain(RESPONSE_THANKS);
  });
  it('writes what the district wrote, not what fits on a row', async () => {
    const incidentId = await tellOfficer({
      kind: 'emergency',
      category: 'rta',
      description: `Khar Road ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    const rows = messages()[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    const police = rows.find((r) => r.description?.startsWith('Police'));
    expect(police).toBeDefined();
    expect(police!.title).toBe('Police / Rescue informed');

    sent.length = 0;
    expect(await inbound(rowTap(police!.id))).toBe(200);

    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const body = (await res.json()) as {
      state: { notifications: { said?: string }[]; status: string };
    };

    expect(body.state.notifications.some((n) => n.said === police!.description)).toBe(true);
    /** And it moved the emergency, because that option says somebody is acting on it. */
    expect(body.state.status).toBe('responding');
  });

  /**
   * 🔴 **An officer can close an emergency by saying somebody else has it — the district's own
   * answer of 2026-08-25, and the most consequential single line in the whole workflow.**
   *
   * This shipped the day before recording *Matter Already Being Handled* as **Responded**, on the
   * reading that it describes work in progress. §9 Q4 asked the district directly and they said
   * *"Already being handlled ka matlab khatm hai"*. So it closes.
   *
   * ⚠️ **The assertion that matters is the OUTCOME, not the status.** A resolution recorded as the
   * word *resolved* answers nothing six weeks later (M9-27); the district's own sentence has to be
   * what the record carries, because that is the only account of why an emergency stopped.
   */
  it('closes an emergency when an officer says it is already being handled', async () => {
    const incidentId = await tellOfficer({
      kind: 'emergency',
      category: 'fire',
      description: `Barang godown ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    const rows = messages()[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    const handled = rows.find((r) => r.description === 'Matter Already Being Handled');
    expect(handled).toBeDefined();

    sent.length = 0;
    expect(await inbound(rowTap(handled!.id))).toBe(200);

    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const body = (await res.json()) as {
      state: { status: string };
      events: { type: string; payload?: { outcome?: string } }[];
    };

    expect(body.state.status).toBe('resolved');

    const closed = body.events.filter((e) => e.type === 'resolved');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.payload?.outcome).toContain('Matter Already Being Handled');

    /** And the district's closing sentence follows, because the officer has answered. */
    expect(said(messages()[0])).toContain(RESPONSE_THANKS);
  });
  /**
   * 🔴 **The green board over an emergency nobody has taken — closed at the source.**
   *
   * An officer who acknowledges and then says they cannot act has answered, so the obligation is
   * settled and they leave the chase list. What must NOT happen is the emergency reading as
   * dealt with: nothing moves it, and the district's own words are on the record saying why.
   */
  it('takes no ownership from an officer who says it is not theirs', async () => {
    const incidentId = await tellOfficer({
      kind: 'emergency',
      category: 'fire',
      description: `Mamund bazaar ${RUN}`,
    });

    await inbound(tap(ACKNOWLEDGE_REPLY));
    const rows = messages()[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    const unable = rows.find((r) => r.description === 'Unable to Respond');
    expect(unable).toBeDefined();

    sent.length = 0;
    expect(await inbound(rowTap(unable!.id))).toBe(200);

    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const body = (await res.json()) as {
      state: { notifications: { said?: string }[]; status: string };
    };

    expect(body.state.notifications.some((n) => n.said === 'Unable to Respond')).toBe(true);
    /** Acknowledged, and no further. Nobody is dealing with this. */
    expect(body.state.status).toBe('acknowledged');

    /** And the three ways to be unavailable follow, rather than the closing sentence. */
    const out = messages();
    expect(out).toHaveLength(1);
    const branch = out[0]?.interactive?.action?.sections?.[0]?.rows ?? [];
    expect(branch.map((r) => r.description)).toEqual([
      'Sending a Responsible Representative',
      'On Leave',
      'Otherwise Unavailable',
    ]);
  });

  /**
   * 🔴 **The other half of the owner’s rule, and it must not be lost in obeying the first half.**
   *
   * A thank-you carries no buttons — and a message that exists to carry buttons is not dressed up
   * as a thank-you. This is Phase 9b, which closed a defect the owner found themselves: an officer
   * typed *"It is resolved"* and the board went on saying *Responded*, because `webhooks.ts`
   * deliberately never reads words for meaning. Stripping the buttons from **this** message in the
   * name of the new rule would re-open that.
   */
  it('still offers the controls to an officer who types, and does not call it a thank-you', async () => {
    await tellOfficer({ kind: 'alert', description: `Culvert washed out ${RUN}` });

    expect(await inbound(typed('reached the site'))).toBe(200);

    const out = messages();
    expect(out).toHaveLength(1);

    const titles = (out[0]?.interactive?.action?.buttons ?? []).map((b) => b.reply?.title);
    expect(titles).toContain('Resolved');
    expect(titles).toContain('Where I am');
    expect(said(out[0])).toContain('When there is something to record, tap below.');

    /**
     * ⚠️ **`Responding` is absent, and that is `stagesOfferedFrom`'s rule rather than a defect.**
     * Typing into the thread appends `action_logged`, which moves the incident to *Responded* —
     * so by the time this message is built the officer has already recorded the stage the button
     * would offer, and *"there is no such thing here as a control that is present and refuses."*
     */
    expect(titles).not.toContain('Responding');

    // The district's ceremonial sentence belongs to the acknowledgement, not to this.
    expect(said(out[0])).not.toContain('Thank you for the Acknowledgement');
  });

  it('never thanks a stage tap for an acknowledgement', async () => {
    const id = await tellOfficer({ kind: 'alert', description: `Bridge inspection ${RUN}` });
    await inbound(tap(ACKNOWLEDGE_REPLY));

    /**
     * 🔴 **The control room's *Follow up* is how *Responding* is reached now, and driving the test
     * through it is deliberate rather than convenient.**
     *
     * The acknowledgement itself offers nothing any more, and a typed reply records *Responded* on
     * the way past — so this is the surviving road to that button, and a test that rebuilt the id
     * by hand would prove the software recognises a string it made up rather than that any officer
     * can get there.
     */
    sent = [];
    expect(
      (
        await fetch(`${base}/incidents/${id}/follow-up`, {
          method: 'POST',
          headers: authHeaders(controlToken),
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);

    const responding = (messages()[0]?.interactive?.action?.buttons ?? []).find(
      (b) => b.reply?.title === 'Responding',
    );
    expect(responding?.reply?.id).toBeDefined();

    sent = [];
    expect(await inbound(chose(responding?.reply?.id ?? '', 'Responding'))).toBe(200);

    /**
     * 🔴 **They recorded a stage. They did not acknowledge anything** — `appendStage` ran, not
     * `appendAcknowledgement`. A district that thanks somebody for an acknowledgement they did
     * not give is a district whose messages stop being read carefully.
     */
    for (const m of messages()) {
      expect(said(m)).not.toContain('Thank you for the Acknowledgement');
    }
  });

  /**
   * 🔴 **A meeting is never asked to acknowledge twice** — the owner across two corrections,
   * 2026-08-23 and 2026-08-24, and this is the whole conversation in one test.
   *
   * ⚠️ **The assertion that used to stand here was `titles` containing *Attending*.** It was
   * written on 2026-08-24 against the chase, which was then the one place a gathering was
   * offered stage buttons — and hours later the owner said a meeting chase should carry no
   * buttons at all: *"Meeting k follow up mai kuch button dene ki zarurt nhe hi just simple ho, a
   * kind of reminder ho"*. The word itself is still guarded, in `stages.test.ts`, and the chase
   * is guarded in `followUp.test.ts`. What is guarded **here** is the property that made both
   * corrections the same correction: from the notice to the thank-you to the reminder, **the
   * district asks a meeting’s officer to press something exactly once**, on the notice itself.
   */
  it('asks a meeting’s officer to press something once, and never again', async () => {
    const id = await tellOfficer({
      kind: 'meeting',
      description: `Flood coordination meeting ${RUN}`,
      details: { subject: `Flood coordination ${RUN}` },
    });

    // 1 — the acknowledgement is answered with words, and nothing under them.
    expect(await inbound(tap(ACKNOWLEDGE_REPLY))).toBe(200);
    const thanks = messages();
    expect(thanks).toHaveLength(1);
    expect(said(thanks[0])).toContain(THANKS.meeting);
    expect(thanks[0]?.interactive).toBeUndefined();

    // 2 — and so is the chase that follows it.
    sent = [];
    expect(
      (
        await fetch(`${base}/incidents/${id}/follow-up`, {
          method: 'POST',
          headers: authHeaders(controlToken),
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);

    const chase = messages()[0];
    expect(chase?.interactive).toBeUndefined();
    expect(said(chase)).toContain('Reminder regarding the subject meeting');
    expect(said(chase)).toContain('no reply is required');
    /**
     * ⚠️ **A meeting about the flood is still a meeting.** The description says *flood* on
     * purpose: category answers what a message is about, and it must not reach past `kind` to
     * decide what the officer is being asked to do — the same ordering `thanksKindFor` uses.
     */
    expect(said(chase)).not.toContain('following up');
  });
});
