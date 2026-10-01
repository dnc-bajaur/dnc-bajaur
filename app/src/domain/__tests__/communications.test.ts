/**
 * General communications — M9-13.
 *
 * Two things these tests are actually protecting, and neither is obvious from the assertions:
 *
 * 1. **Emergency messages must not change.** Every officer in Bajaur has learned to read the
 *    existing subject line at a glance on a lock screen, and M9 has no business altering it.
 *    Several tests below exist only to pin that down.
 * 2. **Neither template parameter may ever be empty.** Meta refuses an empty body parameter
 *    outright, which the district reads as "the message failed" rather than as "a box on a form
 *    was blank" — so an empty result here is a send that fails at 02:00.
 */

import { describe, expect, it } from 'vitest';

import {
  detailLines,
  fieldsFor,
  hasCategory,
  labelFor,
  locationLine,
  messageSubject,
  messageWhere,
  requiredFieldsFor,
} from '../communications.js';
import { CARRIES_SLA, isGeneral, MESSAGE_KINDS, type MessageKind } from '../events.js';

describe('the kinds', () => {
  it("keeps the four M7-23 kinds and adds the client's three", () => {
    expect(MESSAGE_KINDS).toEqual([
      'emergency',
      'alert',
      'advisory',
      'order',
      'meeting',
      'schedule',
      'other',
    ]);
  });

  it('carries an SLA for the operational kinds and not for General', () => {
    // The decision, asserted rather than described. `order` is deliberately inside the fence:
    // an instruction from the DC office that goes unanswered should escalate.
    expect([...CARRIES_SLA].sort()).toEqual(['advisory', 'alert', 'emergency', 'order']);

    expect(isGeneral('emergency')).toBe(false);
    expect(isGeneral('order')).toBe(false);
    expect(isGeneral('meeting')).toBe(true);
    expect(isGeneral('schedule')).toBe(true);
    expect(isGeneral('other')).toBe(true);
  });

  it('gives every kind a label, so no screen can render a raw enum', () => {
    for (const kind of MESSAGE_KINDS) {
      expect(labelFor(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("hasCategory — the merged report grid's placeholder, 2026-09-05", () => {
  /**
   * `web/src/main.ts`'s `TILES` (2026-08-24) writes the literal category `'other'` on Alert,
   * Advisory, Order, Meeting, Schedule and Information, because none of those tiles ever asks the
   * operator to classify anything — only the seven emergency tiles have a real category. A
   * district read "ALERT · other · high" on the message and the board's Record row for a message
   * it had itself tagged Alert, and asked why. `jobs/whatsappChannel.ts` and
   * `web/src/incidentRow.ts` both gate the category segment on this one function so the message,
   * the row and the drawer heading can never disagree about the same `'other'`.
   */
  it('says no for the placeholder on every kind but emergency', () => {
    for (const kind of ['alert', 'advisory', 'order', 'meeting', 'schedule', 'other'] as const) {
      expect(hasCategory(kind, 'other')).toBe(false);
    }
  });

  it('says yes for emergency even with the placeholder — the officer chose the Other tile', () => {
    expect(hasCategory('emergency', 'other')).toBe(true);
  });

  it('says yes for a real category, on every kind', () => {
    // The grid never produces this for a non-emergency kind today, but the domain layer does not
    // forbid it (`POST /incidents` takes any category with any kind), and a real category is
    // exactly the case this function must never hide.
    for (const kind of MESSAGE_KINDS) {
      expect(hasCategory(kind, 'flood')).toBe(true);
    }
  });
});

describe('which boxes a screen draws', () => {
  it('asks a meeting for exactly what the client named, plus a "kab tak"', () => {
    // The four the client named, in their order, and the district's five added `reviewBy`
    // (2026-08-22): a meeting that outlives the day needs a day on which somebody is asked
    // whether it is still going to happen.
    expect(fieldsFor('meeting')).toEqual(['subject', 'date', 'time', 'venue', 'reviewBy', 'note']);
  });

  it('asks a schedule for a span rather than a venue', () => {
    expect(fieldsFor('schedule')).toContain('untilDate');
    expect(fieldsFor('schedule')).not.toContain('venue');
  });

  it('demands nothing of any emergency kind, which is the half that must not move', () => {
    /**
     * ⚠️ **The property, and it is `requiredFieldsFor` rather than `fieldsFor`.** These four
     * are sent from the report screen and none of them may ever be refused for a missing box
     * (INV-01). `alert` and `advisory` gained a review date on 2026-08-22 — they carry past the
     * district's midnight, so each needs an answer to *"kab tak?"* — and the derivation that
     * used to answer this question (*does this kind ask for anything at all?*) would have started
     * demanding a subject on every one of them the moment that box appeared.
     */
    for (const kind of ['emergency', 'alert', 'advisory', 'order'] as MessageKind[]) {
      expect(requiredFieldsFor(kind), `${kind} must refuse nothing`).toEqual([]);
    }

    // A review date and nothing else. The rest of their screen is still the report screen.
    expect(fieldsFor('alert')).toEqual(['reviewBy']);
    expect(fieldsFor('advisory')).toEqual(['reviewBy']);
    expect(fieldsFor('emergency')).toEqual([]);
    expect(fieldsFor('order')).toEqual([]);
  });

  it('requires only a subject, so an undecided venue cannot refuse a real meeting', () => {
    expect(requiredFieldsFor('meeting')).toEqual(['subject']);
    expect(requiredFieldsFor('other')).toEqual(['subject']);
  });
});

describe('the message an officer receives', () => {
  const meeting = {
    subject: 'Monthly coordination',
    date: '2026-08-20',
    time: '10:30',
    venue: 'DC Office committee room',
  };

  it('leads with the kind and the subject', () => {
    expect(messageSubject('meeting', 'unused', meeting)).toBe('Meeting: Monthly coordination');
  });

  it('folds when and where into the second parameter', () => {
    expect(messageWhere('', meeting)).toBe('2026-08-20 at 10:30 · DC Office committee room');
  });

  it('renders a schedule as a span', () => {
    expect(messageWhere('', { date: '2026-08-14', untilDate: '2026-08-20' })).toBe(
      '2026-08-14 to 2026-08-20',
    );
  });

  it('does not say "to" when the span is one day', () => {
    expect(messageWhere('', { date: '2026-08-14', untilDate: '2026-08-14' })).toBe('2026-08-14');
  });

  it('NEVER returns an empty string — Meta refuses an empty parameter', () => {
    // Every shape that could plausibly arrive empty.
    expect(messageWhere('', undefined)).not.toBe('');
    expect(messageWhere('', {})).not.toBe('');
    expect(messageWhere('   ', { subject: 'only a subject' })).not.toBe('');
    expect(messageWhere('', { date: '   ', time: '', venue: '  ' })).not.toBe('');
  });

  it('falls back to what was asked for before inventing a placeholder', () => {
    expect(messageWhere('River road, near the bridge', {})).toBe('River road, near the bridge');
  });

  it('falls back to the given subject line when there is no structured subject', () => {
    expect(messageSubject('other', 'Notice · general', undefined)).toBe('Notice · general');
    expect(messageSubject('other', 'Notice · general', { note: 'no subject given' })).toBe(
      'Notice · general',
    );
  });

  it('bounds the second parameter and strips newlines', () => {
    // A newline in a body parameter is rejected by Meta outright, and a very long one is
    // unreadable on a handset. Both are silent failures from the district's point of view.
    const built = messageWhere('', { note: `line one\nline two\n\n${'x'.repeat(400)}` });
    expect(built).not.toContain('\n');
    expect(built.length).toBeLessThanOrEqual(300);
  });

  it('treats whitespace-only fields as absent, not as blank values', () => {
    expect(messageSubject('meeting', 'fallback', { subject: '   ' })).toBe('fallback');
  });

  it("joins a location onto a General kind's venue and note — 2026-09-05", () => {
    expect(messageWhere('', meeting, undefined, 'Near the canal bridge')).toBe(
      '2026-08-20 at 10:30 · DC Office committee room · Near the canal bridge',
    );
  });
});

describe('locationLine — restored 2026-09-05, this time actually read back', () => {
  /**
   * `1d36b058` removed the box that fed `location.text` because nothing anywhere ever read it
   * back — not the WhatsApp message, not the board, not the printed report. This is that read:
   * `jobs/whatsappChannel.ts`'s `messageFor` calls this on `state.location` for both branches.
   *
   * A device GPS fix rode alongside the typed text here too, for one day, as a tappable map link
   * — and came out the same day (also 2026-09-05): the pin it drew was wrong often enough that
   * the owner asked for it gone rather than fixed. `ReportedLocation` no longer has a `gps` field
   * at all, so there is no link case left to test — typed text is the whole of what this reads.
   */
  it('is null with nothing captured', () => {
    expect(locationLine(null)).toBeNull();
    expect(locationLine(undefined)).toBeNull();
    expect(locationLine({})).toBeNull();
  });

  it('is the typed landmark alone, when that is all there is', () => {
    expect(locationLine({ text: 'Khar road, near the bypass' })).toBe('Khar road, near the bypass');
  });

  it('treats a whitespace-only landmark as nothing typed', () => {
    expect(locationLine({ text: '   ' })).toBeNull();
  });
});

describe('detailLines', () => {
  it('reads in the order the form asks, not the order the object was built', () => {
    const lines = detailLines('meeting', {
      note: 'bring the flood figures',
      subject: 'Monthly coordination',
      venue: 'DC Office',
      date: '2026-08-20',
    });
    expect(lines.map((l) => l.label)).toEqual(['Subject', 'Date', 'Venue', 'Details']);
  });

  it('drops empty fields rather than rendering them blank', () => {
    expect(detailLines('meeting', { subject: 'x', venue: '  ' }).map((l) => l.label)).toEqual([
      'Subject',
    ]);
  });

  it('is empty for an emergency and for a kind with no details', () => {
    expect(detailLines('emergency', { subject: 'ignored' })).toEqual([]);
    expect(detailLines('meeting', undefined)).toEqual([]);
  });
});

describe('messageWhere on a template that writes "Location:" itself — 2026-09-08', () => {
  /** The same fixture the block above uses; that one is scoped to its own describe. */
  const meeting = {
    subject: 'Monthly coordination',
    date: '2026-08-20',
    time: '10:30',
    venue: 'DC Office committee room',
  };

  /**
   * Every `dnc_response_*` shape prints `Location: ` immediately before `{{2}}`, and the send had
   * been putting the operator's description into that slot — so a flood alert reached the district
   * reading `Location: Flood expected at jaar`, asserting a place it had never been given. The
   * template is Meta's and is not to be touched, so the parameter leads with the place instead.
   */
  it('leads with the place and lets the rest follow an em dash', () => {
    expect(messageWhere('', meeting, undefined, 'DC Office, Bajaur', true)).toBe(
      'DC Office, Bajaur — 2026-08-20 at 10:30 · DC Office committee room',
    );
  });

  it('says the place was not stated rather than promoting the description into one', () => {
    expect(messageWhere('Flood expected at jaar', undefined, undefined, null, true)).toBe(
      'not stated — Flood expected at jaar',
    );
  });

  it('never returns empty, so Meta never refuses the send', () => {
    // An empty body parameter is a `whatsapp_400`, which the district reads as "the alert did not
    // go" rather than as "a box was blank".
    expect(messageWhere('', undefined, undefined, null, true)).toBe('not stated');
  });

  it('still reserves the attachment link and cuts the words around it', () => {
    // M9-18's rule is unchanged by the reordering: the link survives, the tail of the sentence
    // does not. What moves is only which words sit at the front of the line.
    const built = messageWhere(
      'x'.repeat(400),
      undefined,
      'https://dnc.example.pk/f/tok',
      'Jaar, Bajaur',
      true,
    );
    expect(built.startsWith('Jaar, Bajaur — ')).toBe(true);
    expect(built.endsWith('Attached file: https://dnc.example.pk/f/tok')).toBe(true);
    expect(built.length).toBeLessThanOrEqual(300);
  });

  it('leaves every unlabelled template exactly as it was', () => {
    // The argument omitted: the place trails the venue and note, which is what `WHATSAPP_TEMPLATE`
    // has sent since 2026-09-05.
    expect(messageWhere('', meeting, undefined, 'Near the canal bridge')).toBe(
      '2026-08-20 at 10:30 · DC Office committee room · Near the canal bridge',
    );
  });
});
