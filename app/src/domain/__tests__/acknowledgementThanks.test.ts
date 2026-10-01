/**
 * **The district's three sentences, and which message earns which** — 2026-08-23.
 *
 * Pure, no database. Two things are protected here and they are not the same thing:
 *
 *   * **the mapping** — that a meeting is never handed the control room's number instead of
 *     *"kindly make it convenient to attend"*, and that nothing urgent is ever filed under
 *     *Information*
 *   * **the words** — asserted character for character, because they are the district's and not
 *     ours. A test that checked only "contains 0000-000000" would let somebody tidy the spacing
 *     the Deputy Commissioner's office typed, which is the one change nobody here may make.
 */

import { describe, expect, it } from 'vitest';

import { MESSAGE_KINDS, type MessageKind } from '../events.js';
import { THANKS, acknowledgementThanks, thanksKindFor } from '../acknowledgementThanks.js';

/** The six the reporting screen offers — `api/dashboard.ts`'s own `WATCHED`. */
const CATEGORIES: readonly (string | null)[] = [
  'fire',
  'flood',
  'rta',
  'medical',
  'security',
  'other',
  null,
];

describe('the district’s words', () => {
  it('are verbatim, spacing and all', () => {
    expect(THANKS.urgent).toBe(
      'Thank you for the Acknowledgement.\n\n' +
        "In case of any emergency, feel free to contact Deputy Commissioner Bajaur's Control " +
        'Room/District Nerve Center on 0000-000000.',
    );
    expect(THANKS.meeting).toBe(
      'Thank you for the Acknowledgement. Kindly make it convenient to attend the subject meeting.',
    );
    expect(THANKS.information).toBe(
      'Thank you for the Acknowledgement. For further information, feel free to contact Deputy ' +
        'Commissioner Control Room/ District Nerve Center Bajaur on 0000-000000.',
    );
  });

  it('all begin with the acknowledgement the district is answering', () => {
    for (const text of Object.values(THANKS)) {
      expect(text.startsWith('Thank you for the Acknowledgement.')).toBe(true);
    }
  });

  it('carry the control room’s number wherever the district put one', () => {
    expect(THANKS.urgent).toContain('0000-000000');
    expect(THANKS.information).toContain('0000-000000');
    // Not an oversight — a meeting notice asks somebody to attend, not to ring anybody.
    expect(THANKS.meeting).not.toContain('0000-000000');
  });

  it('fit a session message with the lifecycle sentence still to come', () => {
    // `sendSession`'s cap when buttons ride along. The margin is what lets the tail be appended
    // without this file having to know the tail exists.
    for (const text of Object.values(THANKS)) {
      expect(text.length).toBeLessThan(900);
    }
  });
});

describe('thanksKindFor', () => {
  it('answers for every kind and every category', () => {
    for (const kind of MESSAGE_KINDS) {
      for (const category of CATEGORIES) {
        expect(['urgent', 'meeting', 'information']).toContain(thanksKindFor(kind, category));
      }
    }
  });

  it('sends a meeting to attend it, whatever the meeting is about', () => {
    // 🔴 The one case where this deliberately disagrees with `laneOf`: a meeting about the flood
    // wears FLOOD on the panel, and its officers are still asked to attend.
    for (const category of CATEGORIES) {
      expect(thanksKindFor('meeting', category)).toBe('meeting');
    }
  });

  it('sends security and flood to the control room, whatever kind carries them', () => {
    for (const kind of MESSAGE_KINDS) {
      if (kind === 'meeting') continue;
      expect(thanksKindFor(kind, 'security')).toBe('urgent');
      expect(thanksKindFor(kind, 'flood')).toBe('urgent');
    }
  });

  it('sends the district’s Alert & Advisory kinds to the control room', () => {
    for (const kind of ['alert', 'advisory'] as const) {
      expect(thanksKindFor(kind, null)).toBe('urgent');
    }
  });

  it('sends an emergency and an order there too, though the district listed neither', () => {
    // Recorded for the owner. An emergency is the message where "ring the control room" is most
    // obviously right, and filing it under Information because nobody named it would be worse
    // than the assumption.
    expect(thanksKindFor('emergency', null)).toBe('urgent');
    expect(thanksKindFor('emergency', 'fire')).toBe('urgent');
    expect(thanksKindFor('order', null)).toBe('urgent');
  });

  it('sends a notice — the district’s Information — to the information text', () => {
    expect(thanksKindFor('other', null)).toBe('information');
    expect(thanksKindFor('other', 'rta')).toBe('information');
  });

  it('sends a schedule to the information text rather than the meeting one', () => {
    // A duty roster is not a meeting anybody is asked to make it convenient to attend.
    // `carrying.ts` records the same uncertainty about `schedule`; the owner answers both.
    expect(thanksKindFor('schedule', null)).toBe('information');
  });

  it('falls to information for a kind nobody has added yet', () => {
    // Total by construction, and the fallback is the sentence that is merely unhelpful rather
    // than the one that is wrong.
    expect(thanksKindFor('a-kind-from-2027' as MessageKind, null)).toBe('information');
  });
});

describe('acknowledgementThanks', () => {
  it('is the text its kind maps to, and nothing is composed at the call site', () => {
    for (const kind of MESSAGE_KINDS) {
      for (const category of CATEGORIES) {
        expect(acknowledgementThanks(kind, category)).toBe(THANKS[thanksKindFor(kind, category)]);
      }
    }
  });
});
