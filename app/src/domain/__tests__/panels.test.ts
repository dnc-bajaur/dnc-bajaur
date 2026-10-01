/**
 * The panel registry and the layout the district composes — ADR-0015, M6-27…M6-32.
 *
 * Two of these are security tests wearing layout clothes, and they are the ones to read first:
 *
 *   * **A stored layout cannot show a department a panel its audience does not include.** The
 *     editor will not offer "This system" to a department — but an editor is not a control
 *     (INV-05), and a layout is data that a crafted `config_event` could write.
 *   * **A corrupt layout renders the default rather than nothing.** A screen that goes blank
 *     because a configuration row was malformed is a district that cannot see its own
 *     emergencies, which is a worse outcome than an arrangement nobody chose.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYOUT, fits, PANELS, panelById, parseLayout, resolveLayout } from '../panels.js';

const DISTRICT = { isAdministration: true };
const DEPARTMENT = { isAdministration: false };

describe('the registry', () => {
  it('gives every panel a plain-language name and a sentence', () => {
    // The editor arranges "Emergency numbers" and "This system", never `dashKeys` and
    // `dashCondition`. Somebody choosing between fourteen of these has to tell them apart.
    for (const panel of PANELS) {
      expect(panel.name.length).toBeGreaterThan(3);
      expect(panel.what.length).toBeGreaterThan(10);
      expect(panel.sizes.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids, because a layout names panels by id', () => {
    expect(new Set(PANELS.map((p) => p.id)).size).toBe(PANELS.length);
  });

  it('offers a panel only at sizes it is legible at', () => {
    // Eighty department rows are unreadable at anything but large. Offering the other sizes
    // would be offering a way to produce a panel nobody can read from across a room.
    expect(panelById('departments')?.sizes).toEqual(['large']);
  });
});

describe('the built-in default — M6-29', () => {
  it('fits a 1920×1080 screen', () => {
    // The whole point. Fourteen panels exist and roughly nine fit; this is the nine somebody
    // had to choose on day one so the district has a screen before it has an opinion.
    expect(fits(DEFAULT_LAYOUT).overflows).toBe(false);
  });

  it('names only panels that exist', () => {
    for (const placed of DEFAULT_LAYOUT.panels) {
      expect(panelById(placed.id), `${placed.id} is not in the registry`).toBeDefined();
    }
  });

  it('leads with the counters, which is what a room reads first', () => {
    expect(DEFAULT_LAYOUT.panels[0]?.id).toBe('keys');
  });
});

describe('resolving a layout', () => {
  it('never shows a department an administration-only panel', () => {
    /**
     * The security half. `condition` carries backup, standby and WhatsApp health — the two
     * offices' to fix, and three red rows a department can do nothing about teach it to ignore
     * red rows. The editor will not offer it; this is what makes that true rather than polite.
     */
    const crafted = { panels: [{ id: 'condition', size: 'small' as const }] };

    expect(resolveLayout(crafted, DISTRICT).panels).toHaveLength(1);
    expect(resolveLayout(crafted, DEPARTMENT).panels).toHaveLength(0);
  });

  it('drops a panel that no longer exists, and says so', () => {
    // A release removed a panel; a layout somebody wrote a year ago still names it. Reported
    // rather than swallowed — it vanished from a screen, and the editor is the only place
    // anybody will be told why.
    const stale = {
      panels: [
        { id: 'keys', size: 'large' as const },
        { id: 'the-old-numbers-panel', size: 'small' as const },
      ],
    };

    const resolved = resolveLayout(stale, DISTRICT);

    expect(resolved.panels.map((p) => p.id)).toEqual(['keys']);
    expect(resolved.problems[0]?.panelId).toBe('the-old-numbers-panel');
  });

  it('corrects an illegible size rather than refusing the layout', () => {
    // Refusing the whole arrangement over one bad size would take the screen down. The layout
    // is still broadly what the district asked for.
    const resolved = resolveLayout({ panels: [{ id: 'departments', size: 'small' }] }, DISTRICT);

    expect(resolved.panels[0]?.size).toBe('large');
    expect(resolved.problems[0]?.why).toContain('legible');
  });

  it('shows the same panel once, however many times it was added', () => {
    const resolved = resolveLayout(
      {
        panels: [
          { id: 'keys', size: 'large' },
          { id: 'keys', size: 'small' },
        ],
      },
      DISTRICT,
    );

    expect(resolved.panels).toHaveLength(1);
  });

  it('keeps the order the district chose', () => {
    // Order is the whole content of a layout: which panel is first, which is fourth, which got
    // cut. Anything that quietly re-sorted would be deciding for them.
    const resolved = resolveLayout(
      {
        panels: [
          { id: 'weather', size: 'small' },
          { id: 'keys', size: 'large' },
          { id: 'alerts', size: 'small' },
        ],
      },
      DISTRICT,
    );

    expect(resolved.panels.map((p) => p.id)).toEqual(['weather', 'keys', 'alerts']);
  });
});

describe('reading a stored layout', () => {
  it('refuses anything that is not a layout, so the default can render', () => {
    // Null for all of these, and the caller falls back. A screen that throws is a district
    // that cannot see its own emergencies.
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout('{"panels":[]}')).toBeNull();
    expect(parseLayout({})).toBeNull();
    expect(parseLayout({ panels: 'keys' })).toBeNull();
    expect(parseLayout({ panels: [] })).toBeNull();
  });

  it('keeps the entries it can understand and drops the rest', () => {
    const layout = parseLayout({
      panels: [{ id: 'keys', size: 'large' }, { size: 'small' }, 'weather', { id: 'alerts' }],
    });

    expect(layout?.panels).toEqual([
      { id: 'keys', size: 'large' },
      // No size given: medium, rather than dropping a panel the district asked for over a
      // missing field.
      { id: 'alerts', size: 'medium' },
    ]);
  });
});

describe('whether it fits — M6-32', () => {
  it('reports an overflow without anything refusing it', () => {
    /**
     * A warning and never a refusal. The district may be running a larger screen, may be happy
     * to scroll at a desk, or may simply want one more panel today. A tool that refuses on an
     * estimate is a tool that gets worked around, and the workaround is a second screen nobody
     * maintains.
     */
    const everything = { panels: PANELS.map((p) => ({ id: p.id, size: 'large' as const })) };
    const verdict = fits(everything);

    expect(verdict.overflows).toBe(true);
    expect(verdict.slots).toBeGreaterThan(9);

    // And it still resolves to a full, renderable layout — nothing here stops it being saved.
    expect(resolveLayout(everything, DISTRICT).panels.length).toBeGreaterThan(0);
  });

  it('says a small screenful does fit', () => {
    expect(fits({ panels: [{ id: 'keys', size: 'small' }] }).overflows).toBe(false);
  });
});
