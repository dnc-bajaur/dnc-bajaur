/**
 * "Somebody with that name is already here" — M10-35.
 *
 * Two forms add an officer: the recipient picker's, reached mid-call from the screen where the
 * gap is noticed (M9-23), and the roster's. Both should say when a name or a number is already in
 * the directory, and both must say it the same way — so the rule lives here rather than twice.
 *
 * ## ⚠️ A warning, never a refusal, and the district is the reason
 *
 * **Two officers can genuinely share one office handset** (`03000000171` in the examples),
 * confirmed in the live directory on 2026-08-16, and the reason migration 0006 moved phone
 * uniqueness off `person` in the first place (Q-19). A form that refused a duplicate number could
 * not enter the district's own roster. Names repeat too, and in a district of forty officers two
 * people with the same name is an ordinary Tuesday.
 *
 * So this answers *"is this already here?"* and nothing else. Whether that means **the same
 * person twice** or **two people who share a handset** is a question only the operator can
 * answer, and the words are written for somebody who might mean either.
 *
 * ## What it deliberately does not do
 *
 * It does not merge, deduplicate, or propose. `collapseSelection` has never deduplicated by phone
 * number and must not start: *one name three times* and *two names one number* are opposite
 * problems, and solving the first by way of the second would tell one officer and record that two
 * were told.
 */

/** Somebody already in the directory, in the least the check needs to know about them. */
export interface KnownPerson {
  readonly name: string;
  readonly phone: string | null;
}

export interface DuplicateMatch {
  /** Matched on the name, on the number, or on both. */
  readonly on: 'name' | 'phone' | 'both';
  /** Who it matched, by name, in the order the caller supplied them. */
  readonly who: readonly string[];
}

/**
 * Compare numbers by their last ten digits.
 *
 * A district types one number four ways — `0300 000 0171`, `03000000171`, `+923000000171`,
 * `92 300 000 0171` — and a check that compared the strings would call every one of them a
 * different officer, which is a warning that never fires. Ten digits is the Pakistani subscriber
 * number without the trunk `0` or the `+92`, so all four collapse onto the same key.
 *
 * Anything shorter than ten digits is treated as **no answer** rather than as a short key: a
 * half-typed number matching everything would put a warning under the form while somebody is
 * still typing, and a warning that appears before it can be true is one people learn to ignore.
 */
function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length < 10 ? null : digits.slice(-10);
}

/** Case and spacing are not a difference between two officers. */
function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Is this name or this number already in the directory?
 *
 * Returns `null` when there is nothing to say — including while the operator is still typing,
 * which is most of the time the caller will ask.
 */
export function findDuplicate(
  name: string,
  phone: string,
  known: readonly KnownPerson[],
): DuplicateMatch | null {
  const wantedName = nameKey(name);
  const wantedPhone = phoneKey(phone);

  // A single character is not a name yet. Two is: "Ai" is a plausible start and the warning is
  // only ever advice, so the cost of being early is smaller here than the cost of being late.
  const byName = wantedName.length < 2 ? [] : known.filter((p) => nameKey(p.name) === wantedName);
  const byPhone =
    wantedPhone === null ? [] : known.filter((p) => phoneKey(p.phone) === wantedPhone);

  if (byName.length === 0 && byPhone.length === 0) return null;

  const on =
    byName.length > 0 && byPhone.length > 0 ? 'both' : byName.length > 0 ? 'name' : 'phone';
  const who = [...new Set([...byName, ...byPhone].map((p) => p.name))];

  return { on, who };
}

/**
 * The sentence an operator reads, and it is written for somebody who may well mean to proceed.
 *
 * **Each case says something different, because the operator's next move differs.** The same name
 * *and* the same number is very probably the person already being looked at. The same number
 * alone is the district's own normal — two officers, one handset — and the words say so, because
 * an operator who has been told this looks like a mistake will stop and go and ask somebody.
 *
 * `scope` names where the check looked. The roster only knows its own department's people, and a
 * warning that implied it had checked the district would be worse than no warning: it would be
 * read as *"nobody else has this"*, which it cannot know.
 */
export function duplicateSentence(match: DuplicateMatch, scope: 'district' | 'department'): string {
  const names = match.who.join(', ');
  const where = scope === 'district' ? 'the directory' : 'this department';

  if (match.on === 'both') {
    return `${names} is already in ${where} with this name and this number — this may be the same person. Adding them again makes a second entry.`;
  }
  if (match.on === 'name') {
    return `${names} is already in ${where} under this name. If this is somebody else, add them — two officers can share a name.`;
  }
  return `This number is already ${names}'s. Two officers sharing one handset is normal here, so add them if that is right.`;
}
