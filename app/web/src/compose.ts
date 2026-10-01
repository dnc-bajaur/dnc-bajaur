/**
 * The compose form's kind-specific boxes — M9-08. **Lazy, and out of the shell.**
 *
 * ## Why this is not in `main.ts`
 *
 * It was, for about twenty minutes, and the M1 gate caught it: the shell went from 158 KB to
 * 162 KB against a 160 KB budget. That budget's own comment says *"a budget that fails on a file
 * nobody downloads teaches everybody to raise the budget"* — so the answer was not to raise it.
 *
 * A field officer at a road accident **never sends a meeting invitation**. The whole `#whatBlock`
 * is revealed only for an administrative seat (`paintIdentity`), which is control-room work, and
 * control-room work leaves the shell — the same decision and the same reason as M7-26 taking the
 * recipient picker out into `dispatch.js`. The officer in Mamund on one bar of signal downloads
 * none of this.
 *
 * ## What it is careful about
 *
 * **The field list is imported from `domain/communications.ts`, never restated here.** The server
 * builds the WhatsApp message from that same module, so a box drawn on this form is by
 * construction a box the message knows how to read. Two lists drifting apart is exactly the
 * defect M9-12 is about: an operator typed into `#detail`, nothing downstream read it, and the
 * alert went out saying *"no details were entered"*.
 */

import { fieldsFor, labelFor, requiredFieldsFor } from '../../src/domain/communications.js';
import type { MessageKind } from '../../src/domain/events.js';

const FIELD_LABELS: Record<string, string> = {
  subject: 'Subject',
  date: 'Date',
  time: 'Time',
  venue: 'Venue',
  untilDate: 'Until',
  // The district's five, 2026-08-22 — their own "kab tak?". Deliberately the same word as
  // `untilDate`: an operator is answering one question, and two labels for it would read as two.
  reviewBy: 'Until',
  note: 'Details',
};

/**
 * `date` and `time` get native pickers.
 *
 * They produce `YYYY-MM-DD` and `HH:MM`, which is exactly what the payload carries — the
 * district's own calendar and clock, with nothing parsed into an instant on the way. A native
 * picker also means no locale ambiguity about whether `08-09` is August or September, which on a
 * meeting notice is a month-long mistake.
 */
const FIELD_TYPES: Record<string, string> = {
  date: 'date',
  untilDate: 'date',
  /**
   * A native picker, for `date`'s own reasons — and one thing it deliberately cannot express.
   *
   * *Until further notice* (`carrying.ts`'s `UNTIL_FURTHER_NOTICE`) has no place on a date
   * input, and it is not put on this form as a second control: leaving the box empty gives the
   * kind's default review window, which **flags** the row and never hides or closes it, so an
   * operator loses nothing they cannot answer later. The place to say *no end date* is the
   * panel, on a live row, where somebody is looking at the thing they are deciding about.
   */
  reviewBy: 'date',
  time: 'time',
};

export interface ComposeFields {
  /** Redraw for the currently selected kind. */
  repaint(): void;
  /** What the operator filled in. Empty fields omitted, never sent blank. */
  read(): Record<string, string>;
  /** True when this kind needs a field the operator has not filled. */
  missingRequired(): boolean;
  /** The file the operator chose, if any — M9-15. */
  file(): File | null;
  /**
   * Send the chosen file for an incident that has just been reported — M9-15.
   *
   * Lives here rather than in `main.ts` for the same reason the rest of this module does: the
   * M1 gate. Putting it in the shell took it to 160 KB of a 160 KB budget on a file a field
   * officer downloads and never uses.
   */
  send(incidentId: string): Promise<void>;
  /**
   * Resolves once any upload started by `send` has finished, one way or the other — 2026-08-14.
   *
   * **This exists because of a race the district walked into.** `send` is deliberately not
   * awaited by the submit handler (INV-01: the report must be safe before a byte of the file
   * moves), and the recipient picker opens in the same breath. So an operator who ticks two
   * departments and presses *Tell them* within a few seconds dispatches **before the file has
   * arrived** — `jobs/whatsappChannel.ts` asks the database for attachments at send time, finds
   * none, and forty officers get a message with no link on it. Nothing anywhere reports a fault:
   * the report is fine, the upload succeeds a moment later, and the file is simply not in the
   * message that already went.
   *
   * Resolving rather than rejecting on failure is the point. A file that could not be sent must
   * still not stop the district telling anybody — the picker says what happened and the message
   * goes.
   */
  settled(): Promise<void>;
}

/**
 * What a communication may carry — M9-16, and it must match the server's `COMMUNICATION_TYPES`.
 *
 * The `accept` attribute is a **convenience, never a control**: it filters the file picker on
 * most platforms and is trivially bypassed, which is fine because the server reads the file's
 * magic number and refuses anything else (M9-14). Stated here so nobody later mistakes this
 * line for the check.
 */
const ACCEPT = '.pdf,.jpg,.jpeg,application/pdf,image/jpeg';

export function mountComposeFields(
  block: HTMLElement,
  kindSelect: HTMLSelectElement,
  submit: HTMLButtonElement,
  /** Ask the outbox to deliver what is queued. The upload waits on it. */
  sync: () => Promise<void>,
): ComposeFields {
  /**
   * The chosen file, held here rather than read from the input on demand.
   *
   * A `<input type="file">` cannot have its value set programmatically — the browser forbids
   * it, correctly — so a repaint would otherwise lose whatever the operator picked the moment
   * they changed the kind.
   */
  let chosen: File | null = null;

  /**
   * The upload currently in flight, or null. Read by `settled()`; see its comment for the race.
   *
   * Held as the promise itself rather than as a boolean, so a caller waits for *this* upload and
   * not for a flag somebody forgot to clear.
   */
  let inFlight: Promise<void> | null = null;

  function read(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const input of Array.from(block.querySelectorAll<HTMLInputElement>('[data-field]'))) {
      const value = input.value.trim();
      if (value !== '') out[input.dataset['field'] ?? ''] = value;
    }
    return out;
  }

  function repaint(): void {
    const kind = kindSelect.value as MessageKind;
    const fields = fieldsFor(kind);
    const required = requiredFieldsFor(kind);

    /**
     * Keep what the operator has already typed, keyed by field rather than by position.
     *
     * Switching Meeting to Schedule keeps the subject they wrote. Rebuilding from scratch and
     * losing it would teach an operator not to touch the dropdown — and then they would send
     * the wrong kind rather than lose a sentence.
     */
    const existing = read();
    // Held across a repaint, because a `<input type="file">` cannot have its value restored by
    // assignment — the browser forbids it, correctly. So the chosen file lives here and the
    // input is only ever read from.
    const heldFile = chosen;

    block.replaceChildren();
    // Never hidden any more: even an emergency, which asks for no structured fields, offers an
    // attachment (M9-15 — the client asked for both emergencies and General communications).
    block.hidden = false;

    for (const field of fields) {
      const label = document.createElement('label');
      label.className = 'text';
      label.htmlFor = `detail_${field}`;
      label.textContent = required.includes(field)
        ? FIELD_LABELS[field]!
        : `${FIELD_LABELS[field]!} (optional)`;

      // `note` is the one that wants room. Everything else is a line.
      const input =
        field === 'note'
          ? Object.assign(document.createElement('textarea'), { rows: 2 })
          : Object.assign(document.createElement('input'), { type: FIELD_TYPES[field] ?? 'text' });

      input.id = `detail_${field}`;
      input.dataset['field'] = field;
      input.value = existing[field] ?? '';

      block.append(label, input);
    }

    /**
     * The button says what it will actually do.
     *
     * A button reading "Report emergency" that sends a meeting invitation is the same category
     * of lie as a box that reaches nothing — and this one sits on the critical path, where an
     * operator reads the button rather than the dropdown above it.
     */
    submit.textContent = kind === 'emergency' ? 'Report emergency' : `Send ${labelFor(kind)}`;

    /**
     * The attachment row — M9-15. **Below the fields, above nothing.**
     *
     * Offered on every kind, because the client asked for attachments on emergencies as well as
     * on General communications, and a photograph of a scene is the case where it helps most.
     *
     * **It never blocks the button.** Choosing a file is optional on every kind, and an
     * emergency is still two taps and a button (M0-36) — an operator who ignores this row
     * entirely loses nothing. INV-01 all the way down: the report is never refused for a file.
     */
    const label = document.createElement('label');
    label.className = 'text';
    label.htmlFor = 'attachFile';
    label.textContent = 'Attach a PDF or photo (optional)';

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'attachFile';
    input.accept = ACCEPT;

    /**
     * What will actually happen to the file — M10-32.
     *
     * An operator attaching a photograph and one attaching a PDF get **different journeys**, and
     * until now the screen said nothing about either. A JPG can ride the message itself, on the
     * template approved to carry a picture; a PDF has no such template — by the owner's choice,
     * images only — so it travels as a single-use link in the words.
     *
     * Said before the file is chosen rather than after, because it changes which file somebody
     * picks. A district that wants the picture *in* the message can photograph the notice instead
     * of scanning it, and that is a decision they can only make if they know.
     *
     * ⚠️ **It does not promise the picture will ride.** That depends on the image template being
     * approved, which is Meta's timing and not something this screen can know — so the wording is
     * about the two kinds of file, which is true either way. Overstating it would be a screen
     * teaching a feature that is switched off, which this project has a standing lesson about.
     */
    const journey = document.createElement('p');
    journey.className = 'meta';
    journey.textContent = 'A photo can ride the message. A PDF travels as a link.';

    const chosenName = document.createElement('p');
    chosenName.className = 'meta';
    chosenName.id = 'attachChosen';

    function showChosen(): void {
      chosenName.textContent =
        chosen === null
          ? ''
          : // The size is shown because the server's 20 MB refusal is otherwise discovered
            // after the upload, on a district connection, having waited for it.
            `${chosen.name} · ${Math.max(1, Math.round(chosen.size / 1024))} KB`;
    }

    input.addEventListener('change', () => {
      chosen = input.files?.[0] ?? null;
      showChosen();
    });

    chosen = heldFile;
    showChosen();

    block.append(label, journey, input, chosenName);
  }

  function note(text: string): void {
    const shown = block.querySelector('#attachChosen');
    if (shown !== null) shown.textContent = text;
  }

  /**
   * Send the chosen file, once the incident it belongs to exists on the server — M9-15.
   *
   * **The report is durable before a byte of this moves.** `main.ts` enqueues the report and
   * then calls this without awaiting it, so an upload that fails, times out, or is interrupted
   * by somebody closing the laptop cannot cost the district the emergency. The file is the
   * enrichment; the record is the point (INV-01).
   *
   * **It syncs first**, because evidence hangs off an incident and the incident only exists
   * server-side once the outbox has delivered the `reported` event.
   *
   * **The file is kept unless the upload actually succeeded.** A failed one leaves it in the
   * picker with a sentence saying why, so the operator can try again — rather than silently
   * discarding the thing they attached and letting them find out weeks later.
   *
   * Raw body, not multipart, matching `evidenceRoutes.ts`. Nothing here throws into the submit
   * path: an attachment that could not be sent is a message without a file, and a submit handler
   * that threw would be an emergency without a record.
   */
  async function send(incidentId: string): Promise<void> {
    const file = chosen;
    if (file === null) return;

    const run = upload(incidentId, file);
    inFlight = run;
    try {
      await run;
    } finally {
      // Only if nothing newer has started. Two uploads cannot overlap today — the picker is the
      // only door and it holds one file — but clearing unconditionally is how that stops being
      // true silently.
      if (inFlight === run) inFlight = null;
    }
  }

  async function upload(incidentId: string, file: File): Promise<void> {
    try {
      await sync();

      const res = await fetch(`/incidents/${incidentId}/evidence`, {
        method: 'POST',
        headers: {
          'content-type': file.type === '' ? 'application/octet-stream' : file.type,
          'x-filename': encodeURIComponent(file.name),
        },
        body: file,
      });

      if (res.ok) {
        chosen = null;
        const input = block.querySelector<HTMLInputElement>('#attachFile');
        if (input !== null) input.value = '';
        note('Attached.');
        return;
      }

      /**
       * The server's own words, not a paraphrase.
       *
       * The three refusals an operator will actually hit — the wrong kind of file, one over
       * 20 MB, and a file whose content does not match what it claims — each need a different
       * action, and the server already words them for a human. A generic "upload failed" sends
       * them to the control room to ask which it was.
       */
      const said = (await res.json().catch(() => null)) as { error?: string } | null;
      note(said?.error ?? `The file was not accepted (${String(res.status)}).`);
    } catch {
      // Offline, or the line dropped mid-upload. The file is still held.
      note('The file has not been sent yet — try again when there is a connection.');
    }
  }

  function missingRequired(): boolean {
    const filled = read();
    return requiredFieldsFor(kindSelect.value as MessageKind).some(
      (field) => (filled[field] ?? '') === '',
    );
  }

  kindSelect.addEventListener('change', repaint);
  repaint();

  return {
    repaint,
    read,
    missingRequired,
    file: () => chosen,
    send,
    settled: async () => {
      await inFlight;
    },
  };
}
