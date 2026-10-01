/**
 * The whole lifecycle, inside WhatsApp — Phase C, 2026-08-20.
 *
 * End to end against real PostgreSQL and the real webhook route, with only Meta stubbed. An
 * officer acknowledges an emergency from the message, is handed the rest of it as buttons, says
 * they are on scene, resolves it with a sentence — and **never opens a browser**.
 *
 * `lifecycleLink.test.ts` proves the same journey down the *link*, and that path is untouched: it
 * is a fallback now rather than the only road. What this file holds down is the half that could
 * not be done inside WhatsApp until today, and the four ways it could go wrong:
 *
 *   * **A tap must not be matched to an incident by the number it came from.** Everything else in
 *     `webhooks.ts` is, and says so; a guess that resolves an emergency would close the one
 *     nobody has been to.
 *   * **Resolving asks for a sentence first, and records nothing until it arrives.** A resolution
 *     reading only *"resolved"* answers nothing six weeks later, which is why the page has
 *     demanded one since M9-27.
 *   * **A stage already reached offers nothing and refuses nothing.** There is no such thing here
 *     as a control that is present and says no.
 *   * **The buttons are re-read from the record, never remembered.** An emergency a colleague
 *     resolved in between must not still be offering *Resolved*.
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
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { stageOf } from '../../domain/stages.js';
import { toE164, type WhatsAppConfig } from '../../ops/whatsapp.js';

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
  /** Named, so an emergency goes out on the template whose Acknowledge button this test taps. */
  emergencyTemplate: { name: 'district_emergency_v2', language: 'en' },
};

interface Interactive {
  type?: string;
  text?: { body?: string };
  interactive?: {
    body?: { text?: string };
    action?: { buttons?: { reply?: { id?: string; title?: string } }[] };
  };
}

describe.skipIf(dbUrl === undefined)('the lifecycle, inside WhatsApp', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;
  let officerKey: string;

  /**
   * A second handset, for Phase 9b's three tests and nothing else.
   *
   * ⚠️ **`pendingQuestion` is keyed on the NUMBER, not on the incident** — deliberately, and the
   * note it writes says so. So an unanswered *"what happened?"* left standing by any test above is
   * answered by the first thing anybody types on that handset, and a journey test sharing the
   * number would be asserting a premise it never established.
   *
   * `followUp.test.ts` and `proactive.test.ts` each carry a handset of their own for this exact
   * reason. **Third time: one handset per question, and the assertion is never the thing to
   * loosen.**
   */
  let chasedPerson: string;
  let chasedPhone: string;

  let sent: string[];
  /**
   * A provider message id that is unique for the life of the file — and it is deliberately NOT
   * `sent.length`.
   *
   * It was, and it cost three failing tests that all looked like Phase C bugs. `sent` is emptied
   * between tests so each can read its own traffic, so the counter restarted, so two messages
   * went out carrying **the same `wamid`** — and `recordSent` is `ON CONFLICT DO NOTHING`, by
   * design, because Meta redelivers. The second emergency therefore left **no row**,
   * `lastMessageTo` kept returning the first, and an Acknowledge tap meant for one emergency was
   * applied to another. A real district would hit this the moment two alerts shared an id, which
   * is never — the fault was the harness inventing ids that collide, not the code trusting them.
   */
  let outbound = 0;

  const stubFetch = (async (_url: string, init?: { body?: string }) => {
    sent.push(init?.body ?? '');
    outbound += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${RUN}.${outbound}` }] }), {
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

    const dc = await seedDepartment(pool, `DC Office (life ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (life ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (life ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (life ${RUN})`,
      departmentId: rescue,
    });
    officerPerson = duty.personId;

    const row = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [officerPerson],
    );
    officerPhone = row.rows[0]?.phone ?? '';
    expect(officerPhone).not.toBe('');
    officerKey = toE164(officerPhone);
    expect(officerKey).not.toBe('');

    const chased = await seedActor(pool, {
      title: `Chased Officer (life ${RUN})`,
      departmentId: rescue,
    });
    chasedPerson = chased.personId;
    const second = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [chasedPerson],
    );
    chasedPhone = second.rows[0]?.phone ?? '';
    expect(chasedPhone).not.toBe('');
    expect(chasedPhone).not.toBe(officerPhone);
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /** An emergency, told to one named officer, actually sent. */
  async function raise(what: string, person: string = officerPerson): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          // Per-run, so no signal another suite left behind can route it. `whatsappLoop.test.ts`
          // paid for this lesson three times over.
          category: `life-${RUN}`,
          severity: 'high',
          description: what,
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: person }] }),
    });

    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });
    return created.incidentId;
  }

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

  /** A tap on one of Meta's approved template buttons — words only, no id. */
  const templateTap = (label: string, from: string = officerPhone): unknown => ({
    from,
    timestamp: String(Math.floor(Date.now() / 1000)),
    button: { text: label, payload: label },
  });

  /** A tap on a button this software built — carries the id the officer never sees. */
  const ourTap = (id: string, title: string, from: string = officerPhone): unknown => ({
    from,
    timestamp: String(Math.floor(Date.now() / 1000)),
    interactive: { button_reply: { id, title } },
  });

  /**
   * ⚠️ **`secondsLater` exists because Meta's inbound timestamp is whole SECONDS.**
   *
   * `appendAcknowledgement` stamps `occurredAt` with milliseconds, so a tap and a reply inside the
   * same second fold with the **acknowledgement last** — and `action_logged`'s
   * `acknowledged → responding` is then undone by an event that sorts after it (ADR-0008: the
   * order is causal, never arrival). In a real district a chase and its answer are minutes or
   * hours apart; in a test they are the same tick, so the gap has to be stated.
   */
  const typed = (words: string, secondsLater = 0, from: string = officerPhone): unknown => ({
    from,
    timestamp: String(Math.floor(Date.now() / 1000) + secondsLater),
    text: { body: words },
  });

  const statusOf = async (incidentId: string): Promise<string> =>
    foldIncident(incidentId, await loadIncident(pool, incidentId)).status;

  /**
   * 🔴 **The control room chases, and THAT is what puts the lifecycle in the thread now** — the
   * owner's correction of 2026-08-23, read off a real handset.
   *
   * Until that day the *Acknowledge* tap answered with *On scene · Resolved · Where I am*, and
   * three tests below drove the whole lifecycle from it. The owner saw the district's thank-you
   * arrive carrying those buttons and ruled it out in one sentence: *"ye chunki action wale msgs
   * nhe hote hain just a thank you msg hote hain es lye es pr action wale button nhe hone chaye
   * hai."*
   *
   * ⚠️ **What that costs is real and is written here rather than in a commit message.** Phase C's
   * headline was that acknowledging **is** the moment the rest of the lifecycle appears. It is
   * not any more. What survives, and what these tests now drive:
   *
   *   * **the control room's *Follow up*** — `api/followUp.ts`, this helper;
   *   * **typing anything** — Phase 9b, still tested below, though a typed reply records
   *     *Responded* on its way past so *Responding* is behind the officer by the time it answers;
   *   * **the link on the alert itself**, which is where `lifecycleLink.test.ts` lives.
   *
   * Driven through the real endpoint rather than by rebuilding a stage id here: a test that
   * fabricates the id proves the software recognises a string the test invented, not that any
   * officer in Bajaur can reach that button.
   */
  async function chase(incidentId: string): Promise<void> {
    const res = await fetch(`${base}/incidents/${incidentId}/follow-up`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  }

  /** The buttons on the last interactive message sent, in order. */
  const lastButtons = (): { id: string; title: string }[] => {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      const body = JSON.parse(sent[i] ?? '{}') as Interactive;
      if (body.type === 'interactive') {
        return (body.interactive?.action?.buttons ?? []).map((b) => ({
          id: b.reply?.id ?? '',
          title: b.reply?.title ?? '',
        }));
      }
    }
    return [];
  };

  const lastText = (): string => {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      const body = JSON.parse(sent[i] ?? '{}') as Interactive;
      if (body.type === 'text') return body.text?.body ?? '';
    }
    return '';
  };

  /**
   * What the district actually **said**, whether it went as plain words or with a list attached.
   *
   * ⚠️ **Added 2026-08-24, and `lastText` is deliberately kept beside it.** They answer different
   * questions: this one is *what did the officer read*, and that one is *did it arrive as a bare
   * message with nothing attached* — which is still an assertion worth making about the district's
   * closing sentence.
   */
  const lastBody = (): string => {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      const body = JSON.parse(sent[i] ?? '{}') as Interactive;
      const words = body.text?.body ?? body.interactive?.body?.text;
      if (words !== undefined) return words;
    }
    return '';
  };

  it('answers the acknowledgement with the district’s question, not the lifecycle', async () => {
    const id = await raise(`Landslide ${RUN}`);
    sent = [];

    expect(await inbound(templateTap('Acknowledge'))).toBe(200);

    // The acknowledgement is recorded — and, by the owner's decision of 2026-10-01, the reply that
    // carries it reads as *Responding* straight away (`action_logged` moves it; `acknowledged`
    // never pulls it back — see `domain/incident.ts`).
    expect(await statusOf(id)).toBe('responding');

    /**
     * 🔴 **This test asserted the OPPOSITE until 2026-08-23** — *"hands the officer the rest of
     * the lifecycle the moment they acknowledge"*, with `['Responding', 'Resolved', 'Where I am']`
     * on this very message. See `chase()` above for the owner's words and for what replaced it.
     *
     * 🔴 **And on 2026-08-24 the district replaced what DOES go there.** The message is now their
     * own response options — *"har category k lye wo msg ka workflow bani"* — so this assertion
     * has changed shape twice and means the same thing both times: **the lifecycle is not
     * offered here.** `Responding`, `Resolved` and `Where I am` are still what a *typed* reply and
     * a follow-up get, which `chase()` below proves.
     */
    expect(lastButtons()).toEqual([]);
    expect(lastBody()).toContain('Thank you for the Acknowledgement');
    expect(lastBody()).not.toContain('tap below');
  });

  it('hands the officer the rest of the lifecycle when the control room chases', async () => {
    // Chased BEFORE any answer — the ordinary case. An Acknowledge tap already reads as
    // Responding (2026-10-01), so only an unanswered officer is still offered all three.
    const id = await raise(`Road accident ${RUN}`);
    sent = [];

    await chase(id);

    const buttons = lastButtons();
    /**
     * ⚠️ **Three, and the third one arrives here now rather than on the acknowledgement.**
     *
     * This read `['Responding', 'Resolved']` when it was written and gained *Where I am* when Phase
     * C2 added it to `offerNextStages`. The acknowledgement stopped carrying buttons on
     * 2026-08-23, so `followUp.ts` — which had deliberately left availability off — now adds it
     * **when there is room**, which is the only reason an officer can still say where they are
     * without leaving WhatsApp.
     *
     * 🔴 **Three is Meta's cap exactly, so this assertion is the guard on it.** A fourth button
     * cannot be added without deciding which of these three stops being offered, and the failure
     * must land here rather than as a 400 from Meta on a live emergency. From `routed` the stages
     * alone are three and availability is correctly withheld — `followUp.test.ts` holds that half.
     */
    expect(buttons.map((b) => b.title)).toEqual(['Responding', 'Resolved', 'Where I am']);
    /**
     * **Every button names its own incident and its own obligation.** That is what lets one
     * tapped an hour later, from a message history holding several of the district's alerts,
     * still know what it is about — rather than asking *"what was the last thing we sent this
     * number?"*, whose answer moves.
     */
    for (const button of buttons) {
      expect(button.id).toContain(id);
    }
  });

  it('records Responding on the tap, and then offers only what is still ahead', async () => {
    // No Acknowledge first: since 2026-10-01 that tap is already Responding, and the button
    // would not be offered.
    const id = await raise(`Building collapse ${RUN}`);
    await chase(id);

    const responding = lastButtons().find((b) => b.title === 'Responding');
    expect(responding).toBeDefined();
    sent = [];

    expect(await inbound(ourTap(responding?.id ?? '', 'Responding'))).toBe(200);

    // *Responding* says one thing and says all of it, so it is recorded immediately.
    expect(stageOf((await statusOf(id)) as never)).toBe('responded');
    // And what comes back offers Resolved and no longer offers Responding — read from the record,
    // never remembered from the message before.
    expect(lastButtons().map((b) => b.title)).toEqual(['Resolved', 'Where I am']);
  });

  it('asks what happened before resolving, and records nothing until it is told', async () => {
    const id = await raise(`Canal breach ${RUN}`);
    await inbound(templateTap('Acknowledge'));
    await chase(id);

    const resolved = lastButtons().find((b) => b.title === 'Resolved');
    expect(resolved).toBeDefined();
    sent = [];

    expect(await inbound(ourTap(resolved?.id ?? '', 'Resolved'))).toBe(200);

    expect(lastText()).toContain('what happened?');
    /**
     * **Nothing was recorded on the way to that question**, and that is the assertion worth
     * keeping. An officer who taps *Resolved* and then says nothing has resolved nothing — the
     * emergency stays open and keeps its clock, which is what the page does when somebody closes
     * the browser on an empty box. (It reads *Responding* because the Acknowledge tap put it
     * there — 2026-10-01 — not because of the *Resolved* tap.)
     */
    expect(await statusOf(id)).toBe('responding');

    expect(
      await inbound(typed('Two vehicles, both drivers walked away. Road cleared 21:40.')),
    ).toBe(200);

    expect(await statusOf(id)).toBe('resolved');

    const state = foldIncident(id, await loadIncident(pool, id));
    // The officer's own sentence, not the word "resolved" — which is the whole reason the tap
    // asks before it closes anything (M9-27).
    expect(state.resolution).toContain('Road cleared 21:40');
  });

  it('says a stage is already recorded rather than refusing it', async () => {
    // No Acknowledge first, for the same reason as the test above.
    const id = await raise(`Fire ${RUN}`);
    await chase(id);
    const responding = lastButtons().find((b) => b.title === 'Responding');

    await inbound(ourTap(responding?.id ?? '', 'Responding'));
    sent = [];

    // The same button again — an officer scrolling back through their own thread.
    expect(await inbound(ourTap(responding?.id ?? '', 'Responding'))).toBe(200);

    expect(lastText()).toContain('Already recorded as responded');
    // And the record did not move a second time.
    expect(stageOf((await statusOf(id)) as never)).toBe('responded');
  });

  it('never matches one of its own taps to an incident by the number it came from', async () => {
    /**
     * The sharpest rule in this file. Two emergencies to one handset; the officer answers the
     * **first** while the second is the most recent thing sent to that number. `lastMessageTo`
     * would return the second — and closing the emergency nobody has been to is exactly the
     * failure a guess must never be allowed to cause.
     */
    const first = await raise(`Landslide ${RUN}`);
    await inbound(templateTap('Acknowledge'));
    await chase(first);
    const resolved = lastButtons().find((b) => b.title === 'Resolved');
    expect(resolved?.id).toContain(first);

    // A second, newer emergency to the same officer. Now it is the most recent message.
    const second = await raise(`Gas leak ${RUN}`);
    expect(second).not.toBe(first);

    await inbound(ourTap(resolved?.id ?? '', 'Resolved'));
    await inbound(typed('Debris cleared, road open.'));

    expect(await statusOf(first)).toBe('resolved');
    // The one nobody has been to is untouched.
    expect(await statusOf(second)).not.toBe('resolved');
  });

  it('leaves the acknowledgement written when the buttons cannot be sent', async () => {
    const id = await raise(`Flood ${RUN}`);

    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), {
        status: 400,
      })) as unknown as typeof fetch;

    const failingServer = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: failing,
    });
    await new Promise<void>((r) => failingServer.listen(0, '127.0.0.1', r));
    const failingBase = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;

    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [templateTap('Acknowledge')] } }] }],
    });
    const signature = `sha256=${createHmac('sha256', config.appSecret)
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;

    const res = await fetch(`${failingBase}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    expect(res.status).toBe(200);
    await new Promise<void>((r) => failingServer.close(() => r()));

    /**
     * The direction that must hold: the officer answered, and the district knows it. A failure to
     * offer the buttons costs one road to the same place — the **link** on the original message
     * is still there — and never the answer itself. (Responding, not acknowledged: 2026-10-01.)
     */
    expect(await statusOf(id)).toBe('responding');
  });

  it('offers the buttons back when the officer TYPES instead of tapping — the owner’s own journey', async () => {
    /**
     * 🔴 **This is the defect the owner found on a real handset, walked end to end.**
     *
     * The control room chased, the officer typed **"It is resolved"**, and the emergency stayed on
     * the board as *Responded*. Their words were on the incident, verbatim — the record was never
     * the thing that was missing. **Nothing acted on them.**
     *
     * 🔴 **AND THE FIX IS NOT TO READ THE WORDS.** Auto-closing from free text was proposed on
     * 2026-08-08 and refused: *"not handled yet"* contains *"handled"*, one recipient's reply is
     * not everyone's, and a real emergency marked done because a reply was misread is worse than
     * the extra step. So the district **offers**, and one tap runs the machinery that has existed
     * since Phase C — including the question, so a resolution still arrives with a sentence.
     */
    const id = await raise(`Typed not tapped ${RUN}`, chasedPerson);
    expect(await inbound(templateTap('Acknowledge', chasedPhone))).toBe(200);
    sent = [];

    expect(await inbound(typed('It is resolved', 60, chasedPhone))).toBe(200);

    // Their words are on the record, exactly as before — this changes nothing about that.
    expect(await statusOf(id)).toBe('responding');

    // And the district answered with the one stage still ahead, rather than guessing at "resolved".
    expect(lastButtons().map((b) => b.title)).toContain('Resolved');

    const resolved = lastButtons().find((b) => b.title === 'Resolved');
    expect(resolved).toBeDefined();

    // One tap, and the safe path runs: it asks what happened before recording anything.
    sent = [];
    expect(await inbound(ourTap(resolved?.id ?? '', 'Resolved', chasedPhone))).toBe(200);
    expect(await statusOf(id)).toBe('responding');
    expect(lastText().toLowerCase()).toContain('what happened');

    // Their sentence closes it — and the record carries their words rather than one word.
    expect(await inbound(typed('Crew attended, road cleared', 120, chasedPhone))).toBe(200);
    expect(await statusOf(id)).toBe('resolved');

    const outcome = (await loadIncident(pool, id)).find((e) => e.type === 'resolved')?.payload as {
      outcome: string;
    };
    expect(outcome.outcome).toContain('road cleared');
  });

  it('answers a second typed reply with nothing, because nothing has changed', async () => {
    /**
     * ⚠️ **The claim is the whole restraint** (migration 0034). Without it an officer who types
     * four times about one emergency is answered four times — the chattiness the owner named and
     * deferred rather than accepted.
     *
     * The key carries the **status**, so it re-arms when the emergency actually moves: a second
     * reply at the same point in the same emergency is the same question, already asked.
     */
    const id = await raise(`Typed twice ${RUN}`, chasedPerson);
    expect(await inbound(templateTap('Acknowledge', chasedPhone))).toBe(200);

    expect(await inbound(typed('on my way', 60, chasedPhone))).toBe(200);
    sent = [];

    expect(await inbound(typed('still on my way', 120, chasedPhone))).toBe(200);

    // The reply is still recorded — only the prompt is withheld.
    expect(lastButtons()).toHaveLength(0);
    const notes = (await loadIncident(pool, id))
      .filter((e) => e.type === 'action_logged')
      .map((e) => (e.payload as { note: string }).note);
    expect(notes.some((n) => n.includes('still on my way'))).toBe(true);
  });

  it('offers nothing when a colleague has already resolved it', async () => {
    // `stagesOfferedFrom` returns an empty list and that is a complete answer: a button that
    // cannot move anything is worse than no button, because an officer presses it and is told it
    // did nothing (M9-28).
    const id = await raise(`Already done ${RUN}`, chasedPerson);
    expect(await inbound(templateTap('Acknowledge', chasedPhone))).toBe(200);

    await fetch(`${base}/incidents/${id}/resolve`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ outcome: 'dealt with by the station', reason: 'control room' }),
    });
    expect(await statusOf(id)).toBe('resolved');
    sent = [];

    expect(await inbound(typed('all clear here', 60, chasedPhone))).toBe(200);

    expect(lastButtons()).toHaveLength(0);
    expect(await statusOf(id)).toBe('resolved');
  });

  it('keys the window and the question on the same number the store writes', async () => {
    // Not a behaviour of Phase C, but the trap that made Phase B fail first time: the directory
    // holds `03xx…` and every one of these tables holds `toE164`. Pinned so a future reader of
    // either does not have to rediscover it.
    const open = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM whatsapp_window WHERE phone = $1',
      [officerKey],
    );
    expect(Number(open.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});
