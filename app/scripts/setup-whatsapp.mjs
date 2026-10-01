/**
 * `npm run setup:whatsapp` — the day the district's WhatsApp account exists.
 *
 * ## What this is
 *
 * The five values Meta gives you, written into `app/.env` in one step, and then **proved** by
 * running the doctor rather than announcing success. That last part is the whole reason this
 * exists as a script instead of a paragraph telling somebody to edit a file: the failure this
 * project keeps writing tests about is a system that looked configured and did not work on the
 * night it mattered.
 *
 * ## Usage
 *
 *   npm run setup:whatsapp -- \
 *     --phone-number-id 123456789012345 \
 *     --token EAAG... \
 *     --app-secret 0123abcd... \
 *     --verify-token any-long-random-string-you-choose
 *
 * Optional: `--business-account-id` (lets the doctor check the template), `--template` and
 * `--template-lang` if the district approved something under a different name.
 *
 * Run it with no arguments and it prints where each value is found in Meta's console.
 *
 * ## What it is careful about
 *
 * **The existing `.env` is preserved and its permissions are not touched.** This is the file
 * holding the district's database password. It is rewritten key by key, never regenerated, and
 * a backup is left beside it before anything is written.
 *
 * **Nothing is echoed.** Not the token, not the secret, not their lengths — both are facts
 * about a secret, and this runs in a terminal somebody may be sharing a screen from.
 *
 * **A verify token is generated if you do not supply one.** It is a value *you* choose and
 * paste into Meta; there is no reason for a district to invent one badly, and "whatever they
 * typed twice" is how it ends up being the district's name.
 */

import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const envPath = join(appRoot, '.env');

const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const OFF = '[0m';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function help() {
  console.log(`
District Nerve Center — WhatsApp setup

Four values, all from Meta. Where to find each one:

  --phone-number-id     WhatsApp Manager -> API Setup. It is an id, NOT the phone number.
  --token               A permanent System User token, from Business Settings -> System Users.
                        ${DIM}The temporary token on the Getting Started page expires in 24 hours.${OFF}
                        ${DIM}It needs whatsapp_business_messaging and whatsapp_business_management.${OFF}
  --app-secret          App Dashboard -> Settings -> Basic -> App Secret.
                        ${DIM}This is what proves a webhook is genuinely Meta's. Without it,${OFF}
                        ${DIM}anybody could mark every obligation in Bajaur as met.${OFF}
  --verify-token        Any long random string YOU choose. Generated for you if omitted.
                        ${DIM}You paste the same value into WhatsApp Manager -> Configuration.${OFF}

Optional:

  --business-account-id Lets this tool check that your approved template matches what the
                        software actually sends. Strongly recommended -- a mismatch fails
                        every send, and it fails at 02:00 rather than here.
  --template            Only if the district approved it under a different name.
  --template-lang       Only if it was approved in a language other than 'en'.

Do the domain first (R-21). Meta will only accept a public HTTPS webhook URL.
Full steps: backlog/how-to-set-these-up.md
`);
}

/**
 * Rewrite one key, leaving everything else in the file exactly as it was.
 *
 * Line-based rather than parse-and-regenerate, because this file holds the district's database
 * password and may hold comments somebody wrote for the next person. A tool that reformats a
 * secrets file is a tool that eventually loses a line of it.
 */
function setValue(text, key, value) {
  if (new RegExp(`^${key}=`, 'm').test(text)) {
    return text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  }
  return `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
}

async function main() {
  const phoneNumberId = arg('phone-number-id');
  const token = arg('token');
  const appSecret = arg('app-secret');

  if (
    process.argv.includes('--help') ||
    phoneNumberId === undefined ||
    token === undefined ||
    appSecret === undefined
  ) {
    help();
    process.exit(process.argv.includes('--help') ? 0 : 1);
  }

  // Chosen by the district, not by Meta — and generated rather than invented badly.
  const verifyToken = arg('verify-token') ?? randomBytes(24).toString('base64url');
  const generated = arg('verify-token') === undefined;

  try {
    await access(envPath);
  } catch {
    console.log(`${RED}app/.env does not exist.${OFF}`);
    console.log('Copy app/.env.example to app/.env first — it also holds the database URL.');
    process.exit(1);
  }

  // A backup before anything is written. This file unlocks the district's record; the cost of
  // keeping a copy is nothing and the cost of not having one is a reinstall.
  await copyFile(envPath, `${envPath}.before-whatsapp`);

  let text = await readFile(envPath, 'utf8');
  text = setValue(text, 'WHATSAPP_PHONE_NUMBER_ID', phoneNumberId.trim());
  text = setValue(text, 'WHATSAPP_TOKEN', token.trim());
  text = setValue(text, 'WHATSAPP_APP_SECRET', appSecret.trim());
  text = setValue(text, 'WHATSAPP_VERIFY_TOKEN', verifyToken.trim());

  const businessAccountId = arg('business-account-id');
  if (businessAccountId !== undefined) {
    text = setValue(text, 'WHATSAPP_BUSINESS_ACCOUNT_ID', businessAccountId.trim());
  }
  const template = arg('template');
  if (template !== undefined) text = setValue(text, 'WHATSAPP_TEMPLATE', template.trim());
  const templateLang = arg('template-lang');
  if (templateLang !== undefined) {
    text = setValue(text, 'WHATSAPP_TEMPLATE_LANG', templateLang.trim());
  }

  await writeFile(envPath, text);

  console.log('');
  console.log(`${GREEN}Written to app/.env${OFF} ${DIM}(previous copy kept as .env.before-whatsapp)${OFF}`);
  console.log('');

  if (generated) {
    /**
     * Printed **once**, because it has to be pasted into Meta and it is not a secret in the way
     * the token is — it authenticates nothing, it only proves the two ends agree during a
     * one-time handshake. The token and the app secret are never printed at all.
     */
    console.log('  Your verify token — paste this into WhatsApp Manager → Configuration:');
    console.log('');
    console.log(`      ${verifyToken}`);
    console.log('');
  }

  console.log(`${DIM}Restarting the application so it reads the new values…${OFF}`);
  console.log('');

  /**
   * Restarted rather than left to the operator.
   *
   * Every one of these values is read **at boot**. Written and not restarted, the doctor's
   * webhook check fails against the old configuration and reports something that is not true —
   * which is worse than not checking, because somebody would go looking for the wrong problem.
   */
  const restarted = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Restart-Service -Name DistrictNerveCenter -ErrorAction SilentlyContinue'],
    { stdio: 'ignore' },
  );
  if (restarted.error !== undefined) {
    console.log(`${DIM}  (no Windows service found — restart the application yourself)${OFF}`);
    console.log('');
  }

  console.log('Now checking whether it actually works:');
  const doctor = spawnSync(process.execPath, [join(here, 'doctor.mjs')], { stdio: 'inherit' });

  console.log('Next, in WhatsApp Manager → Configuration:');
  console.log('  1. Callback URL:  <your https address>/webhooks/whatsapp');
  console.log('  2. Verify token:  the value above (or the one you supplied)');
  console.log('  3. Subscribe to:  messages');
  console.log('');
  console.log(`${DIM}Then run "npm run doctor" again — it will confirm the handshake.${OFF}`);
  console.log('');

  process.exit(doctor.status ?? 0);
}

await main();
