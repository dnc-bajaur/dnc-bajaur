/**
 * `npm run submit:template` — put a NEW template in front of Meta, and never touch a live one.
 *
 * ## Why this exists as a tool rather than as a paragraph
 *
 * Every template this district sends on was typed into WhatsApp Manager by hand from
 * `docs/whatsapp-template.md`. That worked, and it produced the one defect nobody caught for four
 * days: `district_message_v2` said `Acknowledged` and `district_message_img` said `Acknowledge`,
 * because two humans typed the same wording twice (O-26). A template is a **contract with
 * somebody else's approval queue** — it cannot be edited afterwards without risking the district's
 * ability to send at all — so the one moment it can be got right is before submission.
 *
 * This posts the shape the software actually sends: the body from `ALERT_TEMPLATE_TEXT`, the
 * parameters counted against `TemplateShape.body`, the buttons in `TemplateShape`'s order, and the
 * URL built by `ackBase(PUBLIC_ORIGIN)`. What Meta approves and what `sendWhatsApp` builds come
 * from one source, so they cannot be typed differently.
 *
 * ## 🔴 What it will not do, by construction
 *
 * **It only ever creates.** There is no PUT and no DELETE in this file. Meta's edit endpoint
 * returns an approved template to `PENDING`, and whether they keep serving the previous version
 * during that review is not something this project knows — so an edit risks a district that cannot
 * send at all, for minutes to days, at 02:00.
 *
 * **It refuses a name that already exists**, in any status, approved or pending or rejected. That
 * is the guard that makes the paragraph above true rather than merely intended.
 *
 * **It refuses a name this installation is currently sending on**, read from `.env`. Belt and
 * braces: the check above already covers it, and this one says *why* in a sentence a district can
 * act on rather than reporting a name collision.
 *
 * **It changes nothing locally.** No `.env` is written. An approved template starts being used
 * when a person points `WHATSAPP_TEMPLATE_IMAGE` at it and not before — the owner's instruction of
 * 2026-08-25: *"jub template approve ho jaega tou phir hum laga denge"*.
 *
 * ## Usage
 *
 *   npm run submit:template -- --name district_message_img_v3            # shows, sends nothing
 *   npm run submit:template -- --name district_message_img_v3 --confirm  # submits
 *
 * Without `--confirm` it prints the exact JSON it would post and exits. This is not a
 * confirmation prompt for its own sake: what goes to Meta is unrecallable and unreviewable
 * afterwards, and the wording is the district's to approve (M6-26).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ALERT_TEMPLATE,
  ALERT_TEMPLATE_IMAGE,
  ALERT_TEMPLATE_IMAGE_V3,
  ALERT_TEMPLATE_TEXT,
  EMERGENCY_TEMPLATE,
  LOGIN_LINK_TEMPLATE,
  NOTICE_TEMPLATE,
  NOTICE_TEMPLATE_IMAGE,
  RESPONSE_TEMPLATES,
  RESPONSE_IMAGE_TEMPLATES,
} from '../dist/ops/whatsappTemplate.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The approved button's prefix for this installation: the shape's `{PUBLIC_ORIGIN}` filled in. */
function urlBase(shape, origin) {
  return shape.urlButton.base.replace('{PUBLIC_ORIGIN}', origin.replace(/\/+$/, ''));
}
const appRoot = join(here, '..');

const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[31m';
const DIM = '[2m';
const OFF = '[0m';

/**
 * Every shape this source knows how to submit, by the name Meta would know it as.
 *
 * ⚠️ **A name that is not in this list is refused rather than guessed at.** The whole value of
 * this tool over WhatsApp Manager is that the submitted wording is the wording the software
 * sends; a free-text name would let somebody submit `district_message_v4` built from `_v3`'s
 * shape, which is the O-26 defect with a nicer interface.
 */
const SUBMITTABLE = [
  ALERT_TEMPLATE,
  ALERT_TEMPLATE_IMAGE,
  ALERT_TEMPLATE_IMAGE_V3,
  NOTICE_TEMPLATE,
  NOTICE_TEMPLATE_IMAGE,
  EMERGENCY_TEMPLATE,
  LOGIN_LINK_TEMPLATE,
  ...RESPONSE_TEMPLATES,
  ...RESPONSE_IMAGE_TEMPLATES,
];

const set = (v) => typeof v === 'string' && v.trim() !== '';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function die(what, fix) {
  console.log('');
  console.log(`${RED}${what}${OFF}`);
  if (fix !== undefined) console.log(`${DIM}${fix}${OFF}`);
  console.log('');
  process.exit(1);
}

/** Read `app/.env` exactly as `doctor.mjs` does — the same few lines, for the same reason. */
async function readEnv() {
  const env = { ...process.env };
  try {
    const text = await readFile(join(appRoot, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    die('app/.env could not be read.', 'Run this on the machine the district actually sends from.');
  }
  return env;
}

async function reach(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build the `components` array Meta's form would have produced.
 *
 * **The body text is `ALERT_TEMPLATE_TEXT` and is not assembled here**, because that constant is
 * what a human pastes into WhatsApp Manager and the two routes must produce the same template.
 * `templateProblems` already counts its `{{n}}` markers against `shape.body`, so a mismatch
 * between the wording and the parameter list is caught by `npm run doctor` rather than by Meta.
 */
function componentsFor(shape, origin, headerHandle) {
  const components = [];

  if (shape.header === 'IMAGE') {
    /**
     * ⚠️ **Meta will not approve a media-header template without a sample of the media.** The
     * handle comes from the resumable upload below; there is no way to submit this by hand
     * either, which is part of why the picture template has always been the awkward one.
     */
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [headerHandle] },
    });
  }

  components.push({
    type: 'BODY',
    // The category-response templates carry their own wording; everything older shares one body.
    text: shape.bodyText ?? ALERT_TEMPLATE_TEXT,
    /**
     * One row, holding one example per `{{n}}` in order. Meta rejects a template whose examples
     * do not match its placeholder count, and these are the district's own examples — the ones
     * written beside each parameter in `whatsappTemplate.ts`.
     */
    example: { body_text: [shape.body.map((p) => p.example)] },
  });

  const buttons = [
    ...shape.quickReplies.map((text) => ({ type: 'QUICK_REPLY', text })),
    ...(shape.urlButton === null
      ? []
      : [
          {
            type: 'URL',
            text: shape.urlButton.label,
            /**
             * 🔴 **Meta APPENDS the parameter to this prefix rather than replacing it**, which is
             * why the template holds the origin and a send holds only the token. Get this wrong
             * and every acknowledge link in the district is dead while every send succeeds — the
             * 2026-08-12 defect, which nothing reported for as long as it lasted.
             */
            // The shape's own prefix: `/ack/` for the alerts, `/set-password/` for the sign-in
            // link (ADR-0043). `ackBase` is the alerts' — the same string, built one way.
            url: `${urlBase(shape, origin)}{{1}}`,
            example: [`${urlBase(shape, origin)}Rk9wcW5oTQ`],
          },
        ]),
  ];

  /**
   * ⚠️ **The order here is the order in `TemplateShape.quickReplies` then `urlButton`, and it is
   * the order `urlButton.index` claims.** Meta identifies a button parameter by position and
   * nothing else, so a template submitted with its buttons the other way round is a template on
   * which Meta refuses **every** message — checked rather than trusted, below.
   */
  if (shape.urlButton !== null && buttons[shape.urlButton.index]?.type !== 'URL') {
    die(
      `Refusing to submit: ${shape.name} claims its link is button ${String(shape.urlButton.index + 1)}, ` +
        'but that is not where this would put it.',
      'This is a bug in whatsappTemplate.ts, not in your command. Meta matches a button ' +
        'parameter by position, so submitting this would break every message on the template.',
    );
  }

  if (buttons.length > 0) components.push({ type: 'BUTTONS', buttons });
  return components;
}

/**
 * Upload one sample image and return Meta's handle for it — the Resumable Upload API.
 *
 * Two calls, and the second uses `Authorization: OAuth` rather than `Bearer`. That is Meta's
 * spec and not a typo: the upload endpoint predates the Graph conventions around it.
 *
 * The app id is read back from the token rather than asked for. A district that has a working
 * token has, by definition, an app; asking them to find its id in a console is one more thing to
 * get wrong, and `debug_token` already knows.
 */
async function uploadSample(base, token, filePath) {
  const bytes = await readFile(filePath);

  const debug = await reach(
    `${base}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
  );
  if (!debug.ok || debug.status !== 200) {
    die(
      'Could not work out which Meta app this token belongs to.',
      'A media-header template needs a sample image uploaded against the app, and the upload ' +
        'endpoint is addressed by app id. Pass --app-id if you know it.',
    );
  }
  const appId = arg('app-id') ?? JSON.parse(debug.text)?.data?.app_id;
  if (!set(String(appId ?? ''))) {
    die('The token did not name an app id.', 'Pass --app-id explicitly.');
  }

  const started = await reach(
    `${base}/${String(appId)}/uploads?file_name=sample.png&file_length=${String(bytes.length)}&file_type=image%2Fpng`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  if (!started.ok || started.status !== 200) {
    die(
      `Meta refused to start the sample upload: ${started.text?.slice(0, 300) ?? started.error}`,
      'The token needs whatsapp_business_management. A temporary token from the Getting ' +
        'Started page expires in 24 hours — use a permanent System User token.',
    );
  }
  const sessionId = JSON.parse(started.text)?.id;
  if (!set(String(sessionId ?? ''))) die('Meta started no upload session.');

  const uploaded = await reach(`${base}/${String(sessionId)}`, {
    method: 'POST',
    headers: {
      authorization: `OAuth ${token}`,
      file_offset: '0',
      'content-type': 'application/octet-stream',
    },
    body: bytes,
  });
  if (!uploaded.ok || uploaded.status !== 200) {
    die(`The sample image did not upload: ${uploaded.text?.slice(0, 300) ?? uploaded.error}`);
  }
  const handle = JSON.parse(uploaded.text)?.h;
  if (!set(String(handle ?? ''))) die('Meta returned no handle for the sample image.');
  return String(handle);
}

async function main() {
  const wanted = arg('name');
  const confirm = process.argv.includes('--confirm');

  if (wanted === undefined || process.argv.includes('--help')) {
    console.log(`
District Nerve Center — submit a message template to Meta

  npm run submit:template -- --name <template>            ${DIM}shows what would be sent${OFF}
  npm run submit:template -- --name <template> --confirm  ${DIM}submits it${OFF}

Templates this software knows how to submit:

${SUBMITTABLE.map((s) => `  ${s.name}${s.header === 'IMAGE' ? `  ${DIM}(carries a picture)${OFF}` : ''}`).join('\n')}

${DIM}It only ever creates. A name that already exists at Meta — approved, pending or rejected —${OFF}
${DIM}is refused, because editing a live template returns it to review and can stop the district${OFF}
${DIM}sending at all. Nothing local is changed either: an approved template starts being used${OFF}
${DIM}when somebody points the matching WHATSAPP_TEMPLATE_* line at it.${OFF}
`);
    process.exit(wanted === undefined ? 1 : 0);
  }

  const shape = SUBMITTABLE.find((s) => s.name === wanted);
  if (shape === undefined) {
    die(
      `This software has no shape called "${wanted}".`,
      'Submitting a name whose wording is not in whatsappTemplate.ts would mean Meta approving ' +
        'something the software does not send — which is the whole failure this tool exists to ' +
        'prevent. Add the shape first, then submit it.',
    );
  }

  const env = await readEnv();
  const token = env.WHATSAPP_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const origin = env.PUBLIC_ORIGIN;

  if (!set(token) || !set(phoneNumberId)) {
    die('WhatsApp is not configured on this machine.', 'Run: npm run setup:whatsapp');
  }
  if (shape.urlButton !== null && (!set(origin) || !origin.startsWith('https://'))) {
    die(
      `PUBLIC_ORIGIN is ${set(origin) ? `"${origin}"` : 'not set'}, so the acknowledge link cannot be built.`,
      'The URL button is approved with this district’s address baked into it — submitted ' +
        'against a placeholder, every acknowledge button on the template would be dead.',
    );
  }

  /**
   * 🔴 **Refuse anything this installation is currently sending on.**
   *
   * The existence check below would catch it anyway. This one exists to answer *why not* in a
   * sentence rather than as a name collision, because "it already exists" reads like something
   * to work around and "this is what your officers are receiving right now" does not.
   */
  const live = [
    ['WHATSAPP_TEMPLATE', env.WHATSAPP_TEMPLATE ?? ALERT_TEMPLATE.name],
    ['WHATSAPP_TEMPLATE_IMAGE', env.WHATSAPP_TEMPLATE_IMAGE],
    ['WHATSAPP_TEMPLATE_EMERGENCY', env.WHATSAPP_TEMPLATE_EMERGENCY],
    ['WHATSAPP_TEMPLATE_NOTICE', env.WHATSAPP_TEMPLATE_NOTICE],
    ['WHATSAPP_TEMPLATE_NOTICE_IMAGE', env.WHATSAPP_TEMPLATE_NOTICE_IMAGE],
    ['WHATSAPP_TEMPLATE_LOGIN', env.WHATSAPP_TEMPLATE_LOGIN],
  ].find(([, name]) => set(name) && name === wanted);

  if (live !== undefined) {
    die(
      `"${wanted}" is live — it is what ${live[0]} names, and officers in this district are ` +
        'receiving it now.',
      'A live template is never edited or resubmitted (M6-26). Submit a new name instead, ' +
        'wait for approval, and point the .env line at it when it is approved.',
    );
  }

  const base = env.WHATSAPP_BASE_URL ?? 'https://graph.facebook.com/v21.0';
  const auth = { authorization: `Bearer ${token}` };

  const account = await reach(`${base}/${phoneNumberId}?fields=whatsapp_business_account`, {
    headers: auth,
  });
  let wabaId = null;
  if (account.ok && account.status === 200) {
    wabaId = JSON.parse(account.text)?.whatsapp_business_account?.id ?? null;
  }
  wabaId ??= set(env.WHATSAPP_BUSINESS_ACCOUNT_ID) ? env.WHATSAPP_BUSINESS_ACCOUNT_ID : null;
  if (wabaId === null) {
    die(
      'Could not work out which WhatsApp Business Account this number belongs to.',
      'Set WHATSAPP_BUSINESS_ACCOUNT_ID in app/.env. Templates live on the business account, ' +
        'not on the phone number.',
    );
  }

  const existing = await reach(
    `${base}/${wabaId}/message_templates?limit=200&fields=name,language,status`,
    { headers: auth },
  );
  if (!existing.ok || existing.status !== 200) {
    die(
      `The existing templates could not be read: ${existing.text?.slice(0, 300) ?? existing.error}`,
      'This tool will not submit without reading them first — the one thing it must never do ' +
        'is disturb a template that already exists. The token may be missing ' +
        'whatsapp_business_management.',
    );
  }

  const already = JSON.parse(existing.text)?.data?.find((t) => t.name === wanted) ?? null;
  if (already !== null) {
    die(
      `"${wanted}" already exists on this account — ${String(already.status ?? 'unknown status').toLowerCase()}.`,
      already.status === 'APPROVED'
        ? 'Nothing to do. Point the matching WHATSAPP_TEMPLATE_* line at it when the district ' +
            'is ready to switch.'
        : already.status === 'REJECTED'
          ? 'Read the rejection reason in WhatsApp Manager. A rejected name cannot be reused — ' +
            'submit the next version under a new name.'
          : 'Meta is still reviewing it. Run npm run doctor to see when that finishes.',
    );
  }

  const headerHandle =
    shape.header === 'IMAGE' && confirm
      ? await uploadSample(base, token, join(appRoot, 'web/icons/icon-512.png'))
      : shape.header === 'IMAGE'
        ? '<uploaded when you pass --confirm>'
        : undefined;

  const payload = {
    name: shape.name,
    language: shape.language,
    category: shape.category,
    components: componentsFor(shape, origin, headerHandle),
  };

  console.log('');
  console.log(`${DIM}This is exactly what would be posted to Meta:${OFF}`);
  console.log('');
  console.log(JSON.stringify(payload, null, 2));
  console.log('');

  if (!confirm) {
    console.log(`${YELLOW}Nothing was sent.${OFF}`);
    console.log(
      `${DIM}Read the wording above as an officer would, then run the same command with --confirm.${OFF}`,
    );
    console.log('');
    return;
  }

  const created = await reach(`${base}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!created.ok || created.status !== 200) {
    die(
      `Meta refused it: ${created.text?.slice(0, 500) ?? created.error}`,
      'Nothing was changed — no existing template is affected by a refused submission.',
    );
  }

  const answer = JSON.parse(created.text);
  console.log(
    `${GREEN}Submitted.${OFF} "${shape.name}" is with Meta — ` +
      `${String(answer.status ?? 'PENDING').toLowerCase()}.`,
  );
  console.log('');
  console.log(
    `${DIM}Nothing has changed for the district. Every message still goes out on the${OFF}`,
  );
  console.log(
    `${DIM}templates it went out on this morning, and will until somebody points a${OFF}`,
  );
  console.log(
    `${DIM}WHATSAPP_TEMPLATE_* line at this one. "npm run doctor" says when it is approved.${OFF}`,
  );
  console.log('');
}

await main();
