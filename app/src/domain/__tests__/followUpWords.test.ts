/**
 * **What the control room says when it chases** — 2026-08-24.
 *
 * Pure, no database. What is protected here is the thing the owner actually asked for — *"meeting
 * k lye meeting sai related, emergency k lye emergency sai related"* — plus the two properties
 * that make it safe: the mapping is **total**, and it **cannot disagree with the button** sitting
 * in the same WhatsApp bubble.
 */

import { describe, expect, it } from 'vitest';

import { MESSAGE_KINDS, isGathering, type MessageKind } from '../events.js';
import {
  followUpAsk,
  followUpKindFor,
  followUpOpening,
  followUpTemplateAsk,
  followUpText,
} from '../followUpWords.js';
import { ATTENDING_WORDS, stageButtonWords } from '../stages.js';

const URGENT: readonly MessageKind[] = ['emergency', 'alert', 'advisory', 'order'];

describe('followUpKindFor — three buckets, and none of them is a new opinion', () => {
  it('sends a meeting and a schedule to the gathering bucket', () => {
    expect(followUpKindFor('meeting', null)).toBe('gathering');
    expect(followUpKindFor('schedule', null)).toBe('gathering');
  });

  it('sends everything the district expects action on to urgent', () => {
    for (const kind of URGENT) {
      expect(followUpKindFor(kind, null), kind).toBe('urgent');
    }
    expect(followUpKindFor('other', 'security')).toBe('urgent');
    expect(followUpKindFor('other', 'flood')).toBe('urgent');
  });

  it('sends a plain notice to information', () => {
    expect(followUpKindFor('other', null)).toBe('information');
    expect(followUpKindFor('other', 'other')).toBe('information');
  });

  it('keeps a meeting about the flood a meeting', () => {
    /**
     * ⚠️ The whole reason `kind` is asked before `category`. Category answers *what a message is
     * about*; this answers *what the reader is being asked to do*, and nobody responds to a
     * meeting — they attend it, whatever it is about.
     */
    expect(followUpKindFor('meeting', 'flood')).toBe('gathering');
    expect(followUpKindFor('meeting', 'security')).toBe('gathering');
  });

  it('answers for every kind and every category it will meet', () => {
    for (const kind of MESSAGE_KINDS) {
      for (const category of [null, 'security', 'flood', 'fire', 'rta', 'medical', 'other']) {
        expect(followUpKindFor(kind, category), `${kind}/${category}`).toBeTruthy();
      }
    }
  });
});

describe('the sentence and the button cannot disagree', () => {
  /**
   * 🔴 **The property that made one shared predicate worth extracting.** These two are read
   * together in one bubble: a chase asking about attendance under a button saying *Responding*,
   * or asking where an incident stands under a button saying *Attending*, is the district's own
   * message arguing with itself in front of an officer.
   */
  it('asks about attendance exactly when the button says Attending', () => {
    for (const kind of MESSAGE_KINDS) {
      const attending = stageButtonWords('responded', kind) === ATTENDING_WORDS;
      expect(followUpKindFor(kind, null) === 'gathering', kind).toBe(attending);
      expect(isGathering(kind), kind).toBe(attending);
    }
  });
});

describe('followUpOpening — a gathering is reminded, everything else is followed up', () => {
  it('opens a meeting as a reminder and names it', () => {
    const opening = followUpOpening('meeting', null, 'Flood coordination — Mon 25 Aug, 11:00');
    expect(opening).toContain('Reminder regarding the subject meeting');
    expect(opening).toContain('Flood coordination — Mon 25 Aug, 11:00');
    // Not the sentence that says somebody is waiting on them. Nobody is.
    expect(opening).not.toContain('following up');
  });

  it('calls a schedule a schedule, because a duty roster is not a meeting', () => {
    expect(followUpOpening('schedule', null, 'August duty roster')).toContain(
      'Reminder regarding the subject schedule',
    );
  });

  it('leaves the emergency opening exactly as it has always read', () => {
    expect(followUpOpening('emergency', 'fire', 'a fire — high')).toBe(
      'The control room is following up on a fire — high.',
    );
  });
});

describe('followUpAsk — what is asked of the reader', () => {
  it('tells a meeting nobody needs to reply', () => {
    const ask = followUpAsk('meeting', null, false);
    expect(ask).toContain('Kindly make it convenient to attend');
    expect(ask).toContain('no reply is required');
  });

  it('never tells a gathering to tap anything, whatever it is asked about buttons', () => {
    /**
     * ⚠️ `hasButtons` is deliberately ignored for a gathering. A chase on a meeting carries no
     * buttons at all, and a sentence that hedged would be describing a control that is not there.
     */
    for (const hasButtons of [true, false]) {
      for (const kind of ['meeting', 'schedule'] as MessageKind[]) {
        expect(followUpAsk(kind, null, hasButtons), `${kind}/${String(hasButtons)}`).not.toContain(
          'tap',
        );
      }
    }
  });

  it('asks an emergency where it stands, and only while there is something to press', () => {
    expect(followUpAsk('emergency', 'fire', true)).toContain('tapping below');
    // Already resolved: naming a button that is not there is the software describing itself wrong.
    expect(followUpAsk('emergency', 'fire', false)).not.toContain('below');
    expect(followUpAsk('emergency', 'fire', false)).toContain('update the control room');
  });

  it('asks a notice to be confirmed as actioned', () => {
    expect(followUpAsk('other', null, true)).toContain('actioned');
  });
});

describe('followUpText — the whole message', () => {
  it("puts the control room's own words where the ask was, and keeps the subject line", () => {
    /**
     * 🔴 **The reschedule case, which is what this endpoint exists for.** A chase that dropped the
     * opening would arrive in a thread holding several of the district's notices saying only
     * *"Meeting moved to Tuesday"*, and the officer would have to guess which meeting.
     */
    const text = followUpText(
      'meeting',
      null,
      'Flood coordination — Tue 26 Aug, 11:00',
      'Meeting moved to Tuesday 11:00.',
      false,
    );
    expect(text).toContain('Reminder regarding the subject meeting');
    expect(text).toContain('Flood coordination — Tue 26 Aug, 11:00');
    expect(text).toContain('Meeting moved to Tuesday 11:00.');
    // The typed note replaced the ask, not the subject line.
    expect(text).not.toContain('no reply is required');
  });

  it('falls back to the ask when the control room typed nothing', () => {
    expect(followUpText('emergency', 'fire', 'a fire — high', undefined, true)).toContain(
      'tapping below',
    );
    expect(followUpText('emergency', 'fire', 'a fire — high', '', true)).toContain('tapping below');
  });

  it('stays well inside what Meta carries, for every kind', () => {
    // 1024 characters with buttons, 4096 without. The subject line is the variable part and is
    // built by `describe()`, so what is guarded here is that these sentences add little.
    for (const kind of MESSAGE_KINDS) {
      const text = followUpText(kind, null, 'a subject line', undefined, true);
      expect(text.length, kind).toBeLessThan(400);
    }
  });
});

describe('followUpTemplateAsk — the road taken when the service window is shut', () => {
  it('reminds rather than demands on a meeting', () => {
    expect(followUpTemplateAsk('meeting', null)).toContain(
      'reminder regarding the subject meeting',
    );
    expect(followUpTemplateAsk('meeting', null)).toContain('Kindly make it convenient to attend');
  });

  it('says the control room is waiting on an emergency', () => {
    expect(followUpTemplateAsk('emergency', 'fire')).toBe(
      'The control room is awaiting your response.',
    );
  });

  it('is never empty, for any kind — Meta refuses an empty parameter', () => {
    for (const kind of MESSAGE_KINDS) {
      expect(followUpTemplateAsk(kind, null).trim(), kind).not.toBe('');
    }
  });
});
