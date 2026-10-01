/**
 * The dashboard's cards, as objects with depth.
 *
 * A card tilts towards the pointer, catches a light that moves with it, and lifts its own
 * contents to different heights so the number travels further than the label under it. That
 * parallax is the whole point: it says *this is the thing on the card* without making anything
 * bigger and without spending a colour, which on a screen whose colour vocabulary is already
 * carrying INV-04 is the only budget left.
 *
 * ## Three things this file is built around
 *
 * **The listener lives on the deck, never on a card.** `reconcile` in `dashboard.ts` replaces a
 * tile node whenever its signature changes, so a listener attached to a card would be thrown
 * away on the next poll and the card would quietly stop responding — with nothing on screen to
 * say so. One listener on the container survives every replacement underneath it.
 *
 * **Every value it writes is namespaced `--tilt-*`, and that is load-bearing.** These land in
 * the element's inline `style`, which is part of `outerHTML`, which is what `signatureOf`
 * compares. Without a way to strip them again, a hovered tile would differ from a freshly built
 * one on *every* poll — so the dashboard would flash and re-roll its counters every twenty
 * seconds over no news at all, and it would do it only for whichever card somebody's pointer
 * happened to be resting on. `stripTiltStyles` below is the other half of that, and
 * `signatureOf` calls it. **Adding a property here means adding it to `TILT_PROPS`.**
 *
 * **Reads and writes are separated.** Every `getBoundingClientRect` happens in the first pass
 * and every style write in the second. Interleaving them makes the browser recompute layout
 * once per card per frame, which is the classic way an effect like this turns a smooth screen
 * into a stuttering one.
 */

/** How far a card under the pointer leans, in degrees. */
const MAX_TILT_DEG = 8;

/**
 * The cards this module is allowed to move — everything carrying `.tilt` except `.still`.
 *
 * ## Why an opt-out exists at all
 *
 * The dashboard's panels are cards and are no longer allowed to move (owner, 2026-08-27:
 * *"just ye tilt band kar du"*), while **the rows inside them still are** — the same sentence
 * says so twice. So "is a card" and "answers the pointer" stopped being the same question, and
 * this is the second one.
 *
 * ## Why it is a selector here and not a rule in the stylesheet
 *
 * CSS can neutralise the transform, and `index.html` does exactly that as a backstop. What CSS
 * cannot do is stop this module writing ten `--tilt-*` properties into a panel's inline
 * `style` sixty times a second, or stop it adding `.live` and `.press` to an element that
 * will never show either. Both of those are real costs on a laptop driving a television, and
 * the inline styles are the exact thing `stripTiltStyles` and `signatureOf` have to keep
 * undoing. A card that cannot move is cheapest when the pointer never considers it.
 *
 * ⚠️ **Every door has to use it, not just `cards()`.** `closest('.tilt')` from a target inside
 * a still panel would return the PANEL and make it active; `closest(MOVES)` walks past it and
 * finds the row card the pointer is actually on, or nothing. Adding a door that queries
 * `'.tilt'` bare is how a panel starts leaning again.
 */
const MOVES = '.tilt:not(.still)';

/**
 * How much a card leans when its *neighbour* is the one being pointed at, and how far that
 * reaches — in multiples of a card's own width.
 *
 * The deck reacting as a group is what stops the effect reading as five unrelated toys. It is
 * deliberately weak: at full strength the whole row moves whenever the pointer crosses it, and
 * a dashboard that is permanently in motion is one nobody can read a number off.
 */
const NEIGHBOUR_STRENGTH = 0.3;
const NEIGHBOUR_REACH = 2.4;

/** How far the pointed-at card comes towards the viewer. */
const LIFT_PX = 10;

/**
 * Where the light sits when nothing is being pointed at — top left, as a percentage of the card.
 *
 * A card with no light on it at all reads as flat, and the whole deck then looks dead until
 * somebody moves a pointer over it. On a wall screen nobody ever does.
 */
const REST_LIGHT_X = 26;
const REST_LIGHT_Y = 14;

/**
 * Every custom property this module writes.
 *
 * The single source of truth for both halves of the problem: the code that sets them, and the
 * code that has to pretend they were never set (`signatureOf`). A property that is written but
 * not listed here is a dashboard that repaints itself every poll.
 */
const TILT_PROPS = [
  '--tilt-rx',
  '--tilt-ry',
  '--tilt-z',
  '--tilt-mx',
  '--tilt-my',
  '--tilt-shade',
  '--tilt-sx',
  '--tilt-sy',
  '--tilt-cx',
  '--tilt-cy',
] as const;

/**
 * Somebody who asked not to be moved gets none of this.
 *
 * Read at the moment it matters rather than cached at mount: the setting can change while the
 * page is open, and a control room screen is open for days.
 *
 * It lives here rather than in `dashboard.ts` because this is the module the rule is about, and
 * a second copy of it is the drift this project has a standing lesson about.
 */
export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Remove every `--tilt-*` value from a subtree, in place.
 *
 * Used by `signatureOf` so that a card which happens to be under the pointer still compares
 * equal to the same card built fresh. Takes the node itself as well as its descendants,
 * because the keyed element is the one that carries most of them.
 */
export function stripTiltStyles(root: HTMLElement): void {
  const nodes: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    if (node.getAttribute('style') === null) continue;
    for (const prop of TILT_PROPS) node.style.removeProperty(prop);
    // An element whose only inline styling was ours should not be left with `style=""`, which
    // would still differ from a freshly built node that never had the attribute at all.
    if (node.style.length === 0) node.removeAttribute('style');
  }
}

/**
 * Turn any element into a card, in place. Safe to call again on the same element.
 *
 * ## Why this is a function and not markup
 *
 * ~~There are two producers of `.panel`.~~ **There were three producers of the card, and the
 * third was the one that mattered — 2026-08-23.** Fifteen static sections in `index.html` and
 * `web/src/status.ts` both went through this; `renderKeys` in `dashboard.ts` built the same six
 * elements *by hand*, in a third place, for the eight District counters. Nobody noticed because
 * the two shapes happened to agree.
 *
 * They no longer can: every panel's contents are becoming cards, so the shape is now written
 * once and every screen runs it. **A caller builds its content as ordinary children and calls
 * this.** It does not type `.stack`, `.cast`, `.side`, `.face`, `.sheen`, `.rim` or `.lift` —
 * those six names exist in exactly one place, below.
 *
 * ## Why it is additive, and why that matters more than it looks
 *
 * `.panel` keeps painting exactly as it did. The card's own rules hang off `.panel.tilt`, which
 * only exists once this has run. **So a panel this never reaches is not a broken panel** — it is
 * the panel it was yesterday. Moving what paints off `.panel` unconditionally was the obvious
 * alternative and it is how the Status screen would have lost its ground, its border and its
 * padding, silently, in a bundle nobody was looking at.
 *
 * ## What a card type owes, now that they nest
 *
 * ⚠️ A card inside a card is ordinary here — the counters sit inside the keys panel, and every
 * list row is about to sit inside its own panel. Card-internal CSS is therefore scoped with `>`,
 * and the things that differ between card types travel as **values**: `--face-ground`,
 * `--face-wash`, `--face-pad`, `--face-edge`, `--face-edge-w`. A new card type declares those on
 * itself. It must not write a rule against `.face`, and it must not rely on inheriting a
 * parent card's — custom properties inherit, so an omission is silently the panel's value.
 *
 * ## What it deliberately does not touch
 *
 * An element that opts out — `data-flat` — is left alone. Weather and Pakistan headlines carry
 * `background: none` and a dashed border because what is on them came from **outside** the
 * district, and a lit, raised surface says the opposite. They are also the only two carrying the
 * freshness hairline, which is positioned against `.panel` and would otherwise find itself
 * measuring against a new parent.
 */
export function makeCard(panel: HTMLElement): void {
  if (panel.dataset['carded'] === 'on') return;
  if (panel.dataset['flat'] !== undefined) return;
  panel.dataset['carded'] = 'on';

  const div = (className: string): HTMLElement => {
    const node = document.createElement('div');
    node.className = className;
    return node;
  };

  const lift = div('lift');
  // Everything the panel already held, moved rather than copied — the ids `dashboard.ts` and
  // `status.ts` look up are on these nodes, and `getElementById` does not care how deep they sit.
  while (panel.firstChild !== null) lift.appendChild(panel.firstChild);

  const face = div('face');
  face.appendChild(div('sheen'));
  face.appendChild(div('rim'));
  face.appendChild(lift);

  const stack = div('stack');
  stack.appendChild(div('cast'));
  stack.appendChild(div('side'));
  stack.appendChild(face);

  panel.appendChild(stack);
  panel.classList.add('tilt');
}

interface Card {
  readonly root: HTMLElement;
  readonly face: HTMLElement | null;
  readonly cast: HTMLElement | null;
  rect: DOMRect;
}

/**
 * Give a container's cards depth. Safe to call again on the same container.
 *
 * Idempotent because the dashboard re-renders on every poll and `paint()` is not the only door:
 * `show()`, the 20s timer and `/board/live`'s doorbell all end up here. Mounting twice would
 * install two listeners and every value would be written twice per frame.
 */
export function mountTilt(deck: HTMLElement): void {
  if (deck.dataset['tilt'] === 'on') return;
  deck.dataset['tilt'] = 'on';

  let pointerX = 0;
  let pointerY = 0;
  let active: HTMLElement | null = null;
  let frame: number | null = null;

  function cards(): Card[] {
    return Array.from(deck.querySelectorAll<HTMLElement>(MOVES)).map((root) => ({
      root,
      face: root.querySelector<HTMLElement>('.face'),
      cast: root.querySelector<HTMLElement>('.cast'),
      rect: root.getBoundingClientRect(),
    }));
  }

  function paint(): void {
    frame = null;

    // Pass one: read. Nothing below this line touches the DOM until every rect is in hand.
    const list = cards();

    // Pass two: write.
    for (const card of list) {
      const { root, face, cast, rect } = card;
      const isActive = root === active;

      let nx = 0;
      let ny = 0;
      let strength = 0;
      let lightX = REST_LIGHT_X;
      let lightY = REST_LIGHT_Y;

      if (isActive && rect.width > 0 && rect.height > 0) {
        lightX = ((pointerX - rect.left) / rect.width) * 100;
        lightY = ((pointerY - rect.top) / rect.height) * 100;
        nx = lightX / 100 - 0.5;
        ny = lightY / 100 - 0.5;
        strength = 1;
      } else if (active !== null && rect.width > 0) {
        // Lean towards whichever card is being pointed at, falling off with distance.
        const dx = pointerX - (rect.left + rect.width / 2);
        const dy = pointerY - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy);
        const reach = rect.width * NEIGHBOUR_REACH;
        strength = Math.max(0, 1 - distance / reach) * NEIGHBOUR_STRENGTH;
        const length = distance === 0 ? 1 : distance;
        nx = (dx / length) * 0.5;
        ny = (dy / length) * 0.5;
      }

      root.style.setProperty('--tilt-ry', `${(nx * MAX_TILT_DEG * strength).toFixed(2)}deg`);
      root.style.setProperty('--tilt-rx', `${(-ny * MAX_TILT_DEG * strength).toFixed(2)}deg`);
      root.style.setProperty('--tilt-z', `${isActive ? LIFT_PX : 0}px`);

      // The shadow a lifted element casts falls away from the light, so it has to know where
      // the light is. `1 +` keeps a little of it under the number even at rest — an element
      // that only gains a shadow on hover reads as jumping rather than lifting.
      root.style.setProperty('--tilt-sx', (-nx * 16 * strength).toFixed(2));
      root.style.setProperty('--tilt-sy', (1 - ny * 16 * strength).toFixed(2));

      if (face !== null) {
        face.style.setProperty('--tilt-mx', `${lightX.toFixed(1)}%`);
        face.style.setProperty('--tilt-my', `${lightY.toFixed(1)}%`);
        // Which way the far side of the card falls into shade. Undefined at dead centre, where
        // there is no direction to speak of — the default is the resting top-left light.
        const angle = (Math.atan2(ny * strength, nx * strength) * 180) / Math.PI + 90;
        face.style.setProperty(
          '--tilt-shade',
          `${Number.isNaN(angle) ? 158 : Math.round(angle)}deg`,
        );
      }

      if (cast !== null) {
        // The card's own shadow on the dashboard slides *opposite* the tilt. This is the cue
        // that makes the card read as an object rather than a picture that happens to rotate.
        cast.style.setProperty('--tilt-cx', `${(-nx * 26 * strength).toFixed(1)}px`);
        cast.style.setProperty('--tilt-cy', `${(5 - ny * 20 * strength).toFixed(1)}px`);
      }
    }
  }

  function request(): void {
    if (frame === null) frame = requestAnimationFrame(paint);
  }

  function setActive(next: HTMLElement | null): void {
    if (next === active) return;
    active?.classList.remove('live');
    active = next;
    active?.classList.add('live');
  }

  function rest(): void {
    setActive(null);
    deck.classList.remove('armed');
    for (const node of Array.from(deck.querySelectorAll<HTMLElement>('.tilt.press'))) {
      node.classList.remove('press');
    }
    request();
  }

  deck.addEventListener('pointermove', (event) => {
    if (reducedMotion()) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    const target = event.target;
    setActive(target instanceof Element ? target.closest<HTMLElement>(MOVES) : null);
    // `armed` shortens the transition so the card follows the pointer rather than easing after
    // it. Removed on leave, so the return to rest is the slow, settled one.
    deck.classList.add('armed');
    request();
  });

  deck.addEventListener('pointerleave', rest);

  deck.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    target.closest<HTMLElement>(MOVES)?.classList.add('press');
  });

  // On `document`, not on the deck: a pointer released outside the card it was pressed in would
  // otherwise leave that card stuck in its pressed state.
  document.addEventListener('pointerup', () => {
    for (const node of Array.from(deck.querySelectorAll<HTMLElement>('.tilt.press'))) {
      node.classList.remove('press');
    }
  });

  /**
   * Keyboard gets the same treatment, and it has to be synthesised.
   *
   * `leadsTo` makes every counter that counted something a real tab stop, so a keyboard
   * operator reaches these cards and would otherwise find them inert while a mouse user gets a
   * lit, lifted one. There is no pointer to read, so the light is placed up and to the left of
   * centre — the same place it rests.
   */
  deck.addEventListener(
    'focusin',
    (event) => {
      if (reducedMotion()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLElement>(MOVES);
      if (card === null) return;
      const rect = card.getBoundingClientRect();
      pointerX = rect.left + rect.width * 0.28;
      pointerY = rect.top + rect.height * 0.28;
      deck.classList.add('armed');
      setActive(card);
      request();
    },
    true,
  );

  deck.addEventListener(
    'focusout',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest<HTMLElement>(MOVES) === active) rest();
    },
    true,
  );

  // Rects are read fresh every frame, so a resize needs nothing more than a repaint of the
  // resting state — which matters because a card left mid-tilt when the pointer went away
  // during a resize would stay there.
  window.addEventListener('resize', request);
}
