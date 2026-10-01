/**
 * What Meta says about the district's own account — 2026-08-21.
 *
 * ## The defect, and it is the third of its exact shape in three days
 *
 * `readWebhook` reached into `change.value` for `messages` and `statuses` and **never looked at
 * `change.field`**. Read off the live app the day this was written, this district's webhook
 * subscription carries `message_template_status_update`, `message_template_quality_update`,
 * `phone_number_quality_update`, `account_update`, `account_alerts`, `account_review_update` and
 * `security` — every one `active`, pointing at Bajaur's own endpoint. So each of those arrived,
 * verified its signature, was answered 200, and was **discarded without a line in the log**.
 *
 * After the quick-reply tap (19 August) and an officer's photograph (21 August), this is the
 * third time the answer has been *Meta sends it, nothing reads it, nobody finds out*.
 *
 * ## Why it matters more than a missing feature
 *
 * `api/dashboard.ts`'s condition panel names *"a template somebody un-approved"* as one of the
 * three silent failures it exists for — and had no way to know. `Can send WhatsApp` was folded
 * from how many of **our own sends** succeeded, so a template Meta paused this morning reads as a
 * perfectly quiet night until the first send after it. That send is at 02:00.
 */

import { describe, expect, it } from 'vitest';

import { readWebhook } from '../whatsapp.js';

/** One change, in the envelope Meta actually delivers, with its `field` set. */
function change(field: string, value: unknown): unknown {
  return { entry: [{ changes: [{ field, value }] }] };
}

describe('what Meta says about the account', () => {
  /**
   * **A paused template is the case this was built for.**
   *
   * Meta pauses a template after enough recipients block or report messages on it, and a paused
   * template refuses **every** message on it — emergencies included.
   */
  it('reads a paused template, with Meta’s own word kept verbatim', () => {
    const { notices } = readWebhook(
      change('message_template_status_update', {
        message_template_id: '1000000000000002',
        message_template_name: 'district_message_v3',
        message_template_language: 'en',
        event: 'PAUSED',
        reason: 'PAIRWISE_BLOCKED',
      }),
    );

    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('template');
    expect(notices[0]?.subject).toBe('district_message_v3 (en)');
    // Verbatim, never paraphrased: this is the string somebody pastes into a Meta console.
    expect(notices[0]?.event).toBe('PAUSED');
    expect(notices[0]?.severity).toBe('critical');
    expect(notices[0]?.detail).toBe('PAIRWISE_BLOCKED');
  });

  /**
   * **The quality score is the early warning, and it is a different field from the status.**
   *
   * Yellow is the district's only chance to notice before Meta pauses the template. Folding it
   * into the status branch would have lost the one signal that arrives while there is still time
   * to do something.
   */
  it('reads a template’s quality falling, and says what it was', () => {
    const { notices } = readWebhook(
      change('message_template_quality_update', {
        message_template_name: 'district_emergency_v2',
        message_template_language: 'en',
        previous_quality_score: 'GREEN',
        new_quality_score: 'YELLOW',
      }),
    );

    expect(notices[0]?.event).toBe('YELLOW');
    expect(notices[0]?.severity).toBe('warn');
    expect(notices[0]?.detail).toBe('quality score, was GREEN');
  });

  /**
   * A flagged number carries the district's next question with it: **how many can we still reach
   * today.** Meta lowers the messaging tier when it flags a number, so the limit rides along.
   */
  it('reads a flagged number and carries the messaging limit', () => {
    const { notices } = readWebhook(
      change('phone_number_quality_update', {
        display_phone_number: '923363920520',
        event: 'FLAGGED',
        current_limit: 'TIER_250',
      }),
    );

    expect(notices[0]?.kind).toBe('number');
    expect(notices[0]?.subject).toBe('923363920520');
    expect(notices[0]?.severity).toBe('critical');
    expect(notices[0]?.detail).toBe('messaging limit TIER_250');
  });

  it('reads an account restriction', () => {
    const { notices } = readWebhook(
      change('account_update', {
        event: 'ACCOUNT_RESTRICTION',
        violation_info: { violation_type: 'BUSINESS_POLICY' },
      }),
    );

    expect(notices[0]?.kind).toBe('account');
    expect(notices[0]?.severity).toBe('critical');
    expect(notices[0]?.detail).toBe('BUSINESS_POLICY');
  });

  /** Good news is read too, so a row that went red can go green again without anybody clearing it. */
  it('reads good news as ok, so a red row can clear itself', () => {
    const approved = readWebhook(
      change('message_template_status_update', {
        message_template_name: 'district_message_v3',
        message_template_language: 'en',
        event: 'APPROVED',
      }),
    );
    const unflagged = readWebhook(
      change('phone_number_quality_update', {
        display_phone_number: '923363920520',
        event: 'UNFLAGGED',
      }),
    );

    expect(approved.notices[0]?.severity).toBe('ok');
    expect(unflagged.notices[0]?.severity).toBe('ok');
  });

  /**
   * 🔴 **An unrecognised word is `warn`, never `ok`, and this is the assertion that matters most.**
   *
   * Meta adds vocabulary without asking anybody. The costly direction of that guess is obvious: a
   * new word meaning *your account is restricted*, read as fine, is exactly the silent failure
   * this whole change exists to end. A false amber row is a question somebody asks; a false green
   * one is a district that finds out at 02:00.
   */
  it('treats a word Meta has not used before as worth a look, never as fine', () => {
    const { notices } = readWebhook(
      change('account_update', { event: 'SOME_FUTURE_STATE_NOBODY_HAS_SEEN' }),
    );

    expect(notices[0]?.severity).toBe('warn');
  });

  /**
   * **A field this district is subscribed to and does not act on produces nothing.**
   *
   * `calls` and `phone_number_name_update` are both live on the subscription. A row for either
   * would put amber on a wall over something nobody needs to do anything about, which is how a
   * district learns to ignore amber.
   */
  it('says nothing about a field it does not act on', () => {
    expect(readWebhook(change('calls', { id: 'x' })).notices).toHaveLength(0);
    expect(
      readWebhook(change('phone_number_name_update', { decision: 'APPROVED' })).notices,
    ).toHaveLength(0);
  });

  /**
   * ⚠️ **A `messages` change is untouched, and nothing else is read as one.**
   *
   * This is the half that must not move: the reply and status paths have carried this district's
   * whole WhatsApp loop since M6-21, and a change that reads `field` must leave them exactly
   * where they were.
   */
  it('leaves an ordinary messages webhook exactly as it was', () => {
    const { statuses, replies, notices } = readWebhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [{ id: 'wamid.ABC', status: 'delivered' }],
                messages: [
                  {
                    from: '923001234567',
                    timestamp: '1755700000',
                    type: 'text',
                    text: { body: 'on my way' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(statuses).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('on my way');
    expect(notices).toHaveLength(0);
  });

  /**
   * A webhook with no `field` at all is still read as messages.
   *
   * Every test written before today builds one that way, and so does Meta's own documentation
   * for the common case. Requiring the field would have quietly broken the loop this district
   * runs on.
   */
  it('still reads a change that carries no field, as it always did', () => {
    const { replies } = readWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '923001234567',
                    timestamp: '1755700000',
                    type: 'text',
                    text: { body: 'reached' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(replies).toHaveLength(1);
  });
});
