/**
 * The three stages the district reads — M9-25, M9-26, narrowed from four 2026-09-04.
 *
 * Pure, no database. What is being protected here is that the three stay a **view** of the
 * seven: every status maps somewhere, nothing maps backwards, and the table cannot quietly grow
 * a stage the transition rules do not know about.
 */

import { describe, expect, it } from 'vitest';

import type { IncidentStatus } from '../incident.js';
import { MESSAGE_KINDS, type MessageKind } from '../events.js';
import {
  STAGES,
  STAGE_BUTTON_WORDS,
  type Stage,
  stageButtonWords,
  stageIndex,
  stageIsStillAhead,
  stageLabel,
  stageOf,
  stagesOfferedFrom,
} from '../stages.js';

const ALL_STATUSES: readonly IncidentStatus[] = [
  'reported',
  'triaged',
  'routed',
  'acknowledged',
  'responding',
  'resolved',
  'closed',
];

describe('stageOf', () => {
  it('answers for every status the fold can produce', () => {
    // The one property that must not rot. A status added to the fold with no stage would make
    // `stageOf` return undefined and a board row would render an empty word for an emergency.
    for (const status of ALL_STATUSES) {
      expect(STAGES, `${status} has no stage`).toContain(stageOf(status));
    }
  });

  it('calls everything before an acknowledgement Issued, including routed', () => {
    expect(stageOf('reported')).toBe('issued');
    expect(stageOf('triaged')).toBe('issued');
    // Routed is genuinely further along than reported, and the detail screen still says so.
    // These four words are what somebody says out loud; they are not the whole record.
    expect(stageOf('routed')).toBe('issued');
  });

  it('calls a closed incident Resolved, because closing is the district’s own bookkeeping', () => {
    // An officer who resolved something at 03:00 should not see it described differently
    // because an administrator has not been to the screen yet.
    expect(stageOf('resolved')).toBe('resolved');
    expect(stageOf('closed')).toBe('resolved');
  });

  it('labels every stage in the past tense', () => {
    // "Responding" would be a claim about right now, which nothing in the log can support once
    // the officer has put the phone down.
    expect(STAGES.map(stageLabel)).toEqual(['Issued', 'Responded', 'Resolved']);
  });
});

describe('stagesOfferedFrom — the whole transition table (M9-26)', () => {
  it('offers both remaining stages to an incident somebody has just acknowledged', () => {
    expect(stagesOfferedFrom('acknowledged')).toEqual(['responded', 'resolved']);
  });

  it('offers only resolution once somebody is already responding', () => {
    expect(stagesOfferedFrom('responding')).toEqual(['resolved']);
  });

  it('offers nothing on a resolved or closed incident', () => {
    // Not an error state. A link tapped on something a colleague finished is answered with
    // "already recorded" rather than a refusal — see the redemption tests.
    expect(stagesOfferedFrom('resolved')).toEqual([]);
    expect(stagesOfferedFrom('closed')).toEqual([]);
  });

  it('never offers Issued, from anywhere', () => {
    // There is no such act as moving an emergency back to the beginning. A token that could do
    // it would be a way to walk the record backwards, and the database constraint refuses the
    // value as well — two locks, because only one of them is ever read by any given person.
    for (const status of ALL_STATUSES) {
      expect(stagesOfferedFrom(status)).not.toContain('issued');
    }
  });

  it('only ever offers stages that are actually ahead of where the incident is', () => {
    for (const status of ALL_STATUSES) {
      for (const stage of stagesOfferedFrom(status)) {
        expect(stageIndex(status)).toBeLessThan(STAGES.indexOf(stage));
        expect(stageIsStillAhead(stage, status)).toBe(true);
      }
    }
  });
});

describe('stageIsStillAhead — what a link tapped hours later is allowed to do', () => {
  it('refuses a stage the incident has already passed', () => {
    // The adversarial case this exists for: a Responded link tapped after a colleague resolved
    // the emergency. The record must not go backwards, and the officer must not be told off.
    expect(stageIsStillAhead('responded', 'resolved')).toBe(false);
    expect(stageIsStillAhead('responded', 'closed')).toBe(false);
  });

  it('refuses a stage the incident is currently at', () => {
    expect(stageIsStillAhead('responded', 'responding')).toBe(false);
    expect(stageIsStillAhead('resolved', 'resolved')).toBe(false);
  });

  it('allows a stage still ahead', () => {
    expect(stageIsStillAhead('responded', 'acknowledged')).toBe(true);
    expect(stageIsStillAhead('resolved', 'responding')).toBe(true);
  });
});

/**
 * **The word on the button, chosen by what the message was** — 2026-08-24.
 *
 * The owner said it after seeing a live handset: *“Meeting k lye Attending ho, Emergency/Flood k
 * lye Responding ho, and so on”*. What is guarded here is not the two words — it is that **one
 * button never again wears one word across seven kinds of message**, and that the wrong one
 * cannot come back without a test going red.
 */
describe('stageButtonWords — a gathering is attended, everything else is responded to', () => {
  it('says Attending on a meeting', () => {
    expect(stageButtonWords('responded', 'meeting')).toBe('Attending');
  });

  it('says Attending on a schedule, which is a programme with times', () => {
    // ⚠️ Deliberately NOT what `thanksKindFor` decides about a schedule. That one picks the
    // district's *information* sentence, because their meeting sentence says “attend the subject
    // meeting” and a duty schedule is not a meeting. This asks a different question — what the
    // officer is doing — and a programme with times is attended.
    expect(stageButtonWords('responded', 'schedule')).toBe('Attending');
  });

  it('says Responding on everything the district sends to be acted on', () => {
    for (const kind of ['emergency', 'alert', 'advisory', 'order', 'other'] as MessageKind[]) {
      expect(stageButtonWords('responded', kind), kind).toBe('Responding');
    }
  });

  it('never says On scene, which is a claim about a place most of these messages do not have', () => {
    // The defect in one line: a meeting notice asked an officer to confirm they had arrived at
    // an incident. It must not come back through the default either.
    for (const kind of MESSAGE_KINDS) {
      expect(stageButtonWords('responded', kind), kind).not.toBe('On scene');
    }
    expect(STAGE_BUTTON_WORDS.responded).not.toBe('On scene');
  });

  it('leaves every other stage alone, whatever the message was', () => {
    // Only *responded* was ever ambiguous. *Resolved* means resolved at a meeting too.
    for (const stage of ['issued', 'resolved'] as Stage[]) {
      for (const kind of MESSAGE_KINDS) {
        expect(stageButtonWords(stage, kind), `${stage}/${kind}`).toBe(STAGE_BUTTON_WORDS[stage]);
      }
    }
  });

  it('answers for every kind, and never longer than Meta allows', () => {
    // Total on purpose: a kind added later falls to *Responding*, which is flat rather than
    // false. Twenty characters is the cap on a button title.
    for (const stage of STAGES) {
      for (const kind of MESSAGE_KINDS) {
        const words = stageButtonWords(stage, kind);
        expect(words, `${stage}/${kind}`).toBeTruthy();
        expect(words.length, `${stage}/${kind}`).toBeLessThanOrEqual(20);
      }
    }
  });
});
