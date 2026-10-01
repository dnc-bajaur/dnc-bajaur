/**
 * **The district's own options, and the two limits that decide whether they arrive at all** —
 * 2026-08-24.
 *
 * Pure, no database. Three things are protected here and they fail in three different ways:
 *
 *   * **the caps.** A row title of 25 characters is a 400 from Meta at 02:00, and on a handset it
 *     reads as *"the district's alert did not arrive"*. Twenty-two of these thirty-three options
 *     are over 24 characters in the district's own wording and **two of the headlines sit exactly
 *     on the line**, so this is the assertion that keeps a well-meant reword from taking the
 *     channel down.
 *   * **the words.** Asserted character for character, because they are the Deputy Commissioner's
 *     office's and not ours. `wording` is what reaches the board, the report and the export.
 *   * **the ids.** They ride inside a button id that sits in an officer's message history for
 *     days. An id that changes meaning is a tap landing on the wrong answer.
 */

import { describe, expect, it } from 'vitest';

import { MESSAGE_KINDS, type MessageKind } from '../events.js';
import {
  HEADLINE_MAX,
  TEMPLATE_CATEGORIES,
  TEMPLATE_OPTIONS,
  UNABLE_BRANCH,
  WORDING_MAX,
  allOptions,
  listFor,
  listTitle,
  optionById,
  optionOfSaid,
  optionTyped,
  optionsOf,
  optionsWrittenOut,
  templateCategoryFor,
  templateOptionFor,
  type ResponseList,
} from '../responseOptions.js';

const LISTS: readonly ResponseList[] = [
  'other',
  'fire',
  'medical',
  'rta',
  'alert',
  'flood',
  'security',
  'advisory',
  'information',
];

/** The six the reporting screen offers, plus the absence of one. */
const CATEGORIES: readonly (string | null)[] = [
  'fire',
  'flood',
  'rta',
  'medical',
  'security',
  'other',
  null,
];

describe("Meta's caps", () => {
  it('keeps every headline inside a list row title', () => {
    for (const option of allOptions()) {
      expect(
        option.headline.length,
        `"${option.headline}" is ${String(option.headline.length)} characters`,
      ).toBeLessThanOrEqual(HEADLINE_MAX);
      expect(option.headline.trim()).not.toBe('');
    }
  });

  it("keeps every one of the district's sentences inside a row description", () => {
    for (const option of allOptions()) {
      expect(
        option.wording.length,
        `"${option.wording}" is ${String(option.wording.length)} characters`,
      ).toBeLessThanOrEqual(WORDING_MAX);
    }
  });

  /**
   * The two that sit on the line are named rather than merely covered by the loop above, because
   * the loop passing tells nobody that a single added character breaks them.
   */
  it('names the headlines that sit exactly on 24 characters', () => {
    expect(optionById('dept_taking_up')?.headline).toBe('Taken up with department');
    expect(optionById('dept_taking_up')?.headline.length).toBe(24);
    expect(optionById('rta_police')?.headline).toBe('Police / Rescue informed');
    expect(optionById('rta_police')?.headline.length).toBe(24);
    expect(optionById('sec_agency')?.headline.length).toBe(24);
    expect(UNABLE_BRANCH[0]?.headline.length).toBe(24);
  });

  it('keeps every page heading short enough to sit on a handset', () => {
    for (const list of LISTS) {
      expect(listTitle(list).length).toBeLessThanOrEqual(HEADLINE_MAX);
    }
  });

  /** Meta's list cap is ten rows. The longest of these is five, and that headroom is the point. */
  it('never offers more rows than a list can hold', () => {
    for (const list of LISTS) {
      expect(optionsOf(list).length).toBeGreaterThanOrEqual(3);
      expect(optionsOf(list).length).toBeLessThanOrEqual(10);
    }
  });
});

describe("the district's words", () => {
  it('carries the ten categories the district wrote, less the meeting', () => {
    expect(optionsOf('other').map((o) => o.wording)).toEqual([
      'Taking Cognizance',
      'Issue Already Resolved',
      'Matter Being Taken Up with the Concerned Department',
      'Not Related to Me',
      'Unable to Attend / Respond',
    ]);
    expect(optionsOf('fire').map((o) => o.wording)).toEqual([
      'Responding Personally',
      'Deploying Relevant Staff / Team',
      'Matter Already Being Handled',
      'Unable to Respond',
    ]);
    expect(optionsOf('medical').map((o) => o.wording)).toEqual([
      'Taking Immediate Action',
      'Medical Teams Ready',
      'Matter Already Being Attended',
      'Unable to Respond',
    ]);
    expect(optionsOf('rta').map((o) => o.wording)).toEqual([
      'Proceeding to the Site',
      'Relevant Team Being Dispatched',
      'Matter Already Being Attended',
      'Police / Rescue / Relevant Department Informed',
      'Unable to Respond',
    ]);
    expect(optionsOf('alert').map((o) => o.wording)).toEqual([
      'Alert Noted — Taking Necessary Action',
      'Relevant Staff / Field Team Alerted',
      'Matter Already Under Control',
      'Further Information Required',
      'Unable to Respond',
    ]);
    expect(optionsOf('flood').map((o) => o.wording)).toEqual([
      'Taking Preventive Measures',
      'Field Team Being Deployed',
      'Situation Being Monitored',
      'Unable to Respond',
    ]);
    expect(optionsOf('security').map((o) => o.wording)).toEqual([
      'Security Measures Being Taken',
      'Security Personnel Being Deployed',
      'Matter Already Being Handled',
      'Relevant Security Agency / Department Informed',
      'Unable to Respond',
    ]);
    expect(optionsOf('advisory').map((o) => o.wording)).toEqual([
      'Advisory Noted — Necessary Measures Being Taken',
      'Advisory Conveyed to Relevant Staff',
      'Necessary Preventive Measures Already in Place',
      'Further Clarification Required',
      'Unable to Respond',
    ]);
    expect(optionsOf('information').map((o) => o.wording)).toEqual([
      'Information Noted',
      'Information Conveyed to Relevant Staff',
      'Necessary Action Being Taken',
      'Information Requires Further Clarification',
    ]);
  });

  /**
   * ⚠️ Category 1 says *Attend / Respond* and the other eight say *Respond*. Almost certainly the
   * same thing, and deliberately **not** ironed out — their wording is what reaches the record.
   */
  it('keeps the one category where the district wrote a different sentence', () => {
    expect(optionById('unable_attend')?.wording).toBe('Unable to Attend / Respond');
    expect(optionById('unable')?.wording).toBe('Unable to Respond');
    expect(optionsOf('other').at(-1)?.id).toBe('unable_attend');
    for (const list of [
      'fire',
      'medical',
      'rta',
      'alert',
      'flood',
      'security',
      'advisory',
    ] as const) {
      expect(optionsOf(list).at(-1)?.id).toBe('unable');
    }
  });

  /**
   * 🔴 A named deputy on the way is NOT a decline, however the district filed it. `records`
   * answers *does the control room need to send somebody else*, and here it does not.
   */
  it('does not treat a named representative as an emergency nobody has taken', () => {
    expect(optionById('unable_rep')?.records).toBe('responded');
  });

  it('offers the three ways to be unavailable, each asking something different', () => {
    expect(UNABLE_BRANCH.map((o) => o.wording)).toEqual([
      'Sending a Responsible Representative',
      'On Leave',
      'Otherwise Unavailable',
    ]);
    expect(UNABLE_BRANCH.map((o) => o.asks)).toEqual(['name', 'until', 'reason']);
    expect(UNABLE_BRANCH.map((o) => o.records)).toEqual(['responded', 'no_owner', 'no_owner']);
  });

  /** Information is left without one on purpose. §9 Q3 asks the district whether that is right. */
  it('leaves information without an unable option, exactly as the district wrote it', () => {
    expect(optionsOf('information').some((o) => o.records === 'no_owner')).toBe(false);
  });
});

describe('what an option records', () => {
  /**
   * 🔴 **The district's answer of 2026-08-25, and it reversed what shipped the day before.**
   *
   * `already_handled`, `already_attended` and `alert_control` went out as `responded`, on the
   * reading that *somebody else is on it* describes an emergency in progress rather than one that
   * is over — and closing a live fire on one officer's report about a colleague was the more
   * dangerous of the two mistakes. §9 Q4 asked, and the district said *"Already being handlled ka
   * matlab khatm hai"*.
   *
   * ⚠️ **Four sentences now take an emergency off the board and stop its clock**, so this test
   * names all four rather than counting them: a fifth arriving by accident is a fifth way to close
   * something nobody has been to.
   */
  it('closes an emergency on the four sentences the district says mean it is over', () => {
    const resolving = allOptions().filter((o) => o.records === 'resolved');
    expect(resolving.map((o) => o.wording).sort()).toEqual([
      'Issue Already Resolved',
      'Matter Already Being Attended',
      'Matter Already Being Handled',
      'Matter Already Under Control',
    ]);
  });

  it('shares one option between the lists that offer the same sentence', () => {
    // One sentence, one option — however many lists offer it. See `ALREADY_HANDLED`.
    expect(optionsOf('fire')).toContain(optionById('already_handled'));
    expect(optionsOf('security')).toContain(optionById('already_handled'));
    expect(optionsOf('medical')).toContain(optionById('already_attended'));
    expect(optionsOf('rta')).toContain(optionById('already_attended'));
  });

  /**
   * ⚠️ **Re-pinned 2026-09-04 — this used to assert `'acknowledged'`, and nothing produces that
   * value any more.** ADR-0034's per-category templates never offer a bare "I saw this": every
   * button on every category maps to Responded or Resolved, because the first tap already IS the
   * response (`TEMPLATE_OPTIONS`). `cognizance` and `info_noted` were re-mapped to match — an
   * officer answering "Taking Cognizance" or "Information Noted" has responded in their own words.
   *
   * **What did NOT move is that neither one RESOLVES anything** — that is still the four sentences
   * above and only those four. Cognizance and "noted" still mean simply *seen*; they no longer sit
   * in a separate bucket to say so, but they must never start closing emergencies by accident.
   */
  it('records mere cognizance as a response, never a resolution', () => {
    expect(optionById('cognizance')?.records).toBe('responded');
    expect(optionById('info_noted')?.records).toBe('responded');
  });

  it('takes no ownership from an officer who cannot act or says it is not theirs', () => {
    expect(optionById('not_mine')?.records).toBe('no_owner');
    expect(optionById('unable')?.records).toBe('no_owner');
    expect(optionById('unable_attend')?.records).toBe('no_owner');
  });

  it('asks for a sentence wherever the district asked for one, and nowhere else', () => {
    const asking = allOptions()
      .filter((o) => o.asks === 'message')
      .map((o) => o.wording);
    expect(asking).toEqual([
      'Further Information Required',
      'Further Clarification Required',
      'Information Requires Further Clarification',
    ]);
  });

  it('opens the branch from every unable option and from nothing else', () => {
    const branching = allOptions()
      .filter((o) => o.asks === 'branch')
      .map((o) => o.id);
    expect(branching.sort()).toEqual(['unable', 'unable_attend']);
  });
});

describe('ids', () => {
  it('gives every option an id of its own', () => {
    const ids = allOptions().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * They sit inside `resp:<id>:<incidentId>:<attemptId>`, against Meta's 200-character cap on a
   * row id. Two uuids and the prefix are 82, so this leaves the ceiling a long way off — but the
   * assertion is here because an id is invisible until the day one is too long.
   */
  it('keeps every id short enough to ride in a row id beside two uuids', () => {
    for (const option of allOptions()) {
      expect(option.id).toMatch(/^[a-z_]+$/);
      expect(`resp:${option.id}:${'x'.repeat(36)}:${'x'.repeat(36)}`.length).toBeLessThanOrEqual(
        200,
      );
    }
  });

  it('finds an option by its id and refuses one it does not know', () => {
    expect(optionById('rta_site')?.wording).toBe('Proceeding to the Site');
    expect(optionById('nothing_like_this')).toBeNull();
  });
});

describe('reading an option back out of what was said', () => {
  it("recognises every one of the district's own sentences", () => {
    for (const option of allOptions()) {
      expect(optionOfSaid(option.wording)?.id, option.wording).toBe(option.id);
    }
  });

  it('forgives case and stray space, and nothing else', () => {
    expect(optionOfSaid('  taking cognizance ')?.id).toBe('cognizance');
    expect(optionOfSaid('MEDICAL TEAMS READY')?.id).toBe('med_teams');
  });

  /**
   * An officer's own words are not a failure to classify — they are usually a better answer than
   * any row, and `AttendanceAnswer`'s `other` makes exactly this distinction one file over.
   */
  it("leaves an officer's own words alone", () => {
    expect(optionOfSaid('on my way, will be there in ten minutes')).toBeNull();
    expect(optionOfSaid('')).toBeNull();
    expect(optionOfSaid(null)).toBeNull();
    expect(optionOfSaid(undefined)).toBeNull();
  });
});

describe('which list a message gets', () => {
  it('gives a meeting none, because attendance owns that conversation', () => {
    for (const category of CATEGORIES) expect(listFor('meeting', category)).toBeNull();
  });

  it('lets the kind win, so a flood alert is answered as an alert', () => {
    expect(listFor('alert', 'flood')).toBe('alert');
    expect(listFor('alert', 'security')).toBe('alert');
    expect(listFor('advisory', 'flood')).toBe('advisory');
  });

  it('gives an emergency the list for what it is about', () => {
    expect(listFor('emergency', 'fire')).toBe('fire');
    expect(listFor('emergency', 'medical')).toBe('medical');
    expect(listFor('emergency', 'rta')).toBe('rta');
    expect(listFor('emergency', 'flood')).toBe('flood');
    expect(listFor('emergency', 'security')).toBe('security');
    expect(listFor('emergency', 'other')).toBe('other');
    expect(listFor('emergency', null)).toBe('other');
  });

  it('sends an order to the list that lets an officer say it is not theirs', () => {
    expect(listFor('order', null)).toBe('other');
  });

  it('falls to information for everything the district did not name', () => {
    expect(listFor('schedule', null)).toBe('information');
    expect(listFor('other', null)).toBe('information');
  });

  /** Total, so a kind added later gets the list that asks little rather than the wrong thing. */
  it('answers for every kind and every category', () => {
    for (const kind of MESSAGE_KINDS) {
      for (const category of CATEGORIES) {
        const list = listFor(kind as MessageKind, category);
        if (kind === 'meeting') {
          expect(list).toBeNull();
        } else {
          expect(LISTS).toContain(list);
        }
      }
    }
  });
});

/**
 * **The options written into the message, and read back out of a typed reply** — 2026-08-26.
 *
 * The pair is tested together because they are one mechanism: the number `optionsWrittenOut`
 * prints is the number `optionTyped` counts, and a district that printed `1.` while counting from
 * zero would record every answer as the one above it.
 */
describe('the options, written out and typed back', () => {
  const BODY_MAX_WITH_BUTTONS = 1024;
  const LEAD = 'Thank you for the Acknowledgement.\n\nKindly select one:';

  /**
   * 🔴 **The assertion that keeps the options on the screen at all.**
   *
   * `sendSession` refuses a body over Meta’s 1024 and `offerOptions` then returns `false`, which
   * drops the officer to the plain thank-you **with no options whatsoever** — the exact silence
   * this whole workflow exists to end, arriving without an error anybody would see. The longest
   * list composes to a little over 250, so the room is real; this is here so a future option
   * cannot quietly spend it.
   */
  it('leaves every list far inside the body Meta accepts', () => {
    for (const list of LISTS) {
      const body = optionsWrittenOut(LEAD, optionsOf(list));
      expect(body.length).toBeLessThan(BODY_MAX_WITH_BUTTONS);
      /** Not merely inside it — inside it with most of the budget unspent. */
      expect(body.length).toBeLessThan(BODY_MAX_WITH_BUTTONS / 2);
    }

    expect(
      optionsWrittenOut('"Unable to Respond" — which of these?', UNABLE_BRANCH).length,
    ).toBeLessThan(BODY_MAX_WITH_BUTTONS);
  });

  /**
   * ⚠️ **`wording` and never `headline`.** The headline is a 24-character label invented for
   * Meta’s row title; the district wrote the sentence. A body has room for the real one, and the
   * officer should read what the record is going to say about them.
   */
  it('writes the district’s own sentence, numbered from one', () => {
    const body = optionsWrittenOut(LEAD, optionsOf('rta'));

    expect(body).toBe(
      'Thank you for the Acknowledgement.\n\nKindly select one:\n\n' +
        '1. Proceeding to the Site\n' +
        '2. Relevant Team Being Dispatched\n' +
        '3. Matter Already Being Attended\n' +
        '4. Police / Rescue / Relevant Department Informed\n' +
        '5. Unable to Respond',
    );

    /** The 24-character label is for the row, and must not leak into the message. */
    expect(body).not.toContain('Proceeding to the site');
  });

  it('keeps the lead line exactly as it was given', () => {
    for (const list of LISTS)
      expect(optionsWrittenOut(LEAD, optionsOf(list)).startsWith(LEAD + '\n\n')).toBe(true);
  });

  /**
   * 🔴 **The number an officer can see is the option they get.** Off by one here and a road
   * accident records *Proceeding to the Site* when the officer said they cannot come.
   */
  it('reads a typed number as the option that carries it', () => {
    const rta = optionsOf('rta');
    for (let i = 0; i < rta.length; i += 1) {
      expect(optionTyped(String(i + 1), rta)).toBe(rta[i]);
    }
  });

  it('reads the district’s sentence, and the row label, whatever the case and spacing', () => {
    const rta = optionsOf('rta');

    expect(optionTyped('Proceeding to the Site', rta)?.id).toBe('rta_site');
    expect(optionTyped('  proceeding to the site  ', rta)?.id).toBe('rta_site');
    /** What they would have read on the row, had they opened the sheet. */
    expect(optionTyped('Police / Rescue informed', rta)?.id).toBe('rta_police');
  });

  /**
   * ⚠️ **A number outside the list is not an answer**, and neither is a sentence that merely
   * begins with one. Reading *“1 casualty, sending an ambulance”* as option 1 would put an answer
   * on the record that nobody gave — and that record stops an SLA clock.
   */
  it('refuses anything that is not one of the options offered', () => {
    const rta = optionsOf('rta');

    expect(optionTyped('0', rta)).toBeNull();
    expect(optionTyped('6', rta)).toBeNull();
    expect(optionTyped('11', rta)).toBeNull();
    expect(optionTyped('1 casualty, sending an ambulance', rta)).toBeNull();
    expect(optionTyped('on my way', rta)).toBeNull();
    expect(optionTyped('', rta)).toBeNull();
    expect(optionTyped('   ', rta)).toBeNull();
    expect(optionTyped(null, rta)).toBeNull();
    expect(optionTyped(undefined, rta)).toBeNull();
  });

  /**
   * ⚠️ **Scoped to the list that was offered, never to every option this software knows.** A row
   * id carries its own identity and `optionById` is right for it; a bare number carries none, so
   * `4` on a four-option list must not reach the fifth option of a five-option one.
   */
  it('counts within the list it was given and no further', () => {
    expect(optionsOf('fire')).toHaveLength(4);
    expect(optionTyped('5', optionsOf('fire'))).toBeNull();

    /** The same number, two lists, two different and correct answers. */
    expect(optionTyped('3', optionsOf('fire'))?.wording).toBe('Matter Already Being Handled');
    expect(optionTyped('3', optionsOf('rta'))?.wording).toBe('Matter Already Being Attended');

    /** A wording from another list is not on this officer’s screen and is not their answer. */
    expect(optionTyped('Medical Teams Ready', optionsOf('rta'))).toBeNull();
  });

  it('finds nothing in an empty list rather than throwing', () => {
    expect(optionTyped('1', [])).toBeNull();
    expect(optionsWrittenOut(LEAD, [])).toBe(LEAD + '\n\n');
  });

  /**
   * 🔴 **What is written out is exactly what can be typed back, for every list.** The two
   * functions are only useful as a pair, so the pairing itself is asserted rather than assumed:
   * every line the officer reads resolves to the option that printed it.
   */
  it('round-trips every option of every list, by number and by sentence', () => {
    for (const list of LISTS) {
      const options = optionsOf(list);
      const lines = optionsWrittenOut('lead', options).split('\n').slice(2);

      expect(lines).toHaveLength(options.length);

      lines.forEach((line, i) => {
        const [number, ...rest] = line.split('. ');
        const sentence = rest.join('. ');

        expect(sentence).toBe(options[i]?.wording);
        expect(optionTyped(number, options)).toBe(options[i]);
        expect(optionTyped(sentence, options)).toBe(options[i]);
      });
    }
  });

  /**
   * ⚠️ **The same sentence must not appear twice in one list**, or a typed sentence is ambiguous
   * and the first match silently wins. `ALREADY_HANDLED` and `ALREADY_ATTENDED` were merged into
   * shared constants for the neighbouring reason: two ids sharing one wording.
   */
  it('never offers one list two identical sentences', () => {
    for (const list of LISTS) {
      const wordings = optionsOf(list).map((o) => o.wording.toLowerCase());
      expect(new Set(wordings).size).toBe(wordings.length);
    }
  });
});

/**
 * **The per-category `dnc_response_*` templates — a second road, ADR-0034.**
 *
 * Everything above is the in-window list workflow. These templates are the first message: three
 * category-specific quick replies, no acknowledge step, no *Unable to Respond* branch. `webhooks.ts`
 * matches an inbound button label against {@link templateOptionFor}, scoped to the incident's own
 * category so a label shared across templates cannot land on the wrong one.
 */
describe('the per-category response templates', () => {
  it('gives every kind and emergency category a template category, meeting excepted', () => {
    const categories = [null, 'fire', 'medical', 'rta', 'rescue', 'flood', 'security', 'other'];
    for (const kind of MESSAGE_KINDS) {
      for (const category of categories) {
        const slug = templateCategoryFor(kind as MessageKind, category);
        if (kind === 'meeting') {
          expect(slug).toBeNull();
        } else {
          expect(TEMPLATE_CATEGORIES).toContain(slug);
        }
      }
    }
  });

  it('keeps the district categories the kind alone cannot tell apart', () => {
    // For every kind but emergency the intake TILES carry category:'other', so the KIND decides.
    expect(templateCategoryFor('alert', 'other')).toBe('alert');
    expect(templateCategoryFor('advisory', 'other')).toBe('advisory');
    expect(templateCategoryFor('order', 'other')).toBe('order');
    expect(templateCategoryFor('schedule', 'other')).toBe('schedule');
    expect(templateCategoryFor('other', 'other')).toBe('information');
    expect(templateCategoryFor('meeting', 'other')).toBeNull();
  });

  it('routes an emergency by what it is about', () => {
    expect(templateCategoryFor('emergency', 'fire')).toBe('fire');
    expect(templateCategoryFor('emergency', 'medical')).toBe('medical');
    expect(templateCategoryFor('emergency', 'rta')).toBe('road_accident');
    expect(templateCategoryFor('emergency', 'rescue')).toBe('rescue');
    expect(templateCategoryFor('emergency', 'flood')).toBe('flood');
    expect(templateCategoryFor('emergency', 'security')).toBe('security');
    expect(templateCategoryFor('emergency', 'other')).toBe('other');
    expect(templateCategoryFor('emergency', null)).toBe('other');
  });

  it('reads a tap back as the option it names, scoped to the incident category', () => {
    expect(templateOptionFor('emergency', 'fire', 'Fire Team Dispatched')?.records).toBe(
      'responded',
    );
    expect(templateOptionFor('emergency', 'fire', '  being handled ')?.records).toBe('resolved');
    expect(templateOptionFor('emergency', 'medical', 'Aid Already Provided')?.records).toBe(
      'resolved',
    );
    // A label from another template is not on this officer's screen.
    expect(templateOptionFor('emergency', 'fire', 'Aid Already Provided')).toBeNull();
    // A typed sentence or a tap on district_emergency_v2 is not one of these three.
    expect(templateOptionFor('emergency', 'fire', 'on my way')).toBeNull();
    expect(templateOptionFor('emergency', 'fire', 'Acknowledge')).toBeNull();
    expect(templateOptionFor('meeting', 'other', 'Attending')).toBeNull();
    expect(templateOptionFor('emergency', 'fire', '')).toBeNull();
    expect(templateOptionFor('emergency', 'fire', null)).toBeNull();
  });

  it('shares one label across templates without confusing which category it answers', () => {
    // "Coordinating w/ Dept" is on five of the templates. Each resolves within its own category.
    expect(templateOptionFor('emergency', 'fire', 'Coordinating w/ Dept')?.id).toBe('t_fire_b');
    expect(templateOptionFor('emergency', 'rescue', 'Coordinating w/ Dept')?.id).toBe('t_rescue_b');
  });

  it('never asks a follow-up — three taps, then the closing sentence', () => {
    for (const options of TEMPLATE_OPTIONS.values()) {
      for (const option of options) {
        expect(option.asks).toBe('nothing');
        expect(option.records === 'responded' || option.records === 'resolved').toBe(true);
        expect(option.headline).toBe(option.wording);
      }
    }
  });
});
