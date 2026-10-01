/**
 * What this installation shows, and what it keeps but hides — ADR-0016, M6-42…M6-45.
 *
 * ## The decision, in one sentence
 *
 * **The control room is the product; every other screen is hidden behind a capability, and
 * nothing is deleted.**
 *
 * The district's first priority is their control room, and a product that opens on nine screens
 * they did not ask for is a product they have to be taught before it helps them. So the screens
 * that are not the control room's start hidden.
 *
 * ## Why hidden and not removed, and why that is not cowardice
 *
 * Migration 0018 is the precedent, and it is recent enough to still sting: the provider ladder
 * was dropped for excellent reasons on 2026-08-03, and ADR-0014 rebuilt a version of it
 * forty-eight hours later. Scope moved. It will move again.
 *
 * The offline substrate is the sharp case. `spine.e2e.test.ts` **is** INV-01's proof — an
 * emergency captured on a handset with the network genuinely cut, delivering itself on
 * reconnect. Removing the outbox would not make that gate *fail*; it would make it
 * **disappear**, and the suite would go green having stopped measuring the one claim this
 * project exists to make. **A test suite that shrinks when scope narrows was measuring scope,
 * not correctness** — which is why M6-45 keeps every hidden screen in `npm run check` and in CI.
 *
 * ## What this file is not
 *
 * It is not an authority model. A capability decides whether a screen is *offered*; it decides
 * nothing about what a caller may *do*. Every endpoint behind every one of these still asks the
 * policy table, and turning a capability off is not a way to secure anything (INV-05). Two
 * separate mechanisms, and conflating them would mean an administrator believing they had
 * revoked access by tidying a menu.
 */

export type Capability =
  /** Rapid intake on a handset, at a scene. The field officer's screen (M0-36). */
  | 'field_intake'
  /**
   * ~~A department's own board and roster — "My department".~~ **Removed 2026-08-06**, with
   * the screen it gated (ADR-0018, and the owner: *"department ko main delete hi karna chah
   * raha hoon"*).
   *
   * Left named here, struck through, because **a district's stored capability set may still
   * carry the key** — `parseCapabilities` drops anything it does not recognise, so an old row
   * resolves cleanly, but somebody reading a `config_event` from July needs to know what this
   * word meant.
   */
  // | 'department_workspace'
  /**
   * ~~The shift screen: what one post is holding right now (M1).~~
   *
   * **Retired 2026-08-22 — O-44, the owner's decision**, with the screen it gated. ADR-0024 left
   * it a window a department officer could look through and touch nothing, and read off the
   * district's own database that day it had never had a user: **one account exists in Bajaur**,
   * `AC HQ Bajaur`, the control room.
   *
   * Left named here, struck through, for the same reason `department_workspace` above is: **a
   * district's stored capability set may still carry the key.** `parseCapabilities` drops
   * anything it does not recognise, so an old row resolves cleanly — but somebody reading a
   * `config_event` from August needs to know what this word meant.
   */
  // | 'shift'
  /** Photographs and files attached to an incident (M1-05). */
  | 'evidence'
  /** Vehicles, teams and equipment — what can be sent (M1-02). */
  | 'fleet'
  /** Full-history search across the record (capability group 9). */
  | 'search';

export interface CapabilityDefinition {
  readonly id: Capability;
  /** What an administrator sees. Never the flag name. */
  readonly name: string;
  /** What turning it off actually costs, in one sentence somebody can weigh. */
  readonly what: string;
  /**
   * Whether a district that has never chosen sees it.
   *
   * **Off for everything the control room does not need**, which is ADR-0016's whole point —
   * but every one of these is a working screen with tests, and the district turns any of them
   * on from the console in a second.
   */
  readonly onByDefault: boolean;
}

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: 'field_intake',
    name: 'Reporting from a handset',
    what:
      'An officer at a scene reports on their own phone, offline if need be. The control room ' +
      'does not need it — they take telephone calls — but a district that turns it off loses ' +
      'the offline path entirely.',
    onByDefault: false,
  },
  {
    id: 'evidence',
    name: 'Photographs and files',
    what: 'Attaching evidence to an incident, and downloading it afterwards.',
    onByDefault: false,
  },
  {
    id: 'fleet',
    name: 'Vehicles and teams',
    what: 'What the district can send, and what is already out.',
    onByDefault: false,
  },
  {
    id: 'search',
    name: 'Searching the record',
    what:
      'Finding what happened during last year’s floods. Off by default only because the ' +
      'control room’s own loop does not use it; it is the cheapest one to turn on.',
    onByDefault: false,
  },
];

export type CapabilityState = Readonly<Record<Capability, boolean>>;

/** What an installation shows before anybody has decided — ADR-0016. */
export function defaultCapabilities(): CapabilityState {
  const state: Partial<Record<Capability, boolean>> = {};
  for (const c of CAPABILITIES) state[c.id] = c.onByDefault;
  return state as CapabilityState;
}

/**
 * Read a stored set, refusing to trust it.
 *
 * An unknown key is dropped and a missing one takes its default, so a flag added in a later
 * release does not need a migration to have a value — and a flag *removed* in a later release
 * does not leave a stored row that resolves to nothing. Neither case may throw: the capability
 * set is read on the way to every screen, and a district whose console cannot render because a
 * configuration row was malformed has lost more than a menu.
 */
export function parseCapabilities(value: unknown): CapabilityState {
  const state = { ...defaultCapabilities() } as Record<Capability, boolean>;
  if (typeof value !== 'object' || value === null) return state;

  for (const definition of CAPABILITIES) {
    const stored = (value as Record<string, unknown>)[definition.id];
    if (typeof stored === 'boolean') state[definition.id] = stored;
  }

  return state;
}

/**
 * Is this screen offered?
 *
 * Deliberately a plain lookup with no fallback cleverness. Somebody reading this to work out
 * why a screen is missing should find one line, not a resolution order.
 */
export function isOffered(state: CapabilityState, capability: Capability): boolean {
  return state[capability];
}
