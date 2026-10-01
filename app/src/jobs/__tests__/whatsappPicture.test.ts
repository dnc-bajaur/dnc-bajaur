/**
 * The photograph actually reaches the message — M10-34a.
 *
 * ## Why this file exists, which is the part worth reading
 *
 * `1d543eb` built per-message template selection (M10-28…33) and shipped **four passing tests**
 * for it. Every one of those calls `sendWhatsApp` **directly** and hands it a `media` field
 * itself — faithfully, and that is exactly the problem. They prove the *transport* can carry a
 * picture and say **nothing** about whether anything ever gives it one. It never did:
 * `jobs/whatsappChannel.ts` was not touched by that commit, so `message.media` was permanently
 * `undefined`, `templateFor`'s image branch was unreachable in production, and `uploadMedia` had
 * no caller outside its own test. The district would have set `WHATSAPP_TEMPLATE_IMAGE`, watched
 * `doctor` report *"a JPG rides the message"*, and gone on sending links.
 *
 * **That is the `publicOrigin` defect of 2026-08-13 in a new file** — *every test supplies the
 * option itself, so the only place it can be missing is the place no test constructs.* So these
 * assertions are made **at the channel**, on the body the provider is actually handed, and never
 * on anything this file passes in.
 *
 * Real PostgreSQL, real evidence on disk, real fold, real tokens. Only the provider is stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append } from '../../db/eventStore.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { whatsappChannel } from '../whatsappChannel.js';
import { COMMUNICATION_TYPES, store } from '../../ops/evidence.js';
import type { IncidentEvent, MessageKind } from '../../domain/events.js';
import type { WhatsAppConfig } from '../../ops/whatsapp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/**
 * A real JPEG, by its magic number — not a file called `.jpg`.
 *
 * `ops/evidence.ts` sniffs the bytes and refuses a mismatch (M9-14), so a fake would be rejected
 * at `store()` and this file would pass for the wrong reason. `FF D8 FF E0` is the JFIF opener;
 * `FF D9` is the end-of-image marker.
 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
/** Likewise a real PDF — the four bytes `%PDF` and a trailer. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');

const BASE: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message_v2',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

/** The district once Meta has approved the picture template and `.env` names it. */
const WITH_IMAGE: WhatsAppConfig = {
  ...BASE,
  imageTemplate: { name: 'district_message_img', language: 'en' },
};

/**
 * Bajaur today: the picture template configured **alongside** the tappable ones — 2026-09-04.
 *
 * `noticeTemplate` and `responseCategories` exist so a meeting can be answered by attendance and
 * an order by its own three buttons. Both are meaningless if a photograph silently outranks them.
 */
const WITH_IMAGE_AND_ANSWERS: WhatsAppConfig = {
  ...WITH_IMAGE,
  noticeTemplate: { name: 'district_notice_v2', language: 'en' },
  emergencyTemplate: { name: 'district_emergency_v2', language: 'en' },
  responseCategories: new Set(['order']),
};

/**
 * **The stronger fix, once Meta approves it — 2026-09-04, the owner's own line.** Not every
 * picture becomes a link with buttons offered afterwards: a meeting or a response category the
 * owner named (advisory, order, schedule, information) keeps the photograph **in** the message
 * once its own picture-carrying template is approved and named here.
 */
const WITH_APPROVED_IMAGE_ANSWERS: WhatsAppConfig = {
  ...WITH_IMAGE_AND_ANSWERS,
  noticeImageTemplate: { name: 'district_notice_img_v1', language: 'en' },
  responseImageCategories: new Set(['order']),
};

interface SentMessage {
  readonly template: {
    readonly name: string;
    /** Inside `template`, not beside it — the shape Meta's own API takes. */
    readonly components: readonly {
      readonly type: string;
      readonly parameters?: readonly { readonly image?: { readonly id: string } }[];
    }[];
  };
}

describe.skipIf(dbUrl === undefined)('the picture reaches the message (integration)', () => {
  let pool: Pool;
  let root: string;
  let seatId: string;
  let personId: string;

  /** Every request the provider was handed, split by what it was for. */
  let uploads: string[];
  let sends: string[];
  let uploadStatus: number;

  const stubFetch = (async (url: string, init?: { body?: unknown }) => {
    const target = String(url);
    if (target.endsWith('/media')) {
      uploads.push(target);
      return new Response(JSON.stringify({ id: `media_${String(uploads.length)}` }), {
        status: uploadStatus,
      });
    }
    sends.push(typeof init?.body === 'string' ? init.body : '');
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${String(sends.length)}` }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const channelWith = (config: WhatsAppConfig): ReturnType<typeof whatsappChannel> =>
    whatsappChannel({
      pool,
      config,
      publicOrigin: 'https://dnc.example.invalid',
      fetchImpl: stubFetch,
      evidenceRoot: root,
    });

  /** One incident, of whatever kind the case needs, with whatever file it needs attached. */
  async function anIncidentWith(
    file: { bytes: Buffer; contentType: string } | null,
    kind: MessageKind = 'emergency',
    category = 'rta',
  ): Promise<string> {
    const incidentId = randomUUID();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: seatId,
        sourceChannel: 'mobile',
        payload: {
          reportId: randomUUID(),
          category,
          severity: 'high',
          kind,
          description: `picture test ${RUN}`,
        },
      } as unknown as IncidentEvent,
    ]);

    if (file !== null) {
      const stored = await store(pool, root, {
        incidentId,
        bytes: file.bytes,
        contentType: file.contentType,
        filename: file.contentType === 'application/pdf' ? 'notice.pdf' : 'scene.jpg',
        seatId,
        personId: null,
        allowed: COMMUNICATION_TYPES,
      });
      // Loudly, because a silently unstored file makes every assertion below vacuous.
      if (!stored.ok) throw new Error(`could not store the fixture: ${stored.why}`);
    }
    return incidentId;
  }

  /**
   * Deliver to the seeded officer and hand back what the provider received.
   *
   * ⚠️ **`handedOff` is `pending`, NOT `ok`, and the first version of this file got it wrong.**
   * A successful send deliberately returns `ok: false` with `pending: true` — ADR-0014's rule
   * that Meta accepting a message is not an officer knowing about an emergency. Asserting `ok`
   * here would demand the channel lie about delivery, so the test would have been "fixed" by
   * breaking the one property this channel exists to protect.
   */
  async function deliverOne(
    config: WhatsAppConfig,
    incidentId: string,
    channel = channelWith(config),
  ): Promise<{ handedOff: boolean; failure: string | null; sent: SentMessage }> {
    const before = sends.length;
    const result = await channel.deliver({
      seatId,
      personId,
      incidentId,
      reason: 'dispatched',
      attemptId: randomUUID(),
    });
    const body = sends[before];
    if (body === undefined) throw new Error('nothing was sent at all');
    return {
      handedOff: result.ok || result.pending === true,
      failure: result.ok || result.pending === true ? null : result.failure,
      sent: JSON.parse(body) as SentMessage,
    };
  }

  const header = (sent: SentMessage): { readonly image?: { readonly id: string } } | undefined =>
    sent.template.components.find((c) => c.type === 'header')?.parameters?.[0];

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = await mkdtemp(join(tmpdir(), 'dnc-picture-'));

    const dept = await seedDepartment(pool, `Rescue (pic ${RUN})`);
    const actor = await seedActor(pool, { title: `Duty Officer (pic ${RUN})`, departmentId: dept });
    seatId = actor.seatId;
    personId = actor.personId;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await pool?.end();
  });

  beforeEach(() => {
    uploads = [];
    sends = [];
    uploadStatus = 200;
  });

  /**
   * **Test 1 is the whole point of the file, and it was verified failing before the wiring.**
   *
   * Against the unwired channel it reported `expected undefined to be defined` — no header
   * component at all — while every other test in the repository stayed green.
   */
  it('puts a JPEG on the message, on the picture template', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' });

    const { handedOff, failure, sent } = await deliverOne(WITH_IMAGE, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(sent.template.name).toBe('district_message_img');
    expect(header(sent)?.image?.id).toBe('media_1');
  });

  /**
   * **The link and the picture are alternatives — the owner's instruction, 2026-08-17.**
   *
   * They checked it on a handset and saw both on one message. A link under a photograph the
   * officer is already looking at leads to the same photograph, and it costs the ~40 characters
   * `SEPARATOR` reserves out of `{{2}}` — paid for by cutting the operator's own words.
   *
   * ~~The link stays, because `opened_count` is the only record that anybody looked.~~ Reversed:
   * for a picture rendered in the chat there was never anything to record, so the count was
   * over-claiming rather than informing. **A PDF keeps both** (test below).
   */
  it('drops the file link entirely when the picture rides', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' });

    const { sent } = await deliverOne(WITH_IMAGE, incidentId);

    expect(JSON.stringify(sent)).not.toContain('/file/');
    // And no token was minted for a link nobody is going to be sent.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM file_token WHERE incident_id = $1',
      [incidentId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  /**
   * A PDF never rides, and this is a decision rather than a gap — the owner chose images only,
   * so no document template was ever submitted.
   */
  it('leaves a PDF on the ordinary template, as a link, and never uploads it', async () => {
    const incidentId = await anIncidentWith({ bytes: PDF, contentType: 'application/pdf' });

    const { sent } = await deliverOne(WITH_IMAGE, incidentId);

    expect(uploads).toHaveLength(0);
    expect(sent.template.name).toBe('district_message_v2');
    expect(header(sent)).toBeUndefined();
    expect(JSON.stringify(sent)).toContain('https://dnc.example.invalid/file/');
  });

  /** Bajaur's state until `.env` names the template: nothing is uploaded and nothing changes. */
  it('sends exactly as before when no picture template is configured', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' });

    const { handedOff, failure, sent } = await deliverOne(BASE, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(0);
    expect(sent.template.name).toBe('district_message_v2');
    expect(header(sent)).toBeUndefined();
  });

  /**
   * **The failure path is the one that must never cost a message — INV-01.**
   *
   * An upload Meta refuses leaves the district exactly where it is today: the ordinary template
   * and a link. A channel that failed the send instead would mean a photograph nobody could
   * upload became **an emergency nobody was told about**.
   *
   * ⚠️ **Since 2026-08-17 this test also guards the link itself.** The link is now dropped
   * whenever the picture rides, so the condition has to be *"did it ride"* and never *"is it a
   * JPEG"* — written the second way, a failed upload would send an officer neither the
   * photograph nor any way to reach it, and it would do that only on the day the upload broke.
   */
  it('still sends, on the ordinary template, when the upload fails', async () => {
    uploadStatus = 500;
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' });

    const { handedOff, failure, sent } = await deliverOne(WITH_IMAGE, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(sent.template.name).toBe('district_message_v2');
    expect(header(sent)).toBeUndefined();
    expect(JSON.stringify(sent)).toContain('https://dnc.example.invalid/file/');
  });

  /**
   * **Told to a department, uploaded once.**
   *
   * `deliver` runs per recipient, so without the channel's cache a notice to forty officers is
   * forty uploads of the same photograph — from the one machine also taking emergency reports.
   * Three deliveries here, one upload, and **every message still carries the picture**: a cache
   * that saved the upload by dropping the header would pass a naive count and fail the district.
   */
  it('uploads once for a whole department and still puts the picture on every message', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' });
    const channel = channelWith(WITH_IMAGE);

    const first = await deliverOne(WITH_IMAGE, incidentId, channel);
    const second = await deliverOne(WITH_IMAGE, incidentId, channel);
    const third = await deliverOne(WITH_IMAGE, incidentId, channel);

    expect(uploads).toHaveLength(1);
    for (const { sent } of [first, second, third]) {
      expect(sent.template.name).toBe('district_message_img');
      expect(header(sent)?.image?.id).toBe('media_1');
    }
  });

  /**
   * **The bug reported from a real handset, 2026-09-04.** A meeting notice with a photograph was
   * going out on the picture template — `Acknowledge` / `Open details` — instead of asking
   * `Attending` / `Not attending` / `Sending someone`. Worse than a wrong button: `listFor` has
   * nothing to offer a meeting on tap, so tapping `Acknowledge` produced a generic thank-you and
   * the district never learned who was coming at all.
   */
  it('keeps the meeting template — and its RSVP — even when a photograph is attached', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' }, 'meeting');

    const { handedOff, failure, sent } = await deliverOne(WITH_IMAGE_AND_ANSWERS, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(0);
    expect(sent.template.name).toBe('district_notice_v2');
    expect(header(sent)).toBeUndefined();
    expect(JSON.stringify(sent)).toContain('https://dnc.example.invalid/file/');
  });

  /**
   * The gentler half of the same defect: an order in `WHATSAPP_RESPONSE_CATEGORIES` with a
   * photograph attached kept its picture and lost its own template — the officer got `Acknowledge`
   * / `Open details` and only reached the district's three real options after an extra tap, as a
   * list rather than as buttons. The photograph now travels as a link, exactly like a PDF, so the
   * category's own buttons are the first thing the officer sees.
   */
  it('keeps an order on its own response template even when a photograph is attached', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' }, 'order');

    const { handedOff, failure, sent } = await deliverOne(WITH_IMAGE_AND_ANSWERS, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(0);
    expect(sent.template.name).toBe('dnc_response_order_v2');
    expect(header(sent)).toBeUndefined();
    expect(JSON.stringify(sent)).toContain('https://dnc.example.invalid/file/');
  });

  /**
   * **The owner's own instruction, once Meta approves `district_notice_img_v1`:** the photograph
   * rides IN the meeting notice, not as a link, and the RSVP still comes on the same message —
   * `district_notice_img_v1` carries the same three quick replies as `district_notice_v2`, so
   * nothing is sent for them (a quick reply carries no parameter); only the header and the body
   * are built, and Meta renders the approved buttons underneath from the template itself.
   */
  it('puts the photograph IN the meeting notice once its own picture template is approved', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' }, 'meeting');

    const { handedOff, failure, sent } = await deliverOne(WITH_APPROVED_IMAGE_ANSWERS, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(sent.template.name).toBe('district_notice_img_v1');
    expect(header(sent)?.image?.id).toBe('media_1');
    // No URL button on this template — nothing to attach an acknowledge token to.
    expect(sent.template.components.some((c) => c.type === 'button')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('/file/');
  });

  /** The same fix, for a response category the owner named — order, here. */
  it('puts the photograph IN an order alert once its own picture template is approved', async () => {
    const incidentId = await anIncidentWith({ bytes: JPEG, contentType: 'image/jpeg' }, 'order');

    const { handedOff, failure, sent } = await deliverOne(WITH_APPROVED_IMAGE_ANSWERS, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(sent.template.name).toBe('dnc_response_order_img_v1');
    expect(header(sent)?.image?.id).toBe('media_1');
    expect(sent.template.components.some((c) => c.type === 'button')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('/file/');
  });

  /**
   * **A category the owner did NOT name keeps sending its photograph as a link** — `fire` has no
   * picture-carrying template even though `security`/`fire`/… all answer on their own
   * `dnc_response_*` template today. `WITH_APPROVED_IMAGE_ANSWERS` only names `order`.
   */
  it('still sends a fire alert’s photograph as a link — no picture template was asked for it', async () => {
    const config: WhatsAppConfig = {
      ...WITH_APPROVED_IMAGE_ANSWERS,
      responseCategories: new Set(['order', 'fire']),
    };
    const incidentId = await anIncidentWith(
      { bytes: JPEG, contentType: 'image/jpeg' },
      'emergency',
      'fire',
    );

    const { handedOff, failure, sent } = await deliverOne(config, incidentId);

    expect(failure).toBeNull();
    expect(handedOff).toBe(true);
    expect(uploads).toHaveLength(0);
    expect(sent.template.name).toBe('dnc_response_fire_v1');
    expect(header(sent)).toBeUndefined();
    expect(JSON.stringify(sent)).toContain('https://dnc.example.invalid/file/');
  });
});
