/**
 * What an officer actually reads on a locked handset — M9-09, M9-12.
 *
 * **This string had no test.** Every existing assertion about it went through an integration
 * path needing a live Postgres, so in practice nothing checked it — and that is how the message
 * *"no details were entered"* reached the district about an emergency whose details had been
 * entered. The owner found that one by receiving it.
 *
 * Two rules these tests hold:
 *
 * 1. **Emergency messages do not change.** M9 extended the kinds; it must not have touched the
 *    sentence every officer in Bajaur has learned to read at a glance.
 * 2. **Neither parameter is ever empty.** Meta refuses an empty body parameter outright, and the
 *    district reads that failure as "the alert did not go" rather than "a box was blank".
 */

import { describe, expect, it } from 'vitest';

import { CARRIES_SLA, MESSAGE_KINDS } from '../../domain/events.js';
import { answersFor, messageFor } from '../whatsappChannel.js';
import type { IncidentState } from '../../domain/incident.js';
import type { MessageKind, Severity } from '../../domain/events.js';

/** A fold with only the fields `messageFor` reads. Everything else is irrelevant to it. */
function state(over: {
  kind?: MessageKind;
  severity?: Severity;
  category?: string;
  actions?: string[];
  location?: { text?: string };
}): IncidentState {
  const actor = { personId: null, seatId: null };
  return {
    kind: over.kind ?? 'emergency',
    severity:
      over.severity === undefined
        ? null
        : { value: over.severity, setBy: actor, setAt: '2026-08-13T00:00:00.000Z' },
    category:
      over.category === undefined
        ? null
        : { value: over.category, setBy: actor, setAt: '2026-08-13T00:00:00.000Z' },
    actions: (over.actions ?? []).map((note) => ({
      at: '2026-08-13T00:00:00.000Z',
      by: actor,
      note,
    })),
    location: over.location ?? null,
  } as unknown as IncidentState;
}

describe('an emergency, unchanged by M9', () => {
  it('reads category and severity, with no kind prefix', () => {
    const built = messageFor(state({ severity: 'critical', category: 'fire' }), {
      description: 'River road, near the bridge',
    });
    expect(built.what).toBe('fire · critical');
    expect(built.where).toBe('River road, near the bridge');
  });

  it('says the severity is not assessed rather than inventing one', () => {
    expect(messageFor(state({ severity: 'unknown', category: 'fire' }), {}).what).toBe(
      'fire · not yet assessed',
    );
  });

  it('says the place is not stated when nothing at all was entered', () => {
    expect(messageFor(state({ category: 'fire' }), undefined).where).toBe('place not stated');
  });

  it('still prefixes an alert, advisory and order', () => {
    for (const kind of ['alert', 'advisory', 'order'] as MessageKind[]) {
      expect(messageFor(state({ kind, category: 'road' }), {}).what).toContain(kind.toUpperCase());
    }
  });
});

describe("the merged report grid's placeholder category — 2026-09-05", () => {
  /**
   * A district read "ALERT · other · high" on a message it had itself tagged Alert, on the
   * board's Record row and on the handset both, and asked why the category it never touched was
   * wrong. It was not wrong: `web/src/main.ts`'s `TILES` (2026-08-24) writes the literal category
   * `'other'` on Alert, Advisory and Order, because none of those tiles ever asks the operator to
   * classify anything — only the seven emergency tiles have a real category. `'other'` is the
   * fold's honest value; it is just not information, and printing it read as "this could not be
   * classified" beside a word, `ALERT`, that had already classified it.
   *
   * Verified failing: before `hasCategory` gated this segment, every one of these produced
   * `"ALERT · other · high"` / `"ADVISORY · other · high"` / `"ORDER · other · high"`.
   */
  it('drops the category segment for alert, advisory and order when it is only the placeholder', () => {
    for (const kind of ['alert', 'advisory', 'order'] as MessageKind[]) {
      const what = messageFor(state({ kind, severity: 'high', category: 'other' }), {}).what;
      expect(what).toBe(`${kind.toUpperCase()} · high`);
      expect(what).not.toContain('other');
    }
  });

  it('keeps the category segment for the same three kinds when it is a real one', () => {
    // The grid cannot produce this today, but `POST /incidents` can (see `carrying.test.ts`),
    // and a real category is exactly the case `hasCategory` must not hide.
    for (const kind of ['alert', 'advisory', 'order'] as MessageKind[]) {
      expect(messageFor(state({ kind, severity: 'high', category: 'flood' }), {}).what).toBe(
        `${kind.toUpperCase()} · flood · high`,
      );
    }
  });

  it('keeps "other" on an emergency — it is the officer\'s own choice of the Other tile', () => {
    // The one case where `'other'` really was a decision: the seventh emergency tile, chosen
    // over Fire, Flood, RTA, Medical, Security and Rescue. Losing it here would make the Other
    // emergency tile indistinguishable from one with no category read at all.
    expect(messageFor(state({ severity: 'high', category: 'other' }), {}).what).toBe(
      'other · high',
    );
  });

  it("drops the same placeholder from a General kind's fallback subject", () => {
    for (const kind of ['meeting', 'schedule', 'other'] as MessageKind[]) {
      const what = messageFor(state({ kind, category: 'other' }), {}).what;
      expect(what).toBe(kind === 'other' ? 'Notice' : kind === 'meeting' ? 'Meeting' : 'Schedule');
    }
  });
});

describe('a message on its own response template — 2026-09-05', () => {
  /**
   * `dnc_response_flood_v2`'s own approved text opens `Deputy Commissioner Bajaur — Flood Alert`
   * before `{{1}}` ever renders, and `dnc_response_alert_v2` opens `District Alert`. A control
   * room read the header and then `{{1}}` repeating it — `District Alert` above `ALERT · high` —
   * and asked why a message said *Alert* twice. `whatsappChannel.ts`'s `deliver` resolves this
   * flag from `categoryNamesKindInHeader` and passes it here; `messageFor` itself takes no config
   * and stays a pure read of the fold plus this one bit.
   *
   * Verified failing: before this parameter existed, every one of these produced the doubled
   * form regardless of the fourth argument, because there was no fourth argument.
   */
  it('drops both the kind prefix and the category segment, leaving only severity', () => {
    expect(
      messageFor(state({ kind: 'alert', severity: 'high', category: 'other' }), {}, undefined, true)
        .what,
    ).toBe('high');
    expect(
      messageFor(state({ severity: 'critical', category: 'flood' }), {}, undefined, true).what,
    ).toBe('critical');
  });

  it('still says "not yet assessed" rather than inventing a severity', () => {
    expect(
      messageFor(
        state({ kind: 'order', severity: 'unknown', category: 'other' }),
        {},
        undefined,
        true,
      ).what,
    ).toBe('not yet assessed');
  });

  it('leaves the plain template exactly as before, with the fourth argument omitted', () => {
    // The overwhelming majority of sends: no `.env` line has switched this category's response
    // template on, so `{{1}}` remains the only place that says what kind of thing this is.
    expect(messageFor(state({ kind: 'alert', severity: 'high', category: 'other' }), {}).what).toBe(
      'ALERT · high',
    );
  });

  it('leaves a General kind untouched — none of its response templates name a kind in the header', () => {
    // `information` and `schedule` are the only General-kind response templates, and both use
    // the generic `District Nerve Center` opener (`responseTemplate`, not `responseTemplateV2`).
    // Passing `true` here is not a case `whatsappChannel.ts` ever produces, but `messageFor`
    // itself does not need to know that to stay correct.
    const what = messageFor(state({ kind: 'other', category: 'other' }), {}, undefined, true).what;
    expect(what).toBe('Notice');
  });
});

describe('the two-details-boxes defect — M9-12', () => {
  /**
   * The exact sequence the owner hit: submit fast with the `#what` box empty, then type into
   * `#place`/`#detail` afterwards, which becomes an `action_logged` note — and *then* dispatch.
   * Before this fix the message went out saying no details were entered, which was a false
   * statement about a live emergency, sent to officers.
   */
  it('uses a note added after submit when nothing was typed before it', () => {
    const built = messageFor(
      state({ category: 'fire', actions: ['Bypass road, near the depot'] }),
      {
        description: '',
      },
    );
    expect(built.where).toBe('Bypass road, near the depot');
    expect(built.where).not.toBe('place not stated');
  });

  it('prefers what was written about the emergency itself when both exist', () => {
    // `description` is what somebody wrote first, about the emergency. An action note is a
    // later addition, and one parameter cannot carry both.
    const built = messageFor(state({ category: 'fire', actions: ['crew on scene'] }), {
      description: 'River road',
    });
    expect(built.where).toBe('River road');
  });

  it('takes the most recent note, not the first', () => {
    const built = messageFor(
      state({ category: 'fire', actions: ['first look', 'water rising at the bridge'] }),
      {},
    );
    expect(built.where).toBe('water rising at the bridge');
  });

  it('ignores blank notes rather than sending an empty parameter', () => {
    const built = messageFor(state({ category: 'fire', actions: ['   ', ''] }), {});
    expect(built.where).toBe('place not stated');
  });
});

describe('location rides the message alongside severity — 2026-09-05', () => {
  /**
   * `1d36b058` deleted the box that fed `location.text` because nothing ever read it back. This
   * is the other half of the real fix (`domain/communications.ts`'s `locationLine`): the same
   * field, now actually reaching the message.
   *
   * Verified failing: before `messageFor` read `state.location`, none of these mentioned the
   * landmark at all — `where` was `said` and nothing else.
   *
   * A device GPS fix rode alongside the typed text here for one day and was removed the same day
   * (also 2026-09-05, see `location.ts`'s doc comment): the map link it built was wrong often
   * enough that a wrong pin outweighed the convenience. `locationLine` only ever reads
   * `location.text` now, so there is nothing left here to test for a fix — a location with no
   * `text` behaves exactly like no location at all.
   */
  it('appends a typed landmark after what happened', () => {
    const built = messageFor(
      state({ category: 'fire', location: { text: 'Near the old bridge' } }),
      { description: 'Two vehicles alight' },
    );
    expect(built.where).toBe('Two vehicles alight · Near the old bridge');
  });

  it('is the whole message when nothing else was said, rather than falling to the placeholder', () => {
    const built = messageFor(state({ category: 'fire', location: { text: 'Khar road' } }), {});
    expect(built.where).toBe('Khar road');
    expect(built.where).not.toBe('place not stated');
  });

  it('falls back to the ordinary placeholder when there is truly nothing typed', () => {
    const built = messageFor(state({ category: 'fire' }), {});
    expect(built.where).toBe('place not stated');
  });
});

describe('a General communication', () => {
  const meeting = {
    subject: 'Monthly coordination',
    date: '2026-08-20',
    time: '10:30',
    venue: 'DC Office committee room',
  };

  it('leads with the kind and the subject, not the category and severity', () => {
    const built = messageFor(state({ kind: 'meeting', category: 'general' }), {
      details: meeting,
    });
    expect(built.what).toBe('Meeting: Monthly coordination');
    expect(built.where).toBe('2026-08-20 at 10:30 · DC Office committee room');
  });

  it('never sends an empty parameter, whatever is missing', () => {
    for (const kind of ['meeting', 'schedule', 'other'] as MessageKind[]) {
      const built = messageFor(state({ kind, category: 'general' }), undefined);
      expect(built.what.length).toBeGreaterThan(0);
      expect(built.where.length).toBeGreaterThan(0);
    }
  });

  it('bounds both parameters', () => {
    const built = messageFor(state({ kind: 'other', category: 'general' }), {
      details: { subject: 'x'.repeat(500), note: 'y'.repeat(500) },
    });
    expect(built.where.length).toBeLessThanOrEqual(300);
    expect(built.where).not.toContain('\n');
  });
});

describe('the attachment link — M9-18', () => {
  const LINK = 'https://dnc.example.com/file/' + 'a'.repeat(43);

  it('rides on an emergency too, not only on a notice', () => {
    // A photograph of the scene is worth more to the officer driving to it than the last
    // twenty characters of a description they are about to see for themselves.
    const built = messageFor(state({ category: 'fire' }), { description: 'River road' }, LINK);
    expect(built.where).toContain(LINK);
    expect(built.where).toContain('River road');
  });

  it('rides on a meeting alongside the date and venue', () => {
    const built = messageFor(
      state({ kind: 'meeting', category: 'general' }),
      { details: { subject: 'x', date: '2026-08-20', venue: 'DC Office' } },
      LINK,
    );
    expect(built.where).toContain('2026-08-20');
    expect(built.where).toContain(LINK);
  });

  it('CUTS THE WORDS, NEVER THE LINK — the decision', () => {
    // A truncated line plus a working link loses nothing an officer cannot recover by tapping
    // it. A full venue plus a link cut in half reads complete and is not, which is worse:
    // nothing tells them anything is missing.
    const built = messageFor(
      state({ kind: 'other', category: 'general' }),
      { details: { subject: 's', note: 'y'.repeat(400) } },
      LINK,
    );

    expect(built.where.endsWith(LINK)).toBe(true);
    expect(built.where.length).toBeLessThanOrEqual(300);
  });

  it('marks a cut line with an ellipsis, so it is visibly short rather than silently so', () => {
    const built = messageFor(
      state({ kind: 'other', category: 'general' }),
      { details: { note: 'y'.repeat(400) } },
      LINK,
    );
    expect(built.where).toContain('…');
  });

  it('sends the link alone rather than a broken one, if it would not fit at all', () => {
    const huge = 'https://example.invalid/file/' + 'a'.repeat(400);
    const built = messageFor(state({ category: 'fire' }), { description: 'somewhere' }, huge);
    expect(built.where).toBe(huge);
  });

  it('changes nothing when there is no attachment', () => {
    const without = messageFor(state({ category: 'fire' }), { description: 'River road' });
    expect(without.where).toBe('River road');
  });
});

/**
 * Which buttons each kind of message carries — 2026-08-19.
 *
 * The mapping is three lines of code and the argument is entirely about the third: `schedule` and
 * `other` are deliberately left on the ordinary template. *"Attending"* is not an answer to a duty
 * roster for the 14th to the 20th, and it is not an answer to a road closure — offering it teaches
 * officers that the buttons do not mean what they say, and the district goes on reading the taps
 * as if they did.
 */
describe('which buttons a message asks for — 2026-08-19', () => {
  it('asks a meeting who is coming', () => {
    expect(answersFor('meeting')).toBe('attendance');
  });

  it('🔴 stops asking the moment the meeting is over', () => {
    /**
     * The district's five, 2026-08-22, and the trap is small and lands on a real handset.
     *
     * `district_notice_v2` carries **Attending · Not attending · Sending someone**, so a
     * **cancellation** sent on it hands every officer three ways to answer a meeting that is not
     * happening — and the taps come back, and the tally counts them, and the district reads a
     * number for a meeting nobody is going to.
     *
     * ⚠️ **The message rides the plain template instead**, exactly as a schedule and a notice
     * already do. `answers` was always a per-message decision, which is why this costs one
     * parameter and NOT a new template — nothing here waits on Meta.
     */
    /**
     * ⚠️ **`acknowledgement` rather than `undefined` since 2026-08-25.** A cancelled meeting must
     * not offer three ways to answer a meeting nobody is going to — that is unchanged and is what
     * this test is for. What changed is where it lands instead: `undefined` meant the link-only
     * template, and a cancellation nobody can acknowledge from the thread is a cancellation the
     * district cannot tell was read.
     */
    expect(answersFor('meeting', { asking: false })).not.toBe('attendance');
    expect(answersFor('meeting', { asking: false })).toBe('acknowledgement');
  });

  it('goes on asking after a reschedule, because a moved meeting has not finished', () => {
    // The other half of the same rule, and the one a tidy-up would break: *Conducted* and
    // *Cancelled* end a meeting; a new date does not.
    expect(answersFor('meeting', { asking: true })).toBe('attendance');
  });

  it('asks an Information notice who is coming, but only when the operator asked', () => {
    /**
     * The district's five, 2026-08-22, and the district said yes to this.
     *
     * A Milad programme can usefully ask who is coming; a notice about a closed road cannot,
     * and offering the buttons on both is how officers learn that the buttons mean nothing.
     * Per message, never per kind.
     *
     * ⚠️ **It costs nothing, which is the whole argument for offering it.** `other` is outside
     * `CARRIES_SLA`, so there is no clock and no ladder, and General kinds are excluded from
     * `summary.unacknowledged` — an unanswered invitation is not a gap anywhere.
     */
    expect(answersFor('other', { invited: true })).toBe('attendance');
    /**
     * ⚠️ **Not `undefined` since 2026-08-25** — see the last test in this block. An
     * uninvited notice still asks to be **acknowledged**; what it does not ask is who is coming.
     */
    expect(answersFor('other')).toBe('acknowledgement');
    expect(answersFor('other', { invited: false })).toBe('acknowledgement');
  });

  it('never offers ATTENDANCE on a schedule, invited or not', () => {
    // "Attending" is not an answer to a duty roster for the 14th to the 20th. `invited` is read
    // for `other` and for nothing else, so a stray flag on a schedule changes nothing.
    expect(answersFor('schedule', { invited: true })).not.toBe('attendance');
  });

  it('asks the four SLA kinds to acknowledge, and treats them alike', () => {
    // The same four `CARRIES_SLA` already names. An order and an advisory both ask to be
    // answered and both stop a clock when they are; splitting them again here would be a second
    // answer to a question `domain/events.ts` has already settled.
    for (const kind of ['emergency', 'alert', 'advisory', 'order'] as const) {
      expect(answersFor(kind)).toBe('acknowledgement');
    }
  });

  /**
   * 🔴 **NOTHING RETURNS `undefined` ANY MORE, AND THAT IS THE WHOLE POINT** — the owner,
   * 2026-08-25: *"whatsapp sai bahar kese bhi link pr nhe jana chaye hai"*.
   *
   * This test asserted the opposite until today, and its old comment said why: `undefined` meant
   * *the plain template*, and the plain template is `district_message_v3` — **a link and nothing
   * else**. Meta opens its 24-hour window only when the officer **sends** something, and a URL
   * button sends nothing at all — so after one of those the district cannot put a single further
   * message in front of that officer. No options, no follow-up question, no closing sentence.
   *
   * ⚠️ **No template was submitted, changed or resubmitted for this.**
   * `district_emergency_v2.body` **is** `ALERT_TEMPLATE.body`: same two parameters, same words,
   * same `UTILITY` category, same language. The officer reads an identical message and gets a
   * quick reply under it instead of only a link.
   */
  it('leaves nothing on a link-only template', () => {
    for (const kind of MESSAGE_KINDS) expect(answersFor(kind)).not.toBeUndefined();

    expect(answersFor('schedule')).toBe('acknowledgement');
    expect(answersFor('other')).toBe('acknowledgement');
    /** A meeting that is over asks nobody to attend — and is still worth acknowledging. */
    expect(answersFor('meeting', { asking: false })).toBe('acknowledgement');
  });

  /**
   * ⚠️ **The clock did not move with the buttons.** `CARRIES_SLA` is no longer asked here at
   * all, and that is deliberate: it answers *does this owe an answer by a deadline*, which is a
   * question about escalation. A duty roster owes nobody an answer at 02:00 and still deserves
   * to be answerable without leaving WhatsApp.
   */
  it('does not put a schedule or a notice on a clock by giving it a button', () => {
    expect(CARRIES_SLA.has('schedule')).toBe(false);
    expect(CARRIES_SLA.has('other')).toBe(false);
    expect(answersFor('schedule')).toBe('acknowledgement');
  });
});

/**
 * **A `Location:` label with an incident description under it — 2026-09-08, the owner's own
 * handset.**
 *
 * The message that started this read, in full:
 *
 * ```
 * Deputy Commissioner Bajaur — Flood Alert
 *
 * flood · high
 * Location: Flood expected at jaar
 * ```
 *
 * Two defects in four lines, and only the second is fixed here — the repeated `flood` was
 * `42b8e29`. The one that remained: `Location: ` is Meta's own static text on all twelve
 * `dnc_response_*` shapes, and the send was putting the *description* into the parameter after
 * it. The message asserted a location it had never been given.
 *
 * **The template could not be changed to fix it** (owner, 2026-09-08, restating 2026-08-14), so
 * the parameter is reordered instead: the place leads, so the label is true about the words
 * immediately after it, and the description follows an em dash. The owner was shown all three
 * possible orderings on rendered handset mock-ups and chose this one knowing what it costs — the
 * location does **not** end up alone at the end of the message, which needs the template's text.
 *
 * Verified failing: before `locationLabelled` existed, every assertion below produced the old
 * `description · location` ordering regardless of the fifth argument, because there was none.
 */
describe('a message on a template that writes "Location:" itself — 2026-09-08', () => {
  it('leads with the place, so the label is telling the truth', () => {
    expect(
      messageFor(
        state({ severity: 'high', category: 'flood', location: { text: 'Jaar, Bajaur' } }),
        { description: 'Flood expected at jaar' },
        undefined,
        true,
        true,
      ).where,
    ).toBe('Jaar, Bajaur — Flood expected at jaar');
  });

  it('says the location was not stated rather than passing off the description as one', () => {
    // Precisely the owner's message. The description still travels; it simply stops claiming to
    // be a place, and the officer is told the control room does not have one.
    expect(
      messageFor(
        state({ severity: 'high', category: 'flood' }),
        { description: 'Flood expected at jaar' },
        undefined,
        true,
        true,
      ).where,
    ).toBe('not stated — Flood expected at jaar');
  });

  it('carries the place alone when nobody wrote a description', () => {
    expect(
      messageFor(
        state({ severity: 'high', category: 'flood', location: { text: 'Jaar, Bajaur' } }),
        {},
        undefined,
        true,
        true,
      ).where,
    ).toBe('Jaar, Bajaur');
  });

  it('never returns an empty parameter, even with neither', () => {
    // Meta refuses an empty body parameter, and the district reads that as "the alert did not go".
    const built = messageFor(
      state({ severity: 'high', category: 'flood' }),
      {},
      undefined,
      true,
      true,
    );
    expect(built.where).toBe('not stated');
    expect(built.where.length).toBeGreaterThan(0);
  });

  it('reads the operator\u2019s later action note when there was no description', () => {
    // The two-details-boxes case (M9-12) reaches the labelled templates too.
    expect(
      messageFor(
        state({
          severity: 'high',
          category: 'flood',
          location: { text: 'Jaar, Bajaur' },
          actions: ['Water rising at the canal head'],
        }),
        {},
        undefined,
        true,
        true,
      ).where,
    ).toBe('Jaar, Bajaur — Water rising at the canal head');
  });

  it('leaves every other template exactly as it was, with the argument omitted', () => {
    // The overwhelming majority of sends. `WHATSAPP_TEMPLATE`'s body has no label, so its second
    // parameter keeps reading as free prose — description first, place after.
    expect(
      messageFor(
        state({ severity: 'high', category: 'flood', location: { text: 'Jaar, Bajaur' } }),
        { description: 'Flood expected at jaar' },
      ).where,
    ).toBe('Flood expected at jaar · Jaar, Bajaur');
  });

  /**
   * `information` and `schedule` are General kinds **and** carry `dnc_response_*` templates, so
   * they reach the labelled line through `messageWhere`'s own fold rather than through `said`.
   * The date and venue an operator filled in must still travel — behind the place, not instead
   * of it.
   */
  it('puts the place ahead of a General kind\u2019s date and venue', () => {
    expect(
      messageFor(
        state({ kind: 'schedule', location: { text: 'DC Office, Bajaur' } }),
        { details: { date: '2026-09-12', time: '10:30', venue: 'Committee room' } },
        undefined,
        false,
        true,
      ).where,
    ).toBe('DC Office, Bajaur — 2026-09-12 at 10:30 · Committee room');
  });
});
