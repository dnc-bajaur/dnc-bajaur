/**
 * "Are you available?", inside WhatsApp — Phase C2, re-aimed by ADR-0033 (2026-09-01).
 *
 * The last thing in the whole lifecycle that still required a browser. An officer taps *Where I
 * am*, and chooses one of **two** answers from a list. None of it leaves the thread and none of
 * it needs an account.
 *
 * What these tests hold down, and each is a way the record goes quietly wrong:
 *
 *   * **Both states are offered.** `available` / `unavailable`, managed by hand — no five-answer
 *     list, no `present` vs `office`.
 *   * **The answer is written on the tap.** Nothing polls an officer, so there is no *until when*
 *     to ask — `NEEDS_END` is gone.
 *   * **An id this version does not understand is ignored rather than guessed at.**
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
import { PRESENCE_STATUSES } from '../../domain/wall.js';
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
  emergencyTemplate: { name: 'district_emergency_v2', language: 'en' },
};

interface Outgoing {
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    body?: { text?: string };
    action?: {
      button?: string;
      buttons?: { reply?: { id?: string; title?: string } }[];
      sections?: { rows?: { id?: string; title?: string; description?: string }[] }[];
    };
  };
}

describe.skipIf(dbUrl === undefined)('where are you, inside WhatsApp', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerSeat: string;
  let officerPhone: string;

  let sent: string[];
  /** Never `sent.length` — see the note in `lifecycleInWhatsApp.test.ts`. */
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

    const dc = await seedDepartment(pool, `DC Office (where ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (where ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (where ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (where ${RUN})`,
      departmentId: rescue,
    });
    officerPerson = duty.personId;
    officerSeat = duty.seatId;

    const row = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [officerPerson],
    );
    officerPhone = row.rows[0]?.phone ?? '';
    expect(officerPhone).not.toBe('');
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function raise(what: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: `where-${RUN}`, severity: 'high', description: what }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: officerPerson }] }),
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

  const templateTap = (label: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    button: { text: label, payload: label },
  });

  const ourTap = (id: string, title: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    interactive: { button_reply: { id, title } },
  });

  /** A row chosen out of a list. Meta delivers it under a different key from a button. */
  const listPick = (id: string, title: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    interactive: { list_reply: { id, title } },
  });

  const parsed = (): Outgoing[] => sent.map((b) => JSON.parse(b || '{}') as Outgoing);

  const lastList = (): { button: string; rows: { id: string; title: string }[] } => {
    for (const body of [...parsed()].reverse()) {
      if (body.interactive?.type === 'list') {
        return {
          button: body.interactive.action?.button ?? '',
          rows: (body.interactive.action?.sections?.[0]?.rows ?? []).map((r) => ({
            id: r.id ?? '',
            title: r.title ?? '',
          })),
        };
      }
    }
    return { button: '', rows: [] };
  };

  const lastButtons = (): { id: string; title: string }[] => {
    for (const body of [...parsed()].reverse()) {
      if (body.interactive?.type === 'button') {
        return (body.interactive.action?.buttons ?? []).map((b) => ({
          id: b.reply?.id ?? '',
          title: b.reply?.title ?? '',
        }));
      }
    }
    return [];
  };

  const lastText = (): string => {
    for (const body of [...parsed()].reverse()) {
      if (body.type === 'text') return body.text?.body ?? '';
    }
    return '';
  };

  const presence = async (): Promise<{ status: string; until_at: unknown } | undefined> => {
    const res = await pool.query<{ status: string; until_at: unknown }>(
      'SELECT status, until_at FROM presence_report WHERE seat_id = $1 ORDER BY reported_at DESC LIMIT 1',
      [officerSeat],
    );
    return res.rows[0];
  };

  /**
   * 🔴 **The chase is where *Where I am* lives now** — the owner's correction of 2026-08-23.
   *
   * It used to ride the acknowledgement, beside the two stages. The acknowledgement carries no
   * buttons at all any more (`thankForAcknowledgement`), so `api/followUp.ts` — which had
   * deliberately left availability off, because from `routed` the stages alone are Meta's cap —
   * adds it **when there is room**. Without that this whole file describes a screen no officer
   * can reach, and Phase C2's claim that nothing needs a browser dies silently.
   */
  async function chase(incidentId: string): Promise<void> {
    const res = await fetch(`${base}/incidents/${incidentId}/follow-up`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  }

  /** Acknowledge, chase, and hand back the "Where I am" button that comes with the stages. */
  async function whereButton(): Promise<string> {
    const id = await raise(`Where test ${RUN}`);
    await inbound(templateTap('Acknowledge'));
    sent = [];
    await chase(id);
    const button = lastButtons().find((b) => b.title === 'Where I am');
    expect(button).toBeDefined();
    return button?.id ?? '';
  }

  it('offers Where I am beside the stages, and it is the third of three', async () => {
    const id = await raise(`Offer test ${RUN}`);
    await inbound(templateTap('Acknowledge'));
    sent = [];
    await chase(id);

    const buttons = lastButtons();
    // Two stages plus this is three, which is Meta's cap exactly. A fourth cannot be added here
    // without deciding which of these stops being offered.
    expect(buttons.map((b) => b.title)).toEqual(['Responding', 'Resolved', 'Where I am']);
  });

  it('offers the two answers as a list', async () => {
    const id = await whereButton();
    sent = [];

    expect(await inbound(ourTap(id, 'Where I am'))).toBe(200);

    const list = lastList();
    expect(list.rows).toHaveLength(PRESENCE_STATUSES.length);
    // Both states the district settled on, and no more.
    for (const status of PRESENCE_STATUSES) {
      expect(list.rows.some((r) => r.id.includes(`:${status}:`))).toBe(true);
    }
  });

  it('records available on the tap, with no end asked for', async () => {
    const id = await whereButton();
    await inbound(ourTap(id, 'Where I am'));

    const row = lastList().rows.find((r) => r.id.includes(':available:'));
    expect(row).toBeDefined();
    sent = [];

    expect(await inbound(listPick(row?.id ?? '', row?.title ?? ''))).toBe(200);

    const written = await presence();
    expect(written?.status).toBe('available');
    // Nothing polls an officer, so there is no *until when* to ask (ADR-0033).
    expect(written?.until_at).toBeNull();
    expect(lastText()).toContain('Recorded');
  });

  it('records unavailable on the tap too, with no how-long list', async () => {
    const id = await whereButton();
    await inbound(ourTap(id, 'Where I am'));

    const row = lastList().rows.find((r) => r.id.includes(':unavailable:'));
    expect(row).toBeDefined();
    sent = [];

    expect(await inbound(listPick(row?.id ?? '', row?.title ?? ''))).toBe(200);

    const written = await presence();
    expect(written?.status).toBe('unavailable');
    expect(written?.until_at).toBeNull();
    // The old second list ("until when?") is gone: the tap is the whole interaction.
    expect(lastText()).toContain('Recorded');
  });

  it('ignores a row this version does not understand rather than guessing', async () => {
    const before = await presence();
    sent = [];

    // A well-formed id naming a status that does not exist. Acting on half of it is how a tap
    // lands on the wrong record.
    expect(
      await inbound(listPick(`avail:sleeping:${randomUUID()}:${randomUUID()}`, 'Sleeping')),
    ).toBe(200);

    expect((await presence())?.status).toBe(before?.status);
    expect(sent).toHaveLength(0);
  });
});
