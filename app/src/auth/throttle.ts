/**
 * Slowing down guessing, without ever locking anybody out — M5's security review.
 *
 * `passwords.ts` sets a deliberately low ten-character minimum and justifies it by saying
 * *"real protection here comes from rate limiting and instant revocation"*. Revocation existed.
 * This is the other half, and it was missing.
 *
 * ## The answer this deliberately is not: an account lockout
 *
 * The district's numbers are semi-public and the roster says who holds which post. **A lockout
 * is a denial of service an attacker can aim at a named officer** — ten wrong passwords
 * against the Rescue duty officer's number at 01:50 would lock out precisely the person the
 * system exists to reach, and they would discover it at the moment it mattered. INV-01
 * outranks a failed-login counter exactly as it outranks a stale backup on `/health`.
 *
 * So nothing here ever refuses. It **delays**, and the delay is bounded. An officer who
 * mistypes their password waits milliseconds; somebody working through a wordlist waits
 * seconds per attempt, which is the difference between a feasible attack and an infeasible
 * one. A duty officer typing carefully at 02:00 is never told to come back later.
 *
 * ## What is actually being protected
 *
 * Not mainly the passwords — the **CPU**. `/auth/login` is unauthenticated and performs a
 * scrypt derivation on every attempt, *including for numbers with no account*, deliberately,
 * so that response time reveals nothing about who is real. On one machine in the DC office
 * that is also accepting emergency reports, an unauthenticated endpoint that burns a scrypt
 * per request is a cheap way to make the district stop answering. Hence `withScryptSlot`:
 * login can queue for the CPU, and intake never waits behind it.
 *
 * ## Two keys, because there are two attacks
 *
 * Per **number** catches somebody working on one officer. Per **source** catches somebody
 * spraying one password across the district's whole contact list, where no single number ever
 * accumulates enough failures to be noticed.
 *
 * ## In memory, on purpose
 *
 * ADR-0011 deploys one node; ADR-0007 says boring. A table would mean a write on every failed
 * attempt — load added exactly when the system is under load — and a restart clearing the
 * counters costs an attacker one restart's worth of delay, which is not the difference between
 * safe and unsafe. Attempts that matter are still visible: failures are counted and exposed
 * for `/health` and the console rather than kept only in here.
 */

/** Failures older than this are forgotten. A mistyped password on Monday is not evidence. */
const WINDOW_MS = 15 * 60 * 1000;

/** Free attempts before any delay at all. A person who fumbles a password notices nothing. */
const FREE_ATTEMPTS = 4;

/** Growth per failure past the free ones. */
const STEP_MS = 400;

/**
 * The longest anybody ever waits.
 *
 * Bounded because an unbounded backoff *is* a lockout wearing a different name — an officer
 * facing a four-minute delay has been locked out in every sense that matters at 02:00.
 */
const MAX_DELAY_MS = 5_000;

/** Concurrent scrypt derivations. Beyond this, login queues; intake is never behind it. */
const SCRYPT_SLOTS = 4;

/** Waiting for a slot beyond this means the box is saturated — see `withScryptSlot`. */
const SLOT_WAIT_MS = 10_000;

interface Bucket {
  failures: number;
  /** When the most recent failure landed, for expiry. */
  at: number;
}

export interface ThrottleDecision {
  /** How long to wait before answering. Never a refusal. */
  readonly delayMs: number;
  /** Failures already recorded against the more-loaded of the two keys. */
  readonly failures: number;
}

export class LoginThrottle {
  private readonly byNumber = new Map<string, Bucket>();
  private readonly bySource = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  private read(map: Map<string, Bucket>, key: string): number {
    const bucket = map.get(key);
    if (bucket === undefined) return 0;
    if (this.now() - bucket.at > WINDOW_MS) {
      map.delete(key);
      return 0;
    }
    return bucket.failures;
  }

  private bump(map: Map<string, Bucket>, key: string): void {
    const current = this.read(map, key);
    map.set(key, { failures: current + 1, at: this.now() });
  }

  /**
   * How long this attempt should be made to wait.
   *
   * Read before the password is checked, so the delay is applied to the attempt itself and
   * cannot depend on whether the account exists. **A delay that appeared only for real numbers
   * would be the timing oracle `login` already goes out of its way to avoid.**
   */
  decide(phone: string, source: string): ThrottleDecision {
    const failures = Math.max(this.read(this.byNumber, phone), this.read(this.bySource, source));
    const over = Math.max(0, failures - FREE_ATTEMPTS);
    return { delayMs: Math.min(over * STEP_MS, MAX_DELAY_MS), failures };
  }

  /** Record a failure against both keys. */
  fail(phone: string, source: string): void {
    this.bump(this.byNumber, phone);
    this.bump(this.bySource, source);
  }

  /**
   * Clear the number's history on a successful sign-in — but **not the source's**.
   *
   * Somebody spraying the district's contact list will eventually guess one weak password.
   * If that success also cleared their source, the one thing that noticed the spray would be
   * erased by the attack succeeding.
   */
  succeed(phone: string): void {
    this.byNumber.delete(phone);
  }

  /** Live counters, for `/health` and the console. Nothing here identifies a person. */
  snapshot(): { readonly numbersWithFailures: number; readonly sourcesWithFailures: number } {
    const live = (map: Map<string, Bucket>): number => {
      let n = 0;
      for (const [key] of map) if (this.read(map, key) > 0) n += 1;
      return n;
    };
    return { numbersWithFailures: live(this.byNumber), sourcesWithFailures: live(this.bySource) };
  }

  /** Drop everything expired. Called on a timer so a long spray cannot grow the maps forever. */
  sweep(): void {
    for (const map of [this.byNumber, this.bySource]) {
      for (const [key] of map) this.read(map, key);
    }
  }
}

let inFlight = 0;
const waiting: (() => void)[] = [];

/**
 * Run a password derivation, with a cap on how many happen at once.
 *
 * scrypt is deliberately expensive, which is what makes it a good password hash and a good
 * denial-of-service lever on an unauthenticated endpoint. This bounds how much of the
 * district's one CPU login can hold at any moment, so an emergency report never waits behind
 * a flood of sign-in attempts (INV-01).
 *
 * If a slot does not come free within `SLOT_WAIT_MS` the caller is told the server is busy —
 * for **login only**, and as a transient condition affecting whoever is asking right now, not
 * a state attached to anybody's account.
 */
export type SlotResult<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

export async function withScryptSlot<T>(work: () => Promise<T>): Promise<SlotResult<T>> {
  // A discriminated result rather than `T | null`, because `login` itself returns null for a
  // wrong password. Collapsing the two would make "the server is busy" and "that password is
  // wrong" the same value, and the caller would have to guess which — exactly the kind of
  // ambiguity that ends with a failed sign-in counted as an attack, or an attack counted as a
  // typo.
  if (inFlight >= SCRYPT_SLOTS) {
    const got = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SLOT_WAIT_MS);
      waiting.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!got) return { ran: false };
  }

  inFlight += 1;
  try {
    return { ran: true, value: await work() };
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

export function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

/** For tests and for `/health`. */
export function scryptLoad(): { readonly inFlight: number; readonly waiting: number } {
  return { inFlight, waiting: waiting.length };
}

/**
 * Who is actually asking, once there is a reverse proxy in front of this — M6-37, ADR-0017.
 *
 * **This is the line ADR-0011 named as "the one to change, deliberately", and it ships in the
 * same release as the proxy or the second one is an outage.**
 *
 * The rule it replaces was right: `X-Forwarded-For` is written by whoever is asking, so
 * trusting it lets an attacker send a different value on every request and never accumulate a
 * single failure — a rate limiter an attacker can opt out of is worse than none, because it is
 * believed. That is why the socket address was the only source.
 *
 * Behind a proxy the same rule inverts. Every request arrives from `127.0.0.1`, so the entire
 * district shares one throttle key and **one officer mistyping a password would slow sign-in
 * for everybody** — including the duty officer trying to get in at 02:00. INV-01 outranks a
 * throttle counter exactly as it outranks a stale backup.
 *
 * So: the socket address, unless the socket address is a proxy this district explicitly pinned,
 * in which case the last hop that proxy recorded. Three properties hold, and each closes a way
 * this is usually got wrong:
 *
 *   * **Empty trust list means the header is ignored entirely**, which is the default and is
 *     what every existing deployment keeps. Turning this on is a configuration act.
 *   * **The address is checked against the pinned list before the header is read at all.** A
 *     check that reads the header first and validates afterwards has already branched on
 *     attacker-controlled data.
 *   * **The last entry is taken, not the first.** `X-Forwarded-For` is appended to by each hop,
 *     so the first entry is whatever the *client* claimed and the last is what our own proxy
 *     observed. Taking the first is the classic spoof, and it is the one that looks correct.
 */
export function sourceAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: readonly string[],
): string {
  const socket = normaliseAddress(socketAddress ?? 'unknown');

  if (trustedProxies.length === 0) return socket;
  if (!trustedProxies.map(normaliseAddress).includes(socket)) return socket;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (typeof header !== 'string' || header.trim() === '') {
    // The proxy is trusted and said nothing. Fall back to the proxy itself rather than to a
    // guess: everybody sharing one key is bad, and a key an attacker chooses is worse.
    return socket;
  }

  const hops = header
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');

  const last = hops[hops.length - 1];
  return last === undefined ? socket : normaliseAddress(last);
}

/**
 * `::ffff:127.0.0.1` and `127.0.0.1` are the same machine.
 *
 * Node reports an IPv4 connection on a dual-stack socket in the mapped form, so a proxy pinned
 * as `127.0.0.1` would never match and the header would be silently ignored — the failure mode
 * being *the whole district shares one throttle key*, quietly, with nothing on any screen.
 */
function normaliseAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}
