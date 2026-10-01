/**
 * `npm run setup:domain -- --domain dnc.yourdomain.pk --email ops@yourdomain.pk`
 *
 * The day the district's DNS record exists (R-21). One command that checks the record actually
 * points here, then hands over to the PowerShell installer which puts Caddy in front.
 *
 * ## Why this is a wrapper and not the whole thing
 *
 * The real work is `installer/proxy/install-proxy.ps1`, and it has to be PowerShell: it
 * registers a Windows service, edits a file under `Program Files`, and restarts a service. What
 * this adds is the part somebody running it from the application folder would otherwise skip —
 * **checking that the name resolves here before anything is changed.**
 *
 * That check is not politeness. Let's Encrypt rate limits failed issuance attempts per domain
 * per week, so a name that does not resolve burns attempts against a district's own domain
 * while producing an error nobody reads as "check DNS". Getting rate limited on the district's
 * only name, in the hour they finally sat down to do this, is a week's delay caused by a
 * missing check.
 *
 * ## The three things that ship together
 *
 * The script this calls does all of them in one run, and **they must not be split** — see its
 * own header. Caddy answers; the application moves to loopback; `TRUSTED_PROXIES` pins the
 * proxy. The third one alone is the difference between working rate limiting and one officer's
 * mistyped password slowing sign-in for the whole district.
 */

import { lookup } from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { access } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const proxyScript = join(here, '..', '..', 'installer', 'proxy', 'install-proxy.ps1');

const DIM = '[2m';
const RED = '[31m';
const YELLOW = '[33m';
const OFF = '[0m';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const domain = arg('domain');
const email = arg('email');

if (domain === undefined || email === undefined || process.argv.includes('--help')) {
  console.log(`
District Nerve Center — put the district's own domain in front

  npm run setup:domain -- --domain dnc.yourdomain.pk --email ops@yourdomain.pk

  --domain   The subdomain you pointed at this machine.
  --email    Where Let's Encrypt sends expiry warnings. ${DIM}The last defence when renewal${OFF}
             ${DIM}has silently failed for two months.${OFF}

Before running this, two things must already be true:

  1. An A record for that name points at this district's public address
     ${DIM}(or an outbound tunnel is running — no port forwarding needed then).${OFF}
  2. Ports 80 and 443 reach this machine.
     ${DIM}80 as well as 443: Let's Encrypt needs it to issue the certificate.${OFF}

Why it matters: service workers and location only run on a secure origin. Today
officers open http://<office-IP>:3000, which is not one — so the app does not
open offline on any phone in Bajaur, which is the single thing it exists to do.

Full steps: backlog/how-to-set-these-up.md
`);
  process.exit(domain === undefined || email === undefined ? 1 : 0);
}

console.log('');
console.log(`Checking that ${domain} points here…`);

try {
  const resolved = await lookup(domain, { all: true });
  console.log(`  resolves to ${resolved.map((r) => r.address).join(', ')}`);
} catch {
  /**
   * Refused before anything is changed, and before a certificate is attempted.
   *
   * The order matters: a half-done setup — the application moved to loopback with no working
   * proxy in front — is a district that cannot reach its own system, which is strictly worse
   * than one that has not started.
   */
  console.log('');
  console.log(`${RED}${domain} does not resolve.${OFF}`);
  console.log('');
  console.log('Nothing has been changed. The DNS record is missing or has not propagated yet');
  console.log(`${DIM}(a new record can take up to an hour; most appear in minutes).${OFF}`);
  console.log('');
  console.log('The district already owns the domain, so this is one A record and a port');
  console.log('forward — see backlog/how-to-set-these-up.md, R-21.');
  console.log('');
  process.exit(1);
}

try {
  await access(proxyScript);
} catch {
  console.log(`${RED}installer/proxy/install-proxy.ps1 was not found.${OFF}`);
  console.log('Run this from a checkout that includes the installer folder.');
  process.exit(1);
}

console.log('');
console.log(`${DIM}Handing over to the proxy installer. It will ask for administrator rights.${OFF}`);
console.log('');

const result = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', proxyScript, '-Domain', domain, '-Email', email],
  { stdio: 'inherit' },
);

if (result.error !== undefined) {
  console.log('');
  console.log(`${YELLOW}Could not run PowerShell from here.${OFF}`);
  console.log('Open PowerShell as administrator and run:');
  console.log('');
  console.log(`    & "${proxyScript}" -Domain ${domain} -Email ${email}`);
  console.log('');
  process.exit(1);
}

process.exit(result.status ?? 0);
