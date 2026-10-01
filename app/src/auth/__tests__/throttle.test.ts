/**
 * Slowing down guessing — M5's security review.
 *
 * The property under test is not "does it slow an attacker down". It is **that it never stops
 * anybody signing in**, because the obvious implementation of this feature — an account
 * lockout — is a denial of service an attacker can aim at a named duty officer, and the
 * district's numbers are semi-public. Ten wrong passwords against Rescue's duty officer at
 * 01:50 must not be able to lock out the person the system exists to reach.
 *
 * Every test below that asserts a *bound* is guarding that, not performance.
 */

import { describe, expect, it } from 'vitest';
import { LoginThrottle, sourceAddress, withScryptSlot, sleep } from '../throttle.js';

const PHONE = '+923001234567';
const SOURCE = '10.0.0.9';

/** A clock the test moves, so nothing here waits on real time. */
function at(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('the login throttle', () => {
  describe('what it must never do', () => {
    /**
     * The whole reason this is a delay and not a lockout.
     *
     * An officer who has been targeted — or who simply cannot remember a password at 02:00 —
     * still gets an answer, every time, for ever. There is no attempt count that turns into a
     * refusal, because there is no number of wrong guesses that should stop a duty officer
     * reaching the system during an emergency. INV-01 outranks a failed-login counter.
     */
    it('never refuses, however many failures pile up', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 500; i += 1) throttle.fail(PHONE, SOURCE);

      const decision = throttle.decide(PHONE, SOURCE);

      // A delay, not a door closing. There is no "refused" to assert because the type has
      // no such state — which is the design, not an omission.
      expect(decision.delayMs).toBeGreaterThan(0);
      expect(Number.isFinite(decision.delayMs)).toBe(true);
    });

    /**
     * An unbounded backoff *is* a lockout wearing a different name.
     *
     * An officer facing a four-minute delay has been locked out in every sense that matters at
     * 02:00. The cap is what keeps this a nuisance to an attacker and not a barrier to a
     * person.
     */
    it('caps the delay, so a targeted officer is never waiting minutes', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 10_000; i += 1) throttle.fail(PHONE, SOURCE);

      expect(throttle.decide(PHONE, SOURCE).delayMs).toBeLessThanOrEqual(5_000);
    });

    it('lets an honest fumble through with no delay at all', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      // Caps lock on, then the wrong one of two passwords, then a typo. Nobody notices this.
      throttle.fail(PHONE, SOURCE);
      throttle.fail(PHONE, SOURCE);
      throttle.fail(PHONE, SOURCE);

      expect(throttle.decide(PHONE, SOURCE).delayMs).toBe(0);
    });
  });

  describe('what it does do', () => {
    it('makes each further guess cost more than the last', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 8; i += 1) throttle.fail(PHONE, SOURCE);
      const early = throttle.decide(PHONE, SOURCE).delayMs;

      for (let i = 0; i < 5; i += 1) throttle.fail(PHONE, SOURCE);
      const later = throttle.decide(PHONE, SOURCE).delayMs;

      expect(early).toBeGreaterThan(0);
      expect(later).toBeGreaterThan(early);
    });

    /**
     * The second attack, which a per-number counter alone would miss entirely.
     *
     * One password tried against all 79 offices leaves no single number with enough failures
     * to notice. The source is what sees it.
     */
    it('notices one password sprayed across many different numbers', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(`+9230000000${i}`, SOURCE);

      // A number never seen before, from that source, is already slowed.
      expect(throttle.decide('+923009999999', SOURCE).delayMs).toBeGreaterThan(0);
      // ...and the same fresh number from somewhere else is not.
      expect(throttle.decide('+923009999999', '10.0.0.250').delayMs).toBe(0);
    });

    it('forgets failures once the window has passed', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(PHONE, SOURCE);
      expect(throttle.decide(PHONE, SOURCE).delayMs).toBeGreaterThan(0);

      clock.advance(16 * 60 * 1000);

      // A mistyped password twenty minutes ago is not evidence of anything.
      expect(throttle.decide(PHONE, SOURCE).delayMs).toBe(0);
    });

    it('clears the number on a successful sign-in', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(PHONE, SOURCE);
      throttle.succeed(PHONE);

      expect(throttle.decide(PHONE, '10.0.0.77').delayMs).toBe(0);
    });

    /**
     * Success must not launder the source.
     *
     * Somebody spraying the district's list will eventually guess one weak password. If that
     * success also cleared their source, the single thing that had noticed the spray would be
     * erased by the attack working.
     */
    it('does not clear the source when one guess finally lands', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(`+9230000000${i}`, SOURCE);
      throttle.succeed('+92300000005');

      expect(throttle.decide('+923007777777', SOURCE).delayMs).toBeGreaterThan(0);
    });
  });

  describe('what it reveals', () => {
    /**
     * The delay is decided before the password is checked and without asking whether the
     * account exists, so it cannot become the timing oracle `login` already avoids by hashing
     * even for numbers that do not exist.
     */
    it('treats a number with no account exactly like one with an account', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      // The throttle is never told which is which — it has no way to be.
      expect(throttle.decide('+920000000000', SOURCE)).toEqual(
        throttle.decide('+923001111111', SOURCE),
      );
    });

    it('counts without naming anybody', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);
      throttle.fail(PHONE, SOURCE);

      const snapshot = throttle.snapshot();

      expect(snapshot.numbersWithFailures).toBe(1);
      expect(JSON.stringify(snapshot)).not.toContain(PHONE);
      expect(JSON.stringify(snapshot)).not.toContain(SOURCE);
    });
  });

  describe('the scrypt slot', () => {
    /**
     * `login` returns null for a wrong password, and the slot returns "did not run" when the
     * box is saturated. Collapsing those into one value would make "your password is wrong"
     * and "the server is busy" indistinguishable to the caller.
     */
    it('distinguishes not running from running and returning null', async () => {
      const ran = await withScryptSlot(async () => null);

      expect(ran.ran).toBe(true);
      if (ran.ran) expect(ran.value).toBeNull();
    });

    it('runs work and hands back its value', async () => {
      const result = await withScryptSlot(async () => {
        await sleep(1);
        return 'derived';
      });

      expect(result).toEqual({ ran: true, value: 'derived' });
    });

    it('releases its slot even when the work throws', async () => {
      await expect(
        withScryptSlot(() => Promise.reject(new Error('scrypt exploded'))),
      ).rejects.toThrow('scrypt exploded');

      // If the slot leaked, this would eventually block rather than answer.
      expect(await withScryptSlot(async () => 'fine')).toEqual({ ran: true, value: 'fine' });
    });
  });
});

/**
 * Who the throttle thinks is asking, once there is a proxy in front — M6-37, ADR-0017.
 *
 * **The line ADR-0011 named as "the one to change, deliberately"**, and these tests pin both
 * halves of why it is dangerous in both directions:
 *
 *   * Trusting the header unconditionally is a rate limiter an attacker opts out of by sending
 *     a different value every request — worse than none, because it is believed.
 *   * Ignoring it behind a proxy means every request arrives from `127.0.0.1`, the whole
 *     district shares one throttle key, and **one officer mistyping a password slows sign-in
 *     for everybody** — including whoever is trying to get in at 02:00.
 */
describe('the source address behind a reverse proxy (M6-37)', () => {
  it('ignores the header entirely when no proxy is pinned', () => {
    // The default, and the behaviour every existing deployment keeps. Turning this on is a
    // deliberate configuration act taken in the same release as the proxy.
    expect(sourceAddress('203.0.113.9', '198.51.100.1', [])).toBe('203.0.113.9');
  });

  it('ignores the header from an address that is not the pinned proxy', () => {
    // An attacker reaching the node directly cannot choose their own throttle key by adding a
    // header — which is exactly what makes the trusted case safe.
    expect(sourceAddress('203.0.113.9', '198.51.100.1', ['127.0.0.1'])).toBe('203.0.113.9');
  });

  it('believes the proxy, and takes the LAST hop', () => {
    /**
     * The classic spoof, and the one that looks correct. `X-Forwarded-For` is appended to by
     * each hop, so the **first** entry is whatever the client claimed and the last is what our
     * own proxy observed. Taking the first would let a caller prepend any address they like.
     */
    expect(sourceAddress('127.0.0.1', 'i-am-whoever-i-say, 198.51.100.1', ['127.0.0.1'])).toBe(
      '198.51.100.1',
    );
  });

  it('treats a mapped IPv4 address as the same machine', () => {
    /**
     * Node reports an IPv4 connection on a dual-stack socket as `::ffff:127.0.0.1`, so a proxy
     * pinned as `127.0.0.1` would never match. The failure mode is silent and is the bad one:
     * the header is ignored, the whole district shares one throttle key, and nothing on any
     * screen says so.
     */
    expect(sourceAddress('::ffff:127.0.0.1', '198.51.100.1', ['127.0.0.1'])).toBe('198.51.100.1');
  });

  it('falls back to the proxy when a trusted proxy sends no header', () => {
    // Everybody sharing one key is bad; a key an attacker chooses is worse. Neither happens
    // here — the proxy's own address is at least a real observation.
    expect(sourceAddress('127.0.0.1', undefined, ['127.0.0.1'])).toBe('127.0.0.1');
    expect(sourceAddress('127.0.0.1', '   ', ['127.0.0.1'])).toBe('127.0.0.1');
  });

  it('gives two officers behind the proxy two different throttle keys', () => {
    // The whole point, and what closes the outage ADR-0017 would otherwise ship: without this,
    // both of these are `127.0.0.1` and one officer's typo delays the other.
    const a = sourceAddress('127.0.0.1', '198.51.100.1', ['127.0.0.1']);
    const b = sourceAddress('127.0.0.1', '198.51.100.2', ['127.0.0.1']);

    expect(a).not.toBe(b);
  });
});
