/**
 * `npm run doctor` — is this district ready to go live, and if not, what exactly is missing?
 *
 * ## What this is for
 *
 * Two things stand between this software and a district using all of it, and **neither is
 * code**: a WhatsApp account (R-05, R-19, R-20) and a subdomain pointed at the office machine
 * (R-21). Both are somebody else's queue — Meta's review, a registrar's DNS, a router's port
 * forward — and both have the same failure mode: **you find out it is wrong on the night it
 * matters**, from a provider error code nobody in a district office can read.
 *
 * So this checks the whole path, in the order it has to be done, and every failure names the
 * next action rather than the symptom. It is safe to run at any point: before anything is
 * bought, halfway through, and after everything is live.
 *
 * ## What it deliberately does not do
 *
 * **It changes nothing.** Not the database, not `.env`, not Meta. `setup-whatsapp.mjs` writes
 * configuration; this only ever reads and reports. A tool that fixes things while diagnosing
 * them is a tool nobody dares run on the machine holding a district's record.
 *
 * **It never says "ready" without having proved it.** Every check either reached the thing it
 * is about or reports that it could not — the class of fault ADR-0017 exists to close was a
 * system that looked installed and did not work on the handsets that mattered.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ALERT_TEMPLATE,
  ALERT_TEMPLATE_IMAGE,
  ALERT_TEMPLATE_IMAGE_V3,
  EMERGENCY_TEMPLATE,
  NOTICE_TEMPLATE,
  NOTICE_TEMPLATE_IMAGE,
  RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY,
  RESPONSE_TEMPLATE_BY_CATEGORY,
  ackBase,
  responseImageTemplateFor,
  responseTemplateFor,
  shapeNamed,
  templateProblems,
} from '../dist/ops/whatsappTemplate.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[31m';
const DIM = '[2m';
const OFF = '[0m';

/** Findings, in the order they were made. Printed once at the end so the report reads as one. */
const findings = [];

function ok(what, detail) {
  findings.push({ level: 'ok', what, detail });
}
function todo(what, detail, fix) {
  findings.push({ level: 'todo', what, detail, fix });
}
function bad(what, detail, fix) {
  findings.push({ level: 'bad', what, detail, fix });
}

/**
 * Read `app/.env` the way the application does.
 *
 * Deliberately not a dependency. `main.ts` reads this file with a few lines of its own, and a
 * diagnostic that parsed it differently from the thing it is diagnosing would eventually
 * disagree with it — which is the whole class of bug this project keeps writing tests about.
 */
async function readEnv() {
  const env = { ...process.env };
  try {
    const text = await readFile(join(appRoot, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      // The file wins over the ambient environment, because that is the order `main.ts` uses
      // and because a stale shell variable is exactly what makes a diagnosis wrong.
      env[match[1]] = value;
    }
  } catch {
    // No .env at all is a finding, not a crash. Reported below.
  }
  return env;
}

const set = (v) => typeof v === 'string' && v.trim() !== '';

/** A bounded fetch. The district's line may be down, and this must still finish and report. */
async function reach(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

//------------------------------------------------------------------------------
// 1. The domain — R-21, and it comes first
//------------------------------------------------------------------------------
//
// Checked before WhatsApp on purpose. **Meta's webhook has to be a public HTTPS URL**, so a
// district that sets up the account first has to come back and do it again. The order in
// `how-to-set-these-up.md` is the order here.

async function checkDomain(env) {
  const origin = env.PUBLIC_ORIGIN;

  if (!set(origin)) {
    todo(
      'The district’s own web address',
      'PUBLIC_ORIGIN is not set, so this installation has no address of its own.',
      'Point a subdomain at this machine (R-21), then run: npm run setup:domain -- --domain dnc.yourdomain.pk',
    );
    return null;
  }

  if (!origin.startsWith('https://')) {
    /**
     * The live defect ADR-0017 exists to close, stated as such.
     *
     * Service workers and geolocation only run in a secure context. Set to an http:// address,
     * every handset in Bajaur gets an app that does not open without a network — the single
     * claim ADR-0002 exists to make — and location capture falls back to typed guesses.
     */
    bad(
      'The district’s own web address',
      `PUBLIC_ORIGIN is "${origin}", which is not https://.`,
      'Officers’ phones cannot work offline on a plain-http address, and acknowledge links ' +
        'built from it will not open. Set it to the district’s https:// name.',
    );
    return origin;
  }

  const health = await reach(`${origin}/health`);
  if (!health.ok) {
    bad(
      'The district’s own web address',
      `${origin}/health could not be reached — ${health.error}`,
      'Usually one of three things: port 443 is not forwarded to this machine, port 80 is not ' +
        'forwarded either (Let’s Encrypt needs it to issue), or the DNS record points elsewhere.',
    );
    return origin;
  }

  if (health.status !== 200) {
    bad(
      'The district’s own web address',
      `${origin}/health answered ${String(health.status)}.`,
      'The name resolves and something answered, but it is not this application. Check that ' +
        'the proxy is forwarding to 127.0.0.1:3001 and that the application is running.',
    );
    return origin;
  }

  ok('The district’s own web address', `${origin} answers, over TLS.`);
  return origin;
}

//------------------------------------------------------------------------------
// 2. The proxy and the throttle — M6-37, and they are one check
//------------------------------------------------------------------------------

function checkProxyPair(env) {
  const behindProxy = set(env.PUBLIC_ORIGIN) && env.PUBLIC_ORIGIN.startsWith('https://');
  const trusted = set(env.TRUSTED_PROXIES);
  const loopback = env.HOST === '127.0.0.1';

  if (!behindProxy && !trusted) {
    ok('Rate limiting', 'No proxy, and the X-Forwarded-For header is ignored. Correct.');
    return;
  }

  if (behindProxy && !trusted) {
    /**
     * The outage ADR-0011 named in advance.
     *
     * Behind a proxy every request arrives from 127.0.0.1, so the whole district shares one
     * throttle key — **one officer mistyping a password slows sign-in for everybody**, at 02:00,
     * with nothing on any screen saying so.
     */
    bad(
      'Rate limiting behind the proxy',
      'There is a proxy but TRUSTED_PROXIES is not set.',
      'Every request looks like it came from 127.0.0.1, so one officer mistyping a password ' +
        'would slow sign-in for the whole district. Set TRUSTED_PROXIES=127.0.0.1.',
    );
    return;
  }

  if (!behindProxy && trusted) {
    // The opposite mistake, and the dangerous direction: a rate limiter an attacker opts out of
    // by adding a header is worse than none, because it is believed.
    bad(
      'Rate limiting',
      'TRUSTED_PROXIES is set but there is no proxy in front of this application.',
      'Anything reaching this machine directly can now choose its own throttle key by sending ' +
        'an X-Forwarded-For header. Remove TRUSTED_PROXIES, or put the proxy in front.',
    );
    return;
  }

  if (!loopback) {
    bad(
      'The application is still reachable directly',
      'HOST is not 127.0.0.1, so the proxy can be bypassed.',
      'Bypassed, X-Forwarded-For becomes a header the caller writes — which is what makes ' +
        'trusting it safe or unsafe. Set HOST=127.0.0.1 and PORT=3001.',
    );
    return;
  }

  ok('Rate limiting behind the proxy', 'The proxy is pinned and the application is on loopback.');
}

//------------------------------------------------------------------------------
// 3. WhatsApp — R-05, R-19, R-20
//------------------------------------------------------------------------------

async function checkWhatsApp(env, origin) {
  const id = env.WHATSAPP_PHONE_NUMBER_ID;
  const token = env.WHATSAPP_TOKEN;
  const secret = env.WHATSAPP_APP_SECRET;
  const verify = env.WHATSAPP_VERIFY_TOKEN;

  const missing = [
    !set(id) && 'WHATSAPP_PHONE_NUMBER_ID',
    !set(token) && 'WHATSAPP_TOKEN',
    !set(secret) && 'WHATSAPP_APP_SECRET',
    !set(verify) && 'WHATSAPP_VERIFY_TOKEN',
  ].filter(Boolean);

  if (missing.length > 0) {
    /**
     * Not configured is the **normal** state until the account exists, and this says so.
     *
     * The product is complete without it: the obligation is still recorded, "Reach them" hands
     * the operator the number, and the operator records what they were told (M7-05). What must
     * never happen is the district believing messages are going out when no account exists —
     * which is why this is a `todo`, not a failure.
     *
     * **This text named the in-app inbox until 2026-08-11**, five days after ADR-0018 deleted
     * it. `doctor` is the one command the district runs to ask whether they are ready, so it was
     * naming a channel that does not exist to the exact audience least able to know better.
     * Sixth instance of a sentence outliving the decision it was written under.
     */
    todo(
      'WhatsApp',
      `Not configured yet (missing ${missing.join(', ')}).`,
      'Until the account exists, alerts are “Reach them” plus the operator’s own record of ' +
        'what they were told, and the dashboard says so. When you have the credentials, ' +
        'run: npm run setup:whatsapp',
    );
    return;
  }

  const base = env.WHATSAPP_BASE_URL ?? 'https://graph.facebook.com/v21.0';
  const auth = { authorization: `Bearer ${token}` };

  // The number, which proves the token and the id belong to each other. Either being wrong
  // produces the same silence at 02:00, and this tells them apart.
  const number = await reach(
    `${base}/${id}?fields=display_phone_number,verified_name,quality_rating,throughput`,
    { headers: auth },
  );

  if (!number.ok) {
    bad('WhatsApp', `Could not reach Meta — ${number.error}`, 'Check this machine’s internet.');
    return;
  }
  if (number.status !== 200) {
    bad(
      'WhatsApp credentials',
      `Meta answered ${String(number.status)}: ${number.text.slice(0, 300)}`,
      'Usually an expired or wrong token, or a phone number id from a different account. ' +
        'A temporary token from the Getting Started page expires in 24 hours — use a ' +
        'permanent System User token instead.',
    );
    return;
  }

  const details = JSON.parse(number.text);
  ok(
    'WhatsApp number',
    `${details.display_phone_number ?? 'unknown'} (${details.verified_name ?? 'not named'})` +
      (details.quality_rating ? ` · quality ${details.quality_rating}` : ''),
  );

  //----------------------------------------------------------------------------
  // The template — where the surprise will be
  //----------------------------------------------------------------------------
  //
  // The account it belongs to has to be found first: templates live on the WhatsApp Business
  // Account, not on the phone number.

  const account = await reach(`${base}/${id}?fields=whatsapp_business_account`, { headers: auth });
  let wabaId = null;
  if (account.ok && account.status === 200) {
    wabaId = JSON.parse(account.text)?.whatsapp_business_account?.id ?? null;
  }
  wabaId ??= env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? null;

  if (wabaId === null) {
    todo(
      'The message template',
      'Could not work out which business account this number belongs to, so the template ' +
        'could not be checked.',
      'Set WHATSAPP_BUSINESS_ACCOUNT_ID in app/.env and run this again. Meanwhile, check by ' +
        'hand that the template matches docs/whatsapp-template.md exactly.',
    );
    return;
  }

  const wanted = env.WHATSAPP_TEMPLATE ?? ALERT_TEMPLATE.name;
  const language = env.WHATSAPP_TEMPLATE_LANG ?? ALERT_TEMPLATE.language;

  const templates = await reach(
    `${base}/${wabaId}/message_templates?limit=200&fields=name,language,status,category,components`,
    { headers: auth },
  );

  if (!templates.ok || templates.status !== 200) {
    todo(
      'The message template',
      'The template list could not be read.',
      'The token may not have whatsapp_business_management permission. The alert will still ' +
        'send if the template is right; this check simply cannot confirm it.',
    );
    return;
  }

  const found =
    JSON.parse(templates.text)?.data?.find((t) => t.name === wanted && t.language === language) ??
    null;

  /**
   * The comparison this whole file exists for.
   *
   * The sender and this check read the **same** `ALERT_TEMPLATE`, so "what the code sends" and
   * "what Meta approved" cannot drift into disagreeing without one of these problems appearing.
   * Each one is a send that would otherwise fail on the first real night.
   */
  /**
   * `urlButton.base` is overridden with **this installation's** origin, and that override is
   * the whole of the 2026-08-12 fix.
   *
   * `ALERT_TEMPLATE` cannot know the district's address — it is source, and the address is
   * deployment. Left at its placeholder the comparison would be against `{PUBLIC_ORIGIN}/ack/`
   * and would fail for every real installation, so the origin has to arrive here. Where
   * `PUBLIC_ORIGIN` is not set the check above has already said so; the button comparison is
   * skipped rather than reported against a value nobody supplied.
   */
  const problems = templateProblems(found, {
    ...ALERT_TEMPLATE,
    name: wanted,
    language,
    ...(set(origin) && ALERT_TEMPLATE.urlButton !== null
      ? { urlButton: { ...ALERT_TEMPLATE.urlButton, base: ackBase(origin) } }
      : { urlButton: null }),
  });

  if (problems.length === 0) {
    ok(
      'The message template',
      `"${wanted}" (${language}) is approved and matches what is sent. ` +
        'Every message goes on this one except a photograph, which has its own.',
    );
  } else {
    for (const problem of problems) {
      const pending = problem.what.includes('not finished reviewing');
      (pending ? todo : bad)('The message template', problem.what, problem.fix);
    }
  }

  /**
   * The picture template, graded separately and only when the district has named one — M10-30.
   *
   * ⚠️ **The point of grading it apart is that the two are used for different messages.** A
   * district reading one line saying "the template is fine" cannot tell which template that was,
   * and the failure this whole task exists to prevent is a header going on the wrong one — Meta
   * then refuses **every** message on it, emergencies included.
   *
   * Absent is not a fault and must not be reported as one. Until Meta approves
   * `district_message_img` the district is in the ordinary state: photographs travel as links,
   * exactly like PDFs, and nothing is broken.
   */
  const imageWanted = env.WHATSAPP_TEMPLATE_IMAGE;

  /**
   * ⚠️ **`if`/`else` and not an early `return`, and that was a real bug for a minute.**
   *
   * The webhook check runs after this block. Returning here — on the ordinary, healthy state of
   * *"no picture template yet"* — would have silently skipped it, so a district with a broken
   * webhook would have been told nothing about it because of a template they do not have. The
   * early returns above this are different: each one is a hard failure that makes everything
   * after it unanswerable.
   */
  if (!set(imageWanted)) {
    todo(
      'The picture template',
      'Not configured, so a photograph travels as a link like every other file.',
      'Nothing is wrong. When Meta approves the image template, set WHATSAPP_TEMPLATE_IMAGE in ' +
        'app/.env and a JPG will ride the message instead. Every other message is unaffected ' +
        'either way — the two templates are chosen per message, never by a switch.',
    );
  } else {
    gradePictureTemplate(imageWanted);
  }

  /**
   * **Is the answerable photograph template ready yet?** — 2026-08-25.
   *
   * `district_message_img_v3` was submitted so that an emergency carrying a picture could be
   * answered with a tap instead of a link, and Meta's review is somebody else's queue: minutes
   * to days, with no notification the district would see. Without this line the only way to
   * find out is to open WhatsApp Manager and look, which means nobody looks.
   *
   * ⚠️ **This reports and never switches.** The owner was explicit — *"jub template approve ho
   * jaega tou phir hum laga denge"* — so a district goes on sending photographs on whatever
   * `WHATSAPP_TEMPLATE_IMAGE` already names until a person changes that line. A tool that
   * moved live traffic onto a template the moment Meta approved it would be making that
   * decision for them, on a night nobody chose.
   */
  reportSubmittedPictureTemplate();

  function reportSubmittedPictureTemplate() {
    const name = ALERT_TEMPLATE_IMAGE_V3.name;
    /** Already live — `gradePictureTemplate` has just said everything worth saying. */
    if (imageWanted === name) return;

    const found =
      JSON.parse(templates.text)?.data?.find(
        (t) => t.name === name && t.language === ALERT_TEMPLATE_IMAGE_V3.language,
      ) ?? null;

    /** Never submitted, which is the ordinary state for every district but Bajaur. */
    if (found === null) return;

    const status = String(found.status ?? 'UNKNOWN').toUpperCase();

    if (status === 'APPROVED') {
      todo(
        `The photograph template that can be answered`,
        `Meta has approved "${name}" — it is not in use yet.`,
        `Set WHATSAPP_TEMPLATE_IMAGE=${name} in app/.env and restart. An emergency carrying ` +
          'a photograph can then be acknowledged with a tap, like every other kind, instead of ' +
          'sending the officer out to a web page. Nothing else changes and the old template is ' +
          'left alone at Meta.',
      );
      return;
    }

    if (status === 'REJECTED') {
      todo(
        `The photograph template that can be answered`,
        `Meta rejected "${name}". Photographs keep going out on the template they already use.`,
        'Nothing is broken — read the reason in WhatsApp Manager → Message templates. The ' +
          'usual cause is submitting as MARKETING; it must be UTILITY.',
      );
      return;
    }

    todo(
      `The photograph template that can be answered`,
      `"${name}" is with Meta — ${status.toLowerCase()}.`,
      'Nothing to do but wait, and nothing is affected while you do: photographs keep going ' +
        'out on the template they already use. Run this again to see when it is approved.',
    );
  }

  /**
   * The two tappable templates, graded apart from each other and from the two above — 2026-08-19.
   *
   * ⚠️ **Four templates, four lines, and the separation is the whole point.** A district reading
   * one verdict cannot tell which template it was about, and every one of these is used for
   * different messages: an unnoticed fault on the meeting template is meetings going out wrong,
   * on the emergency one it is emergencies. `district_emergency_v2` carries the sharper trap —
   * its acknowledge link is the **second** button, and a parameter sent to the first is a message
   * Meta refuses outright.
   *
   * Not configured is not a fault. It is the state every district is in until it names them, and
   * it means messages go out exactly as they did before, on one link and no buttons to tap.
   */
  gradeTappable(
    'The emergency template',
    env.WHATSAPP_TEMPLATE_EMERGENCY,
    env.WHATSAPP_TEMPLATE_EMERGENCY_LANG,
    EMERGENCY_TEMPLATE,
    'WHATSAPP_TEMPLATE_EMERGENCY',
    'An emergency, alert, advisory or order can then be acknowledged with one tap, without ' +
      'opening a browser at all.',
  );

  gradeTappable(
    'The meeting template',
    env.WHATSAPP_TEMPLATE_NOTICE,
    env.WHATSAPP_TEMPLATE_NOTICE_LANG,
    NOTICE_TEMPLATE,
    'WHATSAPP_TEMPLATE_NOTICE',
    'A meeting notice can then be answered "Attending", "Not attending" or "Sending someone" — ' +
      'and until it is, an officer who cannot come has no way to say so.',
  );

  /**
   * **The meeting's picture-carrying template — 2026-09-04, the owner's own line.**
   *
   * Independent of `WHATSAPP_TEMPLATE_NOTICE` above for the same reason `WHATSAPP_TEMPLATE_IMAGE`
   * is independent of `WHATSAPP_TEMPLATE`: a district may have one approved and not the other,
   * reviewed on Meta's own schedule. `templateProblems` does not check `header` — a photograph
   * either rides or does not, and Meta refuses the send outright when it does not match what was
   * approved, which is a fault this check cannot pre-empt any better by reading the header field.
   */
  gradeTappable(
    'The meeting picture template',
    env.WHATSAPP_TEMPLATE_NOTICE_IMAGE,
    env.WHATSAPP_TEMPLATE_NOTICE_IMAGE_LANG,
    NOTICE_TEMPLATE_IMAGE,
    'WHATSAPP_TEMPLATE_NOTICE_IMAGE',
    'A meeting notice with a photograph then carries the photograph IN the message, with the ' +
      'same three RSVP buttons, instead of trading the photograph for a file link.',
  );

  /**
   * **The per-category response templates the district has switched on — ADR-0034.**
   *
   * One `.env` line, `WHATSAPP_RESPONSE_CATEGORIES`, a comma list of category slugs. Each named
   * category's alert goes out on its own `dnc_response_<category>` template — three quick replies,
   * no link, no acknowledge step. Graded per category rather than in one line, for the same
   * reason as the four above: a fault on the fire template is fire alerts going out unanswerable.
   *
   * ⚠️ **Six of the twelve were still `PENDING` at Meta when this shipped.** A category listed
   * before its template is approved `UTILITY` reads red here, which is the signal to take it back
   * off the line — an alert on a `PENDING` or `MARKETING` template is refused or throttled.
   */
  const responseCategories = (env.WHATSAPP_RESPONSE_CATEGORIES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');

  if (responseCategories.length === 0) {
    todo(
      'The per-category response templates',
      'Not configured, so every emergency answers on the ordinary emergency template.',
      'Nothing is wrong. When a dnc_response_<category> template is approved UTILITY, add the ' +
        'category to WHATSAPP_RESPONSE_CATEGORIES in app/.env (e.g. fire,medical,road_accident).',
    );
  } else {
    for (const category of responseCategories) {
      const shape = responseTemplateFor(category);
      if (shape === undefined) {
        bad(
          'The per-category response templates',
          `WHATSAPP_RESPONSE_CATEGORIES names "${category}", which is not one of ` +
            `${[...RESPONSE_TEMPLATE_BY_CATEGORY.keys()].join(', ')}.`,
          'Fix the spelling in app/.env, or remove it. A category with no template is ignored ' +
            'by the send path but means the line is not saying what it looks like.',
        );
        continue;
      }

      const found =
        JSON.parse(templates.text)?.data?.find(
          (t) => t.name === shape.name && t.language === shape.language,
        ) ?? null;

      const problems = templateProblems(found, shape);

      if (problems.length === 0) {
        ok(
          'The per-category response templates',
          `"${shape.name}" (${shape.language}) is approved and matches what is sent — ${category} ` +
            'alerts answer on it with three quick replies and no link.',
        );
        continue;
      }

      for (const problem of problems) {
        const pending = problem.what.includes('not finished reviewing');
        (pending ? todo : bad)('The per-category response templates', problem.what, problem.fix);
      }
    }
  }

  /**
   * **The picture-carrying versions of four of those categories — 2026-09-04, the owner's own
   * line.** Only `advisory`, `order`, `schedule` and `information` have one at all; the owner
   * drew that line rather than asking for all twelve, so a category outside it names nothing here
   * and its photograph keeps travelling as a file link, which is correct rather than a gap.
   */
  const responseImageCategories = (env.WHATSAPP_RESPONSE_IMAGE_CATEGORIES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');

  if (responseImageCategories.length === 0) {
    todo(
      'The per-category picture templates',
      'Not configured, so every category’s photograph travels as a file link.',
      'Nothing is wrong. When a dnc_response_<category>_img template is approved UTILITY, add ' +
        'the category to WHATSAPP_RESPONSE_IMAGE_CATEGORIES in app/.env — only advisory, order, ' +
        'schedule and information have one to approve.',
    );
  } else {
    for (const category of responseImageCategories) {
      const shape = responseImageTemplateFor(category);
      if (shape === undefined) {
        bad(
          'The per-category picture templates',
          `WHATSAPP_RESPONSE_IMAGE_CATEGORIES names "${category}", which is not one of ` +
            `${[...RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY.keys()].join(', ')}.`,
          'Fix the spelling in app/.env, or remove it. Only advisory, order, schedule and ' +
            'information have a picture-carrying template at all.',
        );
        continue;
      }

      const found =
        JSON.parse(templates.text)?.data?.find(
          (t) => t.name === shape.name && t.language === shape.language,
        ) ?? null;

      const problems = templateProblems(found, shape);

      if (problems.length === 0) {
        ok(
          'The per-category picture templates',
          `"${shape.name}" (${shape.language}) is approved and matches what is sent — ${category} ` +
            'alerts with a photograph now carry it IN the message, with the same three buttons.',
        );
        continue;
      }

      for (const problem of problems) {
        const pending = problem.what.includes('not finished reviewing');
        (pending ? todo : bad)('The per-category picture templates', problem.what, problem.fix);
      }
    }
  }

  function gradeTappable(heading, wantedName, wantedLang, shape, envVar, whatItBuys) {
    if (!set(wantedName)) {
      todo(
        heading,
        'Not configured, so these messages go out on the ordinary template with one link.',
        `Nothing is wrong. When Meta approves it, set ${envVar} in app/.env. ${whatItBuys}`,
      );
      return;
    }

    const language = wantedLang ?? shape.language;
    const found =
      JSON.parse(templates.text)?.data?.find(
        (t) => t.name === wantedName && t.language === language,
      ) ?? null;

    /**
     * The origin override, exactly as the two templates above do it — and the meeting template
     * legitimately has no URL button at all, so `shape.urlButton === null` is left alone rather
     * than being treated as a missing origin.
     */
    const problems = templateProblems(found, {
      ...shape,
      name: wantedName,
      language,
      ...(set(origin) && shape.urlButton !== null
        ? { urlButton: { ...shape.urlButton, base: ackBase(origin) } }
        : { urlButton: null }),
    });

    if (problems.length === 0) {
      ok(heading, `"${wantedName}" (${language}) is approved and matches what is sent.`);
      return;
    }

    for (const problem of problems) {
      const pending = problem.what.includes('not finished reviewing');
      (pending ? todo : bad)(heading, problem.what, problem.fix);
    }
  }

  function gradePictureTemplate(imageWanted) {
    /**
     * 🔴 **The shape is looked up by the CONFIGURED NAME — 2026-08-25.**
     *
     * This graded every picture template against `ALERT_TEMPLATE_IMAGE`, which was right for
     * exactly as long as `_img_v2` was the only one. `_img_v3` carries a quick reply and puts
     * the link **second**, so the day the district switches, the old code would have compared
     * Meta's approved v3 against v2's shape and reported faults on a template that is perfect —
     * which is worse than not checking, because somebody would go and "fix" a good template.
     *
     * `?? ALERT_TEMPLATE_IMAGE` keeps the old behaviour for a name this source has never heard
     * of, exactly as `templateFor` does for the same reason.
     */
    const shape = shapeNamed(imageWanted) ?? ALERT_TEMPLATE_IMAGE;
    const imageLanguage = env.WHATSAPP_TEMPLATE_IMAGE_LANG ?? shape.language;
    const imageFound =
      JSON.parse(templates.text)?.data?.find(
        (t) => t.name === imageWanted && t.language === imageLanguage,
      ) ?? null;

    const imageProblems = templateProblems(imageFound, {
      ...shape,
      name: imageWanted,
      language: imageLanguage,
      ...(set(origin) && shape.urlButton !== null
        ? { urlButton: { ...shape.urlButton, base: ackBase(origin) } }
        : { urlButton: null }),
    });

    if (imageProblems.length === 0) {
      ok(
        'The picture template',
        `"${imageWanted}" (${imageLanguage}) is approved. A JPG rides the message on this one; ` +
          'a PDF and everything else stays on the ordinary template.' +
          /**
           * Said here rather than in a separate line, because the two facts belong together:
           * whether the picture template works, and whether answering it costs the officer a
           * browser. A district reading only the first would think the photograph path is done.
           */
          (shape.quickReplies.length === 0
            ? ' It carries a link and no tap, so an officer answering it leaves WhatsApp.'
            : ' It carries a tap as well as a link, so the workflow stays inside WhatsApp.'),
      );
    } else {
      for (const problem of imageProblems) {
        const pending = problem.what.includes('not finished reviewing');
        (pending ? todo : bad)('The picture template', problem.what, problem.fix);
      }
    }
  }

  //----------------------------------------------------------------------------
  // The webhook — can Meta actually reach us?
  //----------------------------------------------------------------------------

  if (origin === null || !origin.startsWith('https://')) {
    todo(
      'The webhook',
      'Cannot be checked until the district’s https:// address is working.',
      'Do R-21 first — Meta will only accept a public HTTPS webhook URL.',
    );
    return;
  }

  const handshake = await reach(
    `${origin}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=doctor-check`,
  );

  if (!handshake.ok) {
    bad(
      'The webhook',
      `${origin}/webhooks/whatsapp could not be reached — ${handshake.error}`,
      'Meta will not be able to reach it either, so no delivery status and no reply will ever ' +
        'arrive. Every message would stay "waiting" for ever on the board.',
    );
    return;
  }

  if (handshake.status !== 200 || handshake.text.trim() !== 'doctor-check') {
    bad(
      'The webhook',
      `The verification handshake answered ${String(handshake.status)}: ${handshake.text.slice(0, 120)}`,
      'The running application does not have this WHATSAPP_VERIFY_TOKEN. Restart it after ' +
        'changing app/.env — the value is read at boot.',
    );
    return;
  }

  ok(
    'The webhook',
    `${origin}/webhooks/whatsapp answers Meta’s handshake. Paste that URL into WhatsApp Manager ` +
      `→ Configuration, with the verify token from app/.env, and subscribe to "messages".`,
  );
}

//------------------------------------------------------------------------------
// 4. Everything else the district owes
//------------------------------------------------------------------------------

function checkOffsite(env) {
  const passphrase = set(env.BACKUP_PASSPHRASE);

  /**
   * S3 first, because that is what the district chose (ADR-0019, Cloudflare R2) and because
   * `offsiteStore()` prefers it when both are set. Reporting on the one the code would not
   * use is how a doctor tells somebody they are configured while nothing is being sent.
   */
  const s3 =
    set(env.S3_ENDPOINT) &&
    set(env.S3_BUCKET) &&
    set(env.S3_ACCESS_KEY_ID) &&
    set(env.S3_SECRET_ACCESS_KEY);
  const gcs = set(env.GCS_BUCKET) && set(env.GCS_TOKEN);

  if ((s3 || gcs) && passphrase) {
    ok(
      'Off-site backup',
      `Configured (${s3 ? 'S3/R2' : 'Google Cloud'}). The nightly copy leaves this machine, encrypted.`,
    );
    return;
  }

  if ((s3 || gcs) && !passphrase) {
    todo(
      'Off-site backup (R-06)',
      'A bucket is configured but BACKUP_PASSPHRASE is not.',
      'The upload refuses every night rather than sending the district’s record out in the ' +
        'clear. Set BACKUP_PASSPHRASE — at least 16 characters, kept somewhere that is not ' +
        'this server.',
    );
    return;
  }

  todo(
    'Off-site backup (R-06)',
    'Nightly dumps are taken and verified, and no copy has ever left this machine.',
    // The consequence changed with ADR-0019 and is worse than it was: the backup is no longer
    // in a different room from the database, it is on the same disk.
    'Losing this one machine loses the database and every backup of it at once. Needs ' +
      'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and BACKUP_PASSPHRASE ' +
      '— the five-minute Cloudflare R2 setup is in backlog/how-to-set-these-up.md (R-06).',
  );
}

//------------------------------------------------------------------------------

async function main() {
  const env = await readEnv();

  console.log('');
  console.log('District Nerve Center — is this ready to go live?');
  console.log(`${DIM}Reads only. Nothing is changed by running this.${OFF}`);
  console.log('');

  const origin = await checkDomain(env);
  checkProxyPair(env);
  await checkWhatsApp(env, origin);
  checkOffsite(env);

  for (const f of findings) {
    const mark =
      f.level === 'ok'
        ? `${GREEN}ok${OFF}  `
        : f.level === 'todo'
          ? `${YELLOW}todo${OFF}`
          : `${RED}FIX${OFF} `;
    console.log(`  ${mark}  ${f.what}`);
    console.log(`        ${DIM}${f.detail}${OFF}`);
    if (f.fix !== undefined) {
      for (const line of wrap(f.fix, 74)) console.log(`        → ${line}`);
    }
    console.log('');
  }

  const broken = findings.filter((f) => f.level === 'bad').length;
  const waiting = findings.filter((f) => f.level === 'todo').length;

  if (broken > 0) {
    console.log(`${RED}${String(broken)} thing(s) would fail on the night they matter.${OFF}`);
  } else if (waiting > 0) {
    /**
     * Waiting is not broken, and the difference is the point of the two words.
     *
     * A district with no WhatsApp account has a working control room: the paper register is
     * gone, obligations are recorded, and "Reach them" is there. Calling that "broken" would
     * tell them to stop using something that works.
     */
    console.log(
      `${YELLOW}Nothing is broken. ${String(waiting)} thing(s) are waiting on somebody outside this repository.${OFF}`,
    );
    console.log(`${DIM}The control room works today without any of them.${OFF}`);
  } else {
    console.log(`${GREEN}Everything checked is working.${OFF}`);
  }
  console.log('');

  // **Never a non-zero exit for "waiting".** This runs from the installer and from a scheduled
  // check; a district that has not bought a WhatsApp account yet must not have a red build.
  process.exit(broken > 0 ? 1 : 0);
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

await main();
