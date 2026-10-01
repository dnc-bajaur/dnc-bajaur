/**
 * The wall screen's rules about age and about privacy — M4, ADR-0013.
 *
 * Two things are being pinned here, and they are the two things that will be argued with.
 *
 * **A report expires.** Every panel on a control-room display looks equally authoritative,
 * so the only defence against a green dot from nine hours ago is that the code refuses to
 * call it green.
 *
 * **The screen carries nothing private.** This boundary erodes under pressure from somebody
 * senior with a good reason, which is why the rule is a function with a test rather than a
 * paragraph in a document.
 */

import { describe, expect, it } from 'vitest';
import {
  age,
  presenceAge,
  presenceLabel,
  reportingGap,
  utilityLabel,
  wallSafetyViolations,
  type UtilityStatus,
} from '../wall.js';

const now = new Date('2026-08-03T12:00:00Z');

describe('how old a report is', () => {
  it('calls a recent report fresh', () => {
    const r = age('normal', '2026-08-03T11:50:00Z', 240, now);

    expect(r.freshness).toBe('fresh');
    expect(r.ageMinutes).toBe(10);
    expect(r.value).toBe('normal');
  });

  it('calls an old report stale, and still carries what it said', () => {
    // The value survives. The *screen* chooses not to lead with it, but a caller asking
    // "what was the last thing anybody said about the gas" deserves an answer.
    const r = age('down', '2026-08-03T04:00:00Z', 240, now);

    expect(r.freshness).toBe('stale');
    expect(r.value).toBe('down');
    expect(r.ageMinutes).toBe(480);
  });

  it('separates never-reported from long-ago-reported', () => {
    // Different failures, different fixes. Stale means somebody stopped updating; never
    // means nobody was ever asked to.
    expect(age(null, null, 240, now).freshness).toBe('never');
    expect(age('normal', '2026-01-01T00:00:00Z', 240, now).freshness).toBe('stale');
  });

  it('is fresh exactly at the threshold and stale one minute past it', () => {
    expect(age('normal', '2026-08-03T08:00:00Z', 240, now).freshness).toBe('fresh');
    expect(age('normal', '2026-08-03T07:59:00Z', 240, now).freshness).toBe('stale');
  });

  it('treats a report from the future as age zero rather than negative', () => {
    // A handset with a wrong clock. "Updated -3 minutes ago" reads as a bug and hides the
    // value behind it.
    const r = age('normal', '2026-08-03T12:30:00Z', 240, now);

    expect(r.ageMinutes).toBe(0);
    expect(r.freshness).toBe('fresh');
  });

  it('treats an unparseable timestamp as nothing reported', () => {
    expect(age('normal', 'yesterday afternoon', 240, now).freshness).toBe('never');
  });
});

describe('a null window means the report never expires on its own — ADR-0025', () => {
  it('still calls a ten-hour-old reading fresh, and still knows how old it is', () => {
    // The district's own case. Ten hours against the four-hour install default used to read
    // `no report since 02:00`; the control room asked to be left in charge of that.
    const r = age('degraded', '2026-08-03T02:00:00Z', null, now);

    expect(r.freshness).toBe('fresh');
    expect(r.value).toBe('degraded');
    // INV-02 is met by the age travelling with it, not by withdrawing the value.
    expect(r.ageMinutes).toBe(600);
    expect(r.asOf).toBe('2026-08-03T02:00:00Z');
  });

  it('still says nothing was reported when nothing was', () => {
    // A null window removes the timer, never the difference between "old" and "never".
    expect(age<UtilityStatus>(null, null, null, now).freshness).toBe('never');
  });

  it('still degrades when given a real staleness window', () => {
    expect(age('normal', '2026-08-03T02:00:00Z', 240, now).freshness).toBe('stale');
  });
});

describe('what the screen says', () => {
  it('names the status when the report is fresh', () => {
    expect(utilityLabel(age('degraded', '2026-08-03T11:55:00Z', null, now))).toBe('Degraded');
    expect(presenceLabel(presenceAge('available', '2026-08-03T11:55:00Z', now))).toBe('Available');
  });

  it('goes on naming the status however old a utility report is — ADR-0025', () => {
    // This asserted the opposite until 2026-08-23: a utility past its window read
    // `no report since 02:00`, a sentence about time that did not contain the status at all.
    // The district asked for the timer to go — *"control wale control karenge"* — so what was
    // last said stands until somebody says otherwise.
    const label = utilityLabel(age('normal', '2026-08-03T02:00:00Z', null, now));

    expect(label).toBe('Normal');
  });

  it('says so plainly when nobody has ever reported', () => {
    expect(utilityLabel(age<UtilityStatus>(null, null, null, now))).toBe('not reported');
    expect(presenceLabel(presenceAge(null, null, now))).toBe('not reported');
  });
});

describe('presence is set by hand and never degrades — ADR-0033', () => {
  it('keeps an available reading fresh however old it is', () => {
    // The control room marks an officer available or unavailable by hand. Nothing auto-marks,
    // no timer, no reset — so a reading from days ago still stands until somebody changes it.
    const r = presenceAge('available', '2026-08-01T09:00:00Z', now);

    expect(r.freshness).toBe('fresh');
    expect(r.value).toBe('available');
  });

  it('names the two states and nothing else', () => {
    expect(presenceLabel(presenceAge('available', '2026-08-03T11:55:00Z', now))).toBe('Available');
    expect(presenceLabel(presenceAge('unavailable', '2026-08-03T11:55:00Z', now))).toBe(
      'Unavailable',
    );
  });
});

describe('whether the district is reporting at all', () => {
  it('counts the panels that have gone quiet', () => {
    const gap = reportingGap([
      age('normal', '2026-08-03T11:50:00Z', 240, now),
      age('down', '2026-08-01T11:50:00Z', 240, now),
      age(null, null, 240, now),
    ]);

    expect(gap).toEqual({ total: 3, answering: 1, quiet: 2 });
  });

  it('says nothing is quiet when there is nothing to report', () => {
    expect(reportingGap([])).toEqual({ total: 0, answering: 0, quiet: 0 });
  });
});

describe('nothing private reaches the wall (ADR-0013 §1)', () => {
  it('passes a payload of aggregates', () => {
    expect(
      wallSafetyViolations({
        incidentsToday: 4,
        unassigned: 2,
        departments: [{ name: 'Rescue 1122', open: 3 }],
        utilities: [
          { name: 'Electricity (PESCO)', status: 'normal', asOf: '2026-08-03T11:50:00Z' },
        ],
      }),
    ).toEqual([]);
  });

  it('catches a phone number wherever it is nested', () => {
    const found = wallSafetyViolations({
      panels: [{ rows: [{ label: 'call 0333-1234567 for the DEO' }] }],
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a phone number');
  });

  it('catches a coordinate pair', () => {
    const found = wallSafetyViolations({ where: '34.71561, 71.51413' });

    expect(found[0]).toContain('a coordinate');
  });

  it('catches a forbidden field even when its value looks harmless', () => {
    // `description` is where the reporter's own words live. "fire at the shop" identifies
    // nobody until you know which shop, and the person reading the wall usually does.
    const found = wallSafetyViolations({ incident: { description: 'fire' } });

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('not permitted');
  });

  it('reports every violation, not the first', () => {
    // A caller fixing these one release at a time is a caller who ships three of them.
    const found = wallSafetyViolations({
      a: { phone: '1' },
      b: 'reach him on 0300-0000001',
    });

    expect(found).toHaveLength(2);
  });

  it('is not confused by nulls, numbers or empty objects', () => {
    expect(wallSafetyViolations({ a: null, b: 4, c: {}, d: [], e: undefined })).toEqual([]);
  });

  it('does not flag an ordinary four-digit emergency number', () => {
    // 1122, 15 and 16 are published, national, and the entire point of the contacts panel.
    // A rule that caught them would be turned off by the first person it inconvenienced.
    expect(wallSafetyViolations({ contacts: ['1122', '15', '16'] })).toEqual([]);
  });
});

describe('a uuid is not a phone number', () => {
  it('does not flag an id, however unlucky its digits', () => {
    // This fired in production terms: the dashboard began returning 500 for every caller
    // because one seeded row drew an id containing a run that reads as a Pakistani number,
    // and the error named a phone number that was not there.
    const unlucky = [
      '0f8a1b2c-0207-4f84-9207-00f846478123',
      '92345678-1234-4321-8765-092345678901',
      'a02acee3-97a7-4658-a207-00f84647a54c',
    ];

    for (const id of unlucky) expect(wallSafetyViolations({ id })).toEqual([]);
  });

  it('still flags a real number that merely sits beside one', () => {
    // The exemption is for a string that *is* a uuid, not for anything containing one.
    const found = wallSafetyViolations({
      note: 'a02acee3-97a7-4658-a207-00f84647a54c — call 0333-1234567',
    });

    expect(found).toHaveLength(1);
  });
});

describe('a web address is not a phone number — but it can still be a coordinate', () => {
  it('does not flag a headline link, however unlucky its token', () => {
    /**
     * The uuid failure, waiting to happen a second time. Google addresses an article with a
     * long generated token, and a token drawn from an alphabet containing digits will sooner
     * or later carry a run that reads as a Pakistani number. A violation **fails the request**,
     * so the cost of getting this wrong is the DC office's dashboard going blank over one
     * article, with an error naming a number that was never there.
     */
    const unlucky = [
      'https://news.google.com/rss/articles/CBMi03331234567aHR0cHM6Ly93d3cuZGF3bi5jb20',
      'https://news.google.com/rss/articles/CBMiW92345678901234VuLmNvbS9uZXdz?oc=5',
      'https://www.dawn.com/news/1892345678901/flood-warning-issued-for-bajaur',
    ];

    for (const url of unlucky) expect(wallSafetyViolations({ url })).toEqual([]);
  });

  it('still flags a coordinate inside a link, because that is a real leak', () => {
    // The exemption skips the digit-run shape and nothing else. A map link to where an
    // incident is would put a caller's location on a wall a room reads, and base64 carries
    // neither a dot nor a comma — so keeping this rule live over links costs nothing.
    const found = wallSafetyViolations({ url: 'https://maps.example.com/?q=34.71561,71.51413' });

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a coordinate');
  });

  it('still flags a number in prose that merely contains a link', () => {
    // Anchored, like the uuid rule: a sentence around a link is something somebody wrote,
    // and prose is where a number actually hides.
    const found = wallSafetyViolations({
      note: 'see https://www.dawn.com/news/1892345 or call 0333-1234567',
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a phone number');
  });
});

/**
 * **An incident id may go on a wall — a person's id may not.** 2026-08-23.
 *
 * Added when the *Still running* rows became openable: a row has to say **which** incident it
 * is for anybody to be able to open it and close it. The distinction this file exists to hold
 * is that ADR-0013 §1 forbids identifying a **person**, not identifying an **event** — the
 * events are the entire subject of the screen.
 */
describe('what identifies an event, and what identifies a person', () => {
  const INCIDENT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('lets a wall row carry the incident it stands for', () => {
    expect(wallSafetyViolations({ stillRunning: { visible: [{ incidentId: INCIDENT }] } })).toEqual(
      [],
    );
  });

  it('🔴 still refuses the person, in the same row', () => {
    /**
     * The guard verified **failing**, not merely passing. A rule that permits everything is
     * indistinguishable from one that works until the day somebody adds a name to a row.
     */
    const found = wallSafetyViolations({
      stillRunning: { visible: [{ incidentId: INCIDENT, personId: INCIDENT }] },
    });

    expect(found.length).toBe(1);
    expect(found[0]).toContain('personId');
  });
});
