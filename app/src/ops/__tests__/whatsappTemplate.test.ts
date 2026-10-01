/**
 * What Meta approved, against what this software sends — M6-26.
 *
 * **`CLAUDE.md` §5 says the template approval is where the surprise will be. This is the answer
 * to that sentence.** A template is approved once and changed slowly; every mismatch below is a
 * send that fails at 02:00 on a real night, as a provider error nobody in a district office can
 * read — and each one is caught here instead, weeks earlier, in words naming the fix.
 *
 * The check and the sender read the same `ALERT_TEMPLATE`, so "what we asked Meta to approve"
 * and "what the code sends" cannot drift into disagreeing without one of these failing.
 */

import { describe, expect, it } from 'vitest';

import {
  ALERT_TEMPLATE,
  ALERT_TEMPLATE_IMAGE,
  ALERT_TEMPLATE_IMAGE_V3,
  ALERT_TEMPLATE_TEXT,
  EMERGENCY_TEMPLATE,
  NOTICE_TEMPLATE,
  RESPONSE_TEMPLATES,
  RESPONSE_TEMPLATE_BY_CATEGORY,
  ackBase,
  categoryLabelsLocation,
  categoryNamesKindInHeader,
  responseTemplateFor,
  shapeNamed,
  templateProblems,
  type ApprovedTemplate,
  type TemplateShape,
} from '../whatsappTemplate.js';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_OPTIONS,
  templateCategoryFor,
} from '../../domain/responseOptions.js';
import { MESSAGE_KINDS } from '../../domain/events.js';

/** This installation's address. The button's prefix is derived from it and never hard-coded. */
const DISTRICT = 'https://dnc.example.pk';

/**
 * What the checker compares against, with the origin filled in — as `doctor.mjs` does.
 *
 * `ALERT_TEMPLATE.urlButton.base` is deliberately the unusable literal `{PUBLIC_ORIGIN}/ack/`
 * (see the note beside it): source cannot know the district's address, and the placeholder that
 * *looked* like an address is what put a dead acknowledge button in front of every officer in
 * Bajaur until 2026-08-12. Every check here therefore supplies the origin, because every real
 * caller has to.
 */
const EXPECTED: TemplateShape = {
  ...ALERT_TEMPLATE,
  urlButton:
    ALERT_TEMPLATE.urlButton === null
      ? null
      : { ...ALERT_TEMPLATE.urlButton, base: ackBase(DISTRICT) },
};

const problemsFor = (t: ApprovedTemplate | null): readonly { what: string; fix: string }[] =>
  templateProblems(t, EXPECTED);

/** What Meta returns for a template submitted exactly as `docs/whatsapp-template.md` says. */
function approved(overrides: Partial<ApprovedTemplate> = {}): ApprovedTemplate {
  return {
    name: 'district_message',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'URL', text: 'Acknowledged', url: `${ackBase(DISTRICT)}{{1}}` }],
      },
    ],
    ...overrides,
  };
}

describe('the wording and the code agree', () => {
  it('has one {{n}} marker for every parameter the software sends', () => {
    /**
     * The single most important assertion in this file.
     *
     * `ALERT_TEMPLATE_TEXT` is what a human pastes into Meta's form; `ALERT_TEMPLATE.body` is
     * what `sendWhatsApp` builds parameters from. Meta refuses the **whole message** when the
     * counts differ, so a district that tidied one line out of the wording would find every
     * alert failing — and the two live in the same file precisely so this test can hold them
     * together.
     */
    const markers = new Set(ALERT_TEMPLATE_TEXT.match(/\{\{\s*\d+\s*\}\}/g) ?? []);

    expect(markers.size).toBe(ALERT_TEMPLATE.body.length);
    for (let i = 1; i <= ALERT_TEMPLATE.body.length; i += 1) {
      expect(ALERT_TEMPLATE_TEXT).toContain(`{{${String(i)}}}`);
    }
  });

  it('is a utility template, not marketing', () => {
    // Not a nicety: a marketing template is rate limited as advertising and priced as
    // advertising, so a district's emergency alerts would be throttled and cost more.
    expect(ALERT_TEMPLATE.category).toBe('UTILITY');
  });

  it('carries the acknowledge button, because that is what meets the obligation', () => {
    // Without it an officer has no way to confirm they have an emergency, and every obligation
    // stays unmet on the board for ever (ADR-0014, M6-22).
    expect(ALERT_TEMPLATE.urlButton).not.toBeNull();
  });

  it('says which district before anything else', () => {
    // An officer may be on three WhatsApp groups about three different things at 02:00. The
    // first line has to answer "what is this".
    expect(ALERT_TEMPLATE_TEXT.split('\n')[0]).toContain('Bajaur');
  });
});

describe('comparing it against what Meta approved', () => {
  it('finds nothing wrong with a correctly submitted template', () => {
    expect(problemsFor(approved())).toEqual([]);
  });

  it('says what to do when the template does not exist at all', () => {
    const [problem] = problemsFor(null);

    expect(problem?.what).toContain('district_message');
    // Names the screen and the file, because the person reading this has not built the software.
    expect(problem?.fix).toContain('docs/whatsapp-template.md');
  });

  it('treats a pending review as waiting rather than broken', () => {
    // The ordinary state for a few hours after submission. "Wait" is more useful than "broken",
    // and the doctor renders this one yellow rather than red for exactly that reason.
    const [problem] = problemsFor(approved({ status: 'PENDING' }));

    expect(problem?.what).toContain('not finished reviewing');
    expect(problem?.fix).toContain('Nothing to do');
  });

  it('names the usual cause when Meta rejected it', () => {
    const problems = problemsFor(approved({ status: 'REJECTED' }));

    expect(problems[0]?.fix).toContain('MARKETING');
  });

  it('catches a marketing category, which nothing else would point at', () => {
    const problems = problemsFor(approved({ category: 'MARKETING' }));

    expect(problems.some((p) => p.what.includes('MARKETING'))).toBe(true);
    expect(problems.find((p) => p.what.includes('MARKETING'))?.fix).toContain('rate limited');
  });

  it('catches a parameter count that would fail every send', () => {
    /**
     * The commonest way this breaks: somebody "tidies" the location line out of the template
     * while the software still sends two parameters. Meta refuses the whole message, so the
     * district's alerts stop — completely, and only for real traffic.
     */
    const problems = problemsFor(
      approved({
        components: [
          { type: 'BODY', text: 'District Nerve Center — Bajaur\n\n{{1}}' },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Acknowledged', url: 'https://x/ack/{{1}}' }],
          },
        ],
      }),
    );

    const count = problems.find((p) => p.what.includes('parameters'));
    expect(count).toBeDefined();
    expect(count?.what).toContain('1 parameters');
    expect(count?.fix).toContain('fails every send');
  });

  it('catches a missing acknowledge button', () => {
    const problems = problemsFor(
      approved({ components: [{ type: 'BODY', text: ALERT_TEMPLATE_TEXT }] }),
    );

    const button = problems.find((p) => p.what.includes('URL button'));
    expect(button).toBeDefined();
    // Says what it costs, not just that it is absent.
    expect(button?.fix).toContain('every obligation stays unmet');
  });

  it('catches a static URL button, which looks right and is not', () => {
    // A button pointing at a fixed page rather than `.../ack/{{1}}` renders identically in
    // Meta's preview and acknowledges nothing.
    const problems = problemsFor(
      approved({
        components: [
          { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Open', url: 'https://dnc.example.pk/' }],
          },
        ],
      }),
    );

    expect(problems.some((p) => p.what.includes('URL button'))).toBe(true);
  });

  it('catches a button that points at somebody else, which is the bug this check was written for', () => {
    /**
     * **The worst fault this system has had, and every other check passed while it was live.**
     *
     * `district_message` was approved with `https://dnc.example.gov.pk/ack/{{1}}` — the
     * placeholder from source, which reads exactly like a real Pakistani government address. So
     * for as long as the district had a template, every officer who tapped *"I have this"* was
     * sent to a domain that does not exist. The send returned 200, Meta reported the message
     * **delivered**, `doctor` said the template matched, and the only evidence anywhere was
     * `DNS_PROBE_FINISHED_NXDOMAIN` on one officer's handset.
     *
     * The check above asks *is there a dynamic URL button*. It was true. A button existing is
     * not a button working, and nothing asked the second question until now.
     */
    const problems = problemsFor(
      approved({
        components: [
          { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'URL', text: 'Acknowledged', url: 'https://dnc.example.gov.pk/ack/{{1}}' },
            ],
          },
        ],
      }),
    );

    const wrong = problems.find((p) => p.what.includes('acknowledge button points at'));
    expect(wrong).toBeDefined();
    // Names both halves, because "wrong URL" alone does not tell you which one is wanted.
    expect(wrong?.what).toContain('dnc.example.gov.pk');
    expect(wrong?.what).toContain(DISTRICT);
    // And says the part that is easy to miss: a URL change is a fresh review, not a save.
    expect(wrong?.fix).toContain('needs review again');
  });

  it('accepts the right prefix and rejects one that only differs in path', () => {
    // A right host with a wrong path fails exactly as totally as a wrong host — the officer
    // taps, reaches a 404, and the obligation stays unmet with no fault recorded (INV-03).
    expect(problemsFor(approved())).toEqual([]);

    const problems = problemsFor(
      approved({
        components: [
          { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Acknowledged', url: `${DISTRICT}/acknowledge/{{1}}` }],
          },
        ],
      }),
    );

    expect(problems.some((p) => p.what.includes('acknowledge button points at'))).toBe(true);
  });

  it('reports rather than throws on a shape Meta has renamed', () => {
    /**
     * This is somebody else's JSON from a public API, read by a script a district runs when
     * something is already wrong. **A checker that throws is a checker somebody stops running**
     * — and it would throw on exactly the day Meta changed a field name, which is a day the
     * district needs it most.
     */
    expect(() => problemsFor({} as ApprovedTemplate)).not.toThrow();
    expect(() => problemsFor({ components: 'all of them' })).not.toThrow();
    expect(() => problemsFor({ components: [{ type: 'BODY' }] })).not.toThrow();
  });
});

/**
 * The two tappable templates — 2026-08-19.
 *
 * These check the two ways this pair breaks, and they break differently from everything above it.
 * A wrong **button position** fails every send loudly, at Meta. Wrong **quick-reply wording**
 * fails nothing at all: the sends keep working and the district's own record quietly starts
 * carrying words nobody chose, because a tap arrives back as the label on the button.
 */
describe('the templates an officer can tap — 2026-08-19', () => {
  const withOrigin = (shape: TemplateShape): TemplateShape => ({
    ...shape,
    urlButton: shape.urlButton === null ? null : { ...shape.urlButton, base: ackBase(DISTRICT) },
  });

  /** `district_emergency_v2` as Meta returns it: the quick reply first, the link second. */
  function approvedEmergency(
    buttons: readonly Record<string, unknown>[] = [
      { type: 'QUICK_REPLY', text: 'Acknowledge' },
      { type: 'URL', text: 'Open details', url: `${ackBase(DISTRICT)}{{1}}` },
    ],
  ): ApprovedTemplate {
    return {
      name: 'district_emergency_v2',
      language: 'en',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
        { type: 'BUTTONS', buttons },
      ],
    };
  }

  it('passes the emergency template exactly as Meta approved it', () => {
    expect(templateProblems(approvedEmergency(), withOrigin(EMERGENCY_TEMPLATE))).toEqual([]);
  });

  it('catches the acknowledge link having moved to a different button', () => {
    /**
     * **The failure worth the most here.** Meta matches a button parameter by position and
     * nothing else, so a template whose buttons are reordered — or a shape whose index is
     * wrong — means the token goes to the quick reply. Meta then refuses **every** message on
     * that template, emergencies included, as a provider error nobody in a district office can
     * read at 02:00.
     */
    const reordered = approvedEmergency([
      { type: 'URL', text: 'Open details', url: `${ackBase(DISTRICT)}{{1}}` },
      { type: 'QUICK_REPLY', text: 'Acknowledge' },
    ]);

    const problems = templateProblems(reordered, withOrigin(EMERGENCY_TEMPLATE));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.what).toContain('button 1 on the approved template');
    expect(problems[0]?.fix).toContain('every send on this template');
  });

  it('catches a quick reply that was reworded at Meta', () => {
    /**
     * Nothing about a send breaks when this happens, which is exactly why it is checked. The tap
     * comes back as its own label and `webhooks.ts` writes those words onto the incident — so a
     * template edited to say "Present" changes the district's record, silently, for ever.
     */
    const reworded = approvedEmergency([
      { type: 'QUICK_REPLY', text: 'Got it' },
      { type: 'URL', text: 'Open details', url: `${ackBase(DISTRICT)}{{1}}` },
    ]);

    const problems = templateProblems(reworded, withOrigin(EMERGENCY_TEMPLATE));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.what).toContain('"Got it"');
    expect(problems[0]?.what).toContain('"Acknowledge"');
  });

  it('holds the meeting template to its three answers, in order', () => {
    const approvedNotice = (texts: readonly string[]): ApprovedTemplate => ({
      name: 'district_notice_v2',
      language: 'en',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
        {
          type: 'BUTTONS',
          buttons: texts.map((text) => ({ type: 'QUICK_REPLY', text })),
        },
      ],
    });

    expect(
      templateProblems(
        approvedNotice(['Attending', 'Not attending', 'Sending someone']),
        NOTICE_TEMPLATE,
      ),
    ).toEqual([]);

    /**
     * Order is compared, not just the set. These are read left to right on a handset, and
     * *"Not attending"* sitting first is a different message to an officer at a glance even
     * though the same three words are present.
     */
    const swapped = templateProblems(
      approvedNotice(['Not attending', 'Attending', 'Sending someone']),
      NOTICE_TEMPLATE,
    );
    expect(swapped).toHaveLength(1);
  });

  it('asks nothing of a URL button on the meeting template, which has none', () => {
    // `urlButton: null` is the load-bearing line on that shape: a send that attaches an
    // acknowledge token to a template with nowhere to put it is a message Meta refuses.
    expect(NOTICE_TEMPLATE.urlButton).toBeNull();
    expect(EMERGENCY_TEMPLATE.urlButton?.index).toBe(1);
  });

  it('leaves every template that predates this alone', () => {
    // Nothing about quick replies may reach the templates Bajaur has been sending on since
    // August. An empty list is checked rather than assumed — it is what keeps the new check
    // silent for the two that carry one button and no taps.
    expect(ALERT_TEMPLATE.quickReplies).toEqual([]);
    expect(ALERT_TEMPLATE.urlButton?.index).toBe(0);
    expect(problemsFor(approved())).toEqual([]);
  });
});

/**
 * **The photograph template that can be answered — `district_message_img_v3`, 2026-08-25.**
 *
 * Submitted to Meta and deliberately not switched on. Nothing here asserts that Bajaur sends on
 * it; what these pin is that the day somebody points `WHATSAPP_TEMPLATE_IMAGE` at it, the send
 * is built against **its** shape and not against the one that happened to be current when
 * `templateFor` was written.
 */
describe('the photograph template an officer can tap — 2026-08-25', () => {
  const withOrigin = (shape: TemplateShape): TemplateShape => ({
    ...shape,
    urlButton: shape.urlButton === null ? null : { ...shape.urlButton, base: ackBase(DISTRICT) },
  });

  /** As Meta returns it: a picture, then the quick reply, then the link. */
  const approvedImageV3 = (): ApprovedTemplate => ({
    name: 'district_message_img_v3',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: ALERT_TEMPLATE_TEXT },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Acknowledge' },
          { type: 'URL', text: 'Open details', url: `${ackBase(DISTRICT)}{{1}}` },
        ],
      },
    ],
  });

  it('passes exactly as Meta would approve it', () => {
    expect(templateProblems(approvedImageV3(), withOrigin(ALERT_TEMPLATE_IMAGE_V3))).toEqual([]);
  });

  /**
   * 🔴 **The one fact that makes this template different from the one it replaces.**
   *
   * `_img_v2`'s link is button one; `_img_v3`'s is button two, because a quick reply now sits in
   * front of it. Meta matches a button parameter by **position and nothing else**, so a send
   * that names index 0 against this template attaches the acknowledge token to the quick reply
   * — and Meta then refuses **every** message on it, emergencies included.
   */
  it('puts the link SECOND, where its predecessor put it first', () => {
    expect(ALERT_TEMPLATE_IMAGE.urlButton?.index).toBe(0);
    expect(ALERT_TEMPLATE_IMAGE.quickReplies).toEqual([]);

    expect(ALERT_TEMPLATE_IMAGE_V3.urlButton?.index).toBe(1);
    expect(ALERT_TEMPLATE_IMAGE_V3.quickReplies).toEqual(['Acknowledge']);
  });

  /**
   * ⚠️ **Its body is `ALERT_TEMPLATE`'s, and that is worth a test rather than a comment.**
   *
   * The district's officers read one wording whichever template a message travels on, and
   * `messageFor` builds one set of parameters for all of them. A body that drifted here would
   * mean a photograph arriving with different words on it — and a parameter count that drifted
   * would mean Meta refusing the send outright.
   */
  it('says exactly what every other template says', () => {
    expect(ALERT_TEMPLATE_IMAGE_V3.body).toEqual(ALERT_TEMPLATE.body);
    expect(ALERT_TEMPLATE_IMAGE_V3.body).toEqual(EMERGENCY_TEMPLATE.body);
    expect(ALERT_TEMPLATE_IMAGE_V3.category).toBe('UTILITY');
  });

  it('is the emergency template with a picture on it, and nothing else', () => {
    /**
     * Said as a comparison rather than field by field, because that is the claim: everything
     * about answering it is `district_emergency_v2`, and the header is the whole difference —
     * which is also the whole reason it needed a new submission to Meta at all.
     */
    expect({ ...ALERT_TEMPLATE_IMAGE_V3, name: null, header: null }).toEqual({
      ...EMERGENCY_TEMPLATE,
      name: null,
      header: null,
    });
    expect(ALERT_TEMPLATE_IMAGE_V3.header).toBe('IMAGE');
    expect(EMERGENCY_TEMPLATE.header).toBeNull();
  });

  /**
   * 🔴 **`shapeNamed` is what keeps a name in `.env` and a button position in the source from
   * disagreeing**, and the disagreement is total: Meta refuses every message on the template.
   */
  describe('looking a shape up by the name Meta knows it as', () => {
    it('finds every template this district could be configured to send on', () => {
      for (const shape of [
        ALERT_TEMPLATE,
        ALERT_TEMPLATE_IMAGE,
        ALERT_TEMPLATE_IMAGE_V3,
        NOTICE_TEMPLATE,
        EMERGENCY_TEMPLATE,
      ]) {
        expect(shapeNamed(shape.name)).toBe(shape);
      }
    });

    it('gives back the two picture templates’ different button positions', () => {
      expect(shapeNamed('district_message_img_v2')?.urlButton?.index).toBe(0);
      expect(shapeNamed('district_message_img_v3')?.urlButton?.index).toBe(1);
    });

    /**
     * A district that approved its own wording under its own name is sending on a shape this
     * source cannot see. `undefined` is the honest answer, and the callers fall back to the
     * shape they document — which is exactly what they did before this function existed.
     */
    it('does not invent a shape for a name it has never heard of', () => {
      expect(shapeNamed('district_message_img_v9')).toBeUndefined();
      expect(shapeNamed('')).toBeUndefined();
    });
  });
});

/**
 * **The category-response templates — 2026.**
 *
 * One per emergency category, meeting excluded. Submitted ahead of the send path, so nothing here
 * asserts Bajaur sends on them; what these pin is that each is a shape Meta will accept the day it
 * is put in front of the review queue — and that the button labels a tap comes back as are on the
 * shape rather than typed a second time somewhere.
 */
describe('the category-response templates — 2026', () => {
  const NAMES = [
    // 2026-09 resubmission: the six Meta reclassified MARKETING now carry a per-category body.
    'dnc_response_security_v2',
    'dnc_response_fire_v1',
    'dnc_response_road_accident_v1',
    'dnc_response_medical_v1',
    'dnc_response_flood_v2',
    'dnc_response_rescue_v1',
    'dnc_response_other_v2',
    'dnc_response_alert_v2',
    'dnc_response_advisory_v2',
    'dnc_response_order_v2',
    'dnc_response_schedule_v1',
    'dnc_response_information_v1',
  ];

  // The `_v2` shapes exist because the shared body scored as MARKETING — so each must NAME its
  // message type in its own body, not lean on the one wording every template used before.
  const V2 = NAMES.filter((n) => n.endsWith('_v2'));

  it('is one per category, meeting excluded, in the workflow document’s order', () => {
    expect(RESPONSE_TEMPLATES.map((t) => t.name)).toEqual(NAMES);
    // `meeting` stays on district_notice_v2 — the district asked for it to be left alone.
    expect(RESPONSE_TEMPLATES.some((t) => t.name.includes('meeting'))).toBe(false);
  });

  it('every one is a UTILITY template an officer answers with a tap and no link', () => {
    for (const t of RESPONSE_TEMPLATES) {
      expect(t.category).toBe('UTILITY');
      expect(t.language).toBe('en');
      // No link at all — a URL button opens no service window, and the answer is the interaction.
      expect(t.urlButton).toBeNull();
      expect(t.header).toBeNull();
      expect(t.quickReplies).toHaveLength(3);
      for (const label of t.quickReplies) {
        // Meta's hard limit is 25; the project standard is 20.
        expect(label.length).toBeLessThanOrEqual(20);
      }
      // Meta refuses a template with a repeated quick reply.
      expect(new Set(t.quickReplies).size).toBe(3);
    }
  });

  it('carries a body Meta will accept — static text at both ends, {{1}} and {{2}} between', () => {
    for (const t of RESPONSE_TEMPLATES) {
      const body = t.bodyText ?? '';
      expect(body).toContain('{{1}}');
      expect(body).toContain('{{2}}');
      // error_subcode 2388299 — a body may not start or end with a parameter.
      expect(body.trimStart().startsWith('{{')).toBe(false);
      expect(body.trimEnd().endsWith('}}')).toBe(false);
      // The marker count is what a mismatch against `body` is detected on.
      const markers = new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []);
      expect(markers.size).toBe(t.body.length);
      // Comfortably inside Meta's 1024-character body cap.
      expect(body.length).toBeLessThanOrEqual(1024);
    }
  });

  it('every _v2 shape names its own message type — the shared body is what Meta read as MARKETING', () => {
    const v1Bodies = new Set(
      RESPONSE_TEMPLATES.filter((t) => t.name.endsWith('_v1')).map((t) => t.bodyText),
    );
    for (const name of V2) {
      const t = RESPONSE_TEMPLATES.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      const body = t?.bodyText ?? '';
      // A named type line, not the shared "District Nerve Center" opener.
      expect(body.startsWith('Deputy Commissioner Bajaur — ')).toBe(true);
      expect(body).not.toContain('District Nerve Center');
      // Its own wording, distinct from every category that stayed UTILITY on the shared body.
      expect(v1Bodies.has(body)).toBe(false);
    }
  });

  it('is findable by the name Meta knows it as', () => {
    for (const t of RESPONSE_TEMPLATES) expect(shapeNamed(t.name)).toBe(t);
  });
});

/**
 * **The wiring that routes a category alert onto its own template — ADR-0034.**
 *
 * `domain/responseOptions.ts` owns *what a tap comes back as*; `ops/whatsappTemplate.ts` owns
 * *the shape submitted to Meta*. The two carry the same button labels twice — `domain/` may not
 * import `ops/` — so this is where they are held together. Drift here is a tap this software
 * cannot read, silently, on a real night.
 */
describe('the category-response templates are wired to the send path — ADR-0034', () => {
  it('maps every category slug to its dnc_response_* shape, and no others', () => {
    expect([...RESPONSE_TEMPLATE_BY_CATEGORY.keys()].sort()).toEqual(
      [...TEMPLATE_CATEGORIES].sort(),
    );
    for (const [slug, shape] of RESPONSE_TEMPLATE_BY_CATEGORY) {
      expect(shape.name.startsWith('dnc_response_')).toBe(true);
      // The slug is the name with the prefix and the version stripped.
      expect(shape.name.replace(/^dnc_response_/, '').replace(/_v\d+$/, '')).toBe(slug);
      expect(responseTemplateFor(slug)).toBe(shape);
    }
    expect(responseTemplateFor('not_a_category')).toBeUndefined();
  });

  it('offers exactly the three quick replies of each approved template, in order', () => {
    for (const slug of TEMPLATE_CATEGORIES) {
      const shape = RESPONSE_TEMPLATE_BY_CATEGORY.get(slug);
      const options = TEMPLATE_OPTIONS.get(slug);
      expect(shape, slug).toBeDefined();
      expect(options, slug).toBeDefined();
      // The label is what a tap comes back as — it must equal the approved button exactly.
      expect(options?.map((o) => o.wording)).toEqual(shape?.quickReplies);
      // wording IS headline for these — a template quick reply, not a list row with a 24-char cap.
      expect(options?.every((o) => o.headline === o.wording)).toBe(true);
      // Terminal: three taps, then the district's closing sentence. No follow-up branch.
      expect(options?.every((o) => o.asks === 'nothing')).toBe(true);
      // A tap moves the emergency — every option responds, and the "already done" ones resolve.
      expect(options?.every((o) => o.records === 'responded' || o.records === 'resolved')).toBe(
        true,
      );
    }
  });

  it('gives every message kind and emergency category a template category, meeting excepted', () => {
    const categories = [null, 'fire', 'medical', 'rta', 'rescue', 'flood', 'security', 'other'];
    for (const kind of MESSAGE_KINDS) {
      for (const category of categories) {
        const slug = templateCategoryFor(kind, category);
        if (kind === 'meeting') {
          expect(slug).toBeNull();
        } else {
          expect(RESPONSE_TEMPLATE_BY_CATEGORY.has(slug ?? '')).toBe(true);
        }
      }
    }
  });
});

describe('namesKindInHeader — 2026-09-05', () => {
  /**
   * Only the six `responseTemplateV2` shapes open with a kind- or category-specific line
   * (`Deputy Commissioner Bajaur — Flood Alert`, `— District Alert`, …). The other six keep the
   * generic `responseTemplate` opener (`Deputy Commissioner Bajaur - District Nerve Center`),
   * which names nothing for `{{1}}` to repeat — `jobs/whatsappChannel.ts`'s `messageFor` reads
   * this flag to decide whether to drop the kind and category out of `{{1}}`.
   */
  it('is true on exactly the categories whose header names a kind or category', () => {
    const named = ['security', 'flood', 'other', 'alert', 'advisory', 'order'];
    const generic = ['fire', 'road_accident', 'medical', 'rescue', 'schedule', 'information'];
    for (const category of named) {
      expect(categoryNamesKindInHeader(category), category).toBe(true);
    }
    for (const category of generic) {
      expect(categoryNamesKindInHeader(category), category).toBe(false);
    }
  });

  it('is false for a category with no response template at all', () => {
    expect(categoryNamesKindInHeader('not_a_category')).toBe(false);
  });
});

describe('categoryLabelsLocation — 2026-09-08', () => {
  /**
   * **All twelve, not the six with a kind in the header.** `RESPONSE_OPENER` (the `_v1` six) and
   * `responseTemplateV2` (the `_v2` six) were written months apart and agree on exactly one
   * thing: both put the literal `Location: ` in front of `{{2}}`. That is why
   * `jobs/whatsappChannel.ts` resolves this separately from `namesKindInHeader` — folding the two
   * into one flag would leave the `_v1` six still sending a description under a `Location:`
   * heading, which is the whole of the 2026-09-08 defect.
   */
  it('is true on every response template, both generations', () => {
    for (const t of RESPONSE_TEMPLATES) {
      const category = t.name.replace(/^dnc_response_/, '').replace(/_v\d+$/, '');
      expect(categoryLabelsLocation(category), t.name).toBe(true);
    }
    // Named explicitly as well, so a template quietly dropped from the catalogue is still caught.
    for (const category of ['fire', 'medical', 'flood', 'security', 'schedule', 'information']) {
      expect(categoryLabelsLocation(category), category).toBe(true);
    }
  });

  /**
   * That message goes out on `WHATSAPP_TEMPLATE`, whose body has carried no such label since the
   * district's first send — its second parameter must keep reading as free prose.
   */
  it('is false for a category with no response template at all', () => {
    expect(categoryLabelsLocation('not_a_category')).toBe(false);
  });

  /**
   * The guard that makes reading the label off `bodyText` worth more than a hand-set flag: a
   * thirteenth shape whose wording drops the label stops being treated as labelled, instead of
   * silently putting a place where no label announces one.
   */
  it('reads the approved wording rather than a declared flag', () => {
    for (const t of RESPONSE_TEMPLATES) {
      expect(t.bodyText, t.name).toContain('Location: {{2}}');
    }
  });
});
