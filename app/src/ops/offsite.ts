/**
 * Getting the district's record out of the building — M0-53, ADR-0011.
 *
 * `ops/backup.ts` makes a verified dump on the DC office's own disk. That covers a bad
 * restore and a corrupted table. It does not cover the building: fire, flood, or somebody
 * walking out with the machine.
 *
 * So a copy goes to Google Cloud Storage, **nightly**. The owner said weekly; ADR-0011
 * records why that became nightly — a weekly cadence means losing up to seven days of the
 * district's emergency record, and the difference in cost is a few hundred megabytes of
 * transfer.
 *
 * Three rules, and the third is the one that is usually got wrong.
 *
 * 1. **Encrypted before it leaves.** A dump holds every reporter's phone number in Bajaur.
 *    Handing that to a cloud provider in plaintext is a disclosure nobody decided to make.
 * 2. **The key never goes with it.** Obvious, and worth a line of code that makes it
 *    impossible rather than a note saying so.
 * 3. **A failed upload is loud.** A backup that silently stops working is worse than no
 *    backup at all, because it buys false confidence — the district believes it is covered
 *    for a year and finds out on the day it is not. Failures are recorded in the ledger and
 *    surfaced by `/health`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { Pool } from '../db/pool.js';
import { log } from '../obs/log.js';

/**
 * AES-256-GCM, with a key derived from a passphrase by scrypt.
 *
 * GCM rather than CBC because it authenticates: a dump that has been altered in the bucket
 * fails to decrypt rather than restoring quietly wrong. That matters more here than the
 * confidentiality does — a tampered emergency record that restores cleanly is the worst
 * available outcome.
 *
 * The output is `salt | iv | authTag | ciphertext`, all of which the reader needs and none of
 * which is secret. The passphrase is not in it.
 */
export function encryptDump(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * The reverse, for the runbook and for the verify step.
 *
 * Here rather than in a separate tool because a backup nobody can decrypt is not a backup,
 * and the decryption path has to be exercised by the same test suite that exercises the
 * encryption path. See `docs/08-runbook.md`.
 */
export function decryptDump(payload: Buffer, passphrase: string): Buffer {
  if (payload.length < 16 + 12 + 16) throw new Error('not an encrypted dump: too short');

  const salt = payload.subarray(0, 16);
  const iv = payload.subarray(16, 28);
  const authTag = payload.subarray(28, 44);
  const ciphertext = payload.subarray(44);

  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  // Throws on a bad tag rather than returning altered bytes. That is the whole reason for
  // GCM here: a tampered emergency record that restores cleanly is worse than one that
  // refuses to restore at all.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

//------------------------------------------------------------------------------
// Where it goes
//------------------------------------------------------------------------------

/**
 * Somewhere off-site to put a file.
 *
 * One method, so the whole path is testable against an in-memory fake and so that a district
 * that decides against Google Cloud later is changing one adapter rather than the backup job
 * (ADR-0007: nothing in the critical path should need a vendor SDK to be understood).
 */
export interface OffsiteStore {
  readonly name: string;
  /** False until the district has a bucket and a service account (R-06). */
  readonly configured: boolean;
  readonly why: string | null;
  put(key: string, bytes: Buffer): Promise<void>;
  list(): Promise<readonly { readonly key: string; readonly bytes: number }[]>;
}

export interface OffsiteEnv {
  readonly GCS_BUCKET?: string | undefined;
  readonly GCS_TOKEN?: string | undefined;
  /**
   * S3-compatible storage — Cloudflare R2, Backblaze B2, MinIO, AWS, or whatever KPITB runs.
   *
   * **Chosen over Google Cloud Storage on 2026-08-07, and the reason is the last one in this
   * list rather than the price.** GCS gives 5 GB free in US regions and charges for egress;
   * R2 gives 10 GB and charges nothing to get a backup back out — which matters precisely on
   * the day somebody is restoring under pressure. But the argument that settled it is that
   * **one signing implementation reaches every provider there is**, so the day the district
   * moves to KPITB the backup target is a setting rather than another module.
   *
   * `S3_ENDPOINT` is the provider's host — for R2,
   * `https://<account-id>.r2.cloudflarestorage.com`. `S3_REGION` is `auto` for R2 and a real
   * region elsewhere; it is part of the signature, so a wrong value fails to authenticate
   * rather than going somewhere unexpected.
   */
  readonly S3_ENDPOINT?: string | undefined;
  readonly S3_BUCKET?: string | undefined;
  readonly S3_ACCESS_KEY_ID?: string | undefined;
  readonly S3_SECRET_ACCESS_KEY?: string | undefined;
  readonly S3_REGION?: string | undefined;
  readonly BACKUP_PASSPHRASE?: string | undefined;
}

/**
 * Google Cloud Storage, over its plain JSON upload API.
 *
 * No SDK. The whole interaction is one authenticated POST, and a dependency that pulls in a
 * hundred transitive packages to do that is a dependency the district's one technical person
 * has to understand at 02:00.
 */
export function gcsStore(env: OffsiteEnv, http = fetch): OffsiteStore {
  const bucket = env.GCS_BUCKET;
  const token = env.GCS_TOKEN;

  if (bucket === undefined || token === undefined) {
    return {
      name: 'google-cloud-storage',
      configured: false,
      why: 'no bucket or service account yet (R-06) — backups stay in the DC office, so fire, flood or theft takes the record with them',
      put: () => Promise.reject(new Error('offsite storage is not configured')),
      list: () => Promise.resolve([]),
    };
  }

  return {
    name: 'google-cloud-storage',
    configured: true,
    why: null,
    async put(key, bytes): Promise<void> {
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
        bucket,
      )}/o?uploadType=media&name=${encodeURIComponent(key)}`;

      const res = await http(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
        body: new Uint8Array(bytes),
      });

      if (!res.ok) throw new Error(`upload rejected: HTTP ${String(res.status)}`);
    },
    async list(): Promise<readonly { key: string; bytes: number }[]> {
      const res = await http(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`listing rejected: HTTP ${String(res.status)}`);

      const body = (await res.json()) as { items?: { name: string; size: string }[] };
      return (body.items ?? []).map((i) => ({ key: i.name, bytes: Number(i.size) }));
    },
  };
}

//------------------------------------------------------------------------------
// S3-compatible storage — Cloudflare R2 and everything else that speaks S3
//------------------------------------------------------------------------------

/**
 * AWS Signature Version 4, in about forty lines and with no dependency.
 *
 * **Why this is written out rather than pulled from a package.** The AWS SDK is several
 * hundred packages to sign one PUT, and ADR-0007 asks for a stack the district's one technical
 * person can understand at 02:00. This is a documented algorithm with a stable shape: hash the
 * request, hash a string describing it, derive a key from the secret through four HMACs, sign.
 * Nothing here will change under us — SigV4 has been stable for a decade.
 *
 * **The parts that are easy to get wrong, and are therefore spelled out:**
 *
 *   * every header named in `SignedHeaders` must be sent, spelled identically, sorted;
 *   * `x-amz-content-sha256` carries the hash of the **body**, and S3 verifies it — a
 *     mismatch is rejected rather than silently storing something else;
 *   * the path is encoded per segment, so a `/` in a key stays a separator and everything
 *     else is escaped;
 *   * the signing key is derived per **day**, which is why a clock more than fifteen minutes
 *     out fails to authenticate. That is a real failure mode on a fresh VM with no NTP, and
 *     the error it produces says nothing about clocks — see `whyItFailed` below.
 */
export function sign(
  method: 'PUT' | 'GET',
  url: URL,
  body: Buffer,
  credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
    /** `s3` everywhere here. A parameter only so the AWS test vectors can be replayed. */
    readonly service?: string;
  },
  now: Date,
  /**
   * Anything else to sign and send.
   *
   * Exists so that **AWS's own published example can be replayed against this function** — it
   * signs a `Range` header, and a signer that cannot reproduce the spec author's vector is a
   * signer nobody has actually checked. Nothing in this module passes it.
   */
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const service = credentials.service ?? 's3';

  const headers: Record<string, string> = {
    host: url.host,
    ...extraHeaders,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]!}\n`).join('');

  // Per segment: a `/` separates, everything else is escaped. `encodeURIComponent` leaves
  // `!'()*` alone and S3 expects them encoded, hence the second pass.
  const canonicalPath = url.pathname
    .split('/')
    .map((s) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac('sha256', key).update(data).digest();

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), credentials.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

/**
 * Turn a provider's refusal into a sentence somebody in a district office can act on.
 *
 * S3 returns XML nobody reads and a status code that means four different things. Each of
 * these is a real thing that happens on a first setup, and each needs a different fix — which
 * is the same argument the notification ledger makes about `no_channel` versus `no_post`.
 */
function whyItFailed(status: number, bodyText: string): string {
  if (status === 403 && bodyText.includes('RequestTimeTooSkewed')) {
    return "the server's clock is wrong — S3 refuses a request signed more than 15 minutes out. Install NTP (`timedatectl set-ntp true`)";
  }
  if (status === 403) {
    return 'the access key or secret is wrong, or the token has no permission on this bucket';
  }
  if (status === 404)
    return 'no bucket by that name at this endpoint — check S3_BUCKET and S3_ENDPOINT';
  if (status === 301 || status === 307) return 'wrong region for this bucket — check S3_REGION';
  return `HTTP ${String(status)}`;
}

/**
 * S3-compatible off-site storage.
 *
 * Same `OffsiteStore` the rest of the backup path already speaks, so nothing above it changes
 * — which is what that interface was written for (see its own note: *"a district that decides
 * against Google Cloud later is changing one adapter rather than the backup job"*). That
 * sentence was written on 2026-08-03 and this is it being collected.
 */
export function s3Store(
  env: OffsiteEnv,
  http = fetch,
  clock: () => Date = () => new Date(),
): OffsiteStore {
  const endpoint = env.S3_ENDPOINT;
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  const region = env.S3_REGION ?? 'auto';

  if (
    endpoint === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return {
      name: 's3',
      configured: false,
      why: 'no bucket or keys yet (R-06) — backups stay on the same machine as the database, so losing it loses both',
      put: () => Promise.reject(new Error('offsite storage is not configured')),
      list: () => Promise.resolve([]),
    };
  }

  const credentials = { accessKeyId, secretAccessKey, region };
  const base = endpoint.replace(/\/+$/, '');

  return {
    name: 's3',
    configured: true,
    why: null,

    async put(key, bytes): Promise<void> {
      const url = new URL(`${base}/${bucket}/${key}`);
      const headers = sign('PUT', url, bytes, credentials, clock());

      const res = await http(url.toString(), {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      });

      if (!res.ok) {
        throw new Error(
          `upload rejected: ${whyItFailed(res.status, await res.text().catch(() => ''))}`,
        );
      }
    },

    async list(): Promise<readonly { key: string; bytes: number }[]> {
      const url = new URL(`${base}/${bucket}`);
      url.searchParams.set('list-type', '2');

      const headers = sign('GET', url, Buffer.alloc(0), credentials, clock());
      const res = await http(url.toString(), { headers });

      if (!res.ok) {
        throw new Error(
          `listing rejected: ${whyItFailed(res.status, await res.text().catch(() => ''))}`,
        );
      }

      /**
       * Parsed with a regular expression, and that is a deliberate limit rather than laziness.
       *
       * S3 answers in XML and the only two fields anybody here needs are the key and the size.
       * Adding an XML parser to read two tags would be a dependency in the backup path — which
       * is the one path that has to keep working when everything else has stopped.
       *
       * If a provider ever returns something this cannot read, `list` returns fewer entries and
       * the **upload** path is unaffected: listing is used to report what is off-site, never to
       * decide whether to send.
       */
      const xml = await res.text();
      const out: { key: string; bytes: number }[] = [];
      const re =
        /<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g;

      for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
        out.push({ key: decodeXml(m[1]!), bytes: Number(m[2]) });
      }
      return out;
    },
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Whichever store the district has configured.
 *
 * **S3 first when both are set**, because a district that has configured S3 has chosen it —
 * and silently preferring the older one would send backups somewhere nobody expected while
 * every screen said "configured". Neither configured is the honest third answer and is what
 * `/health` reports today.
 */
export function offsiteStore(env: OffsiteEnv, http = fetch): OffsiteStore {
  if (env.S3_BUCKET !== undefined) return s3Store(env, http);
  return gcsStore(env, http);
}

//------------------------------------------------------------------------------
// The upload
//------------------------------------------------------------------------------

export interface UploadResult {
  readonly ok: boolean;
  readonly key?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly skipped?: string;
  readonly error?: string;
}

/**
 * Encrypt a verified dump and put it off-site.
 *
 * **`skipped` is not `ok`.** A district with no bucket yet gets `{ ok: false, skipped }`, and
 * the ledger records it as not uploaded — because "we did not try" and "we tried and it
 * worked" must never render the same on a screen somebody uses to decide whether the record
 * is safe.
 */
export async function uploadDump(
  pool: Pool,
  backupRunId: string,
  dumpPath: string,
  store: OffsiteStore,
  env: OffsiteEnv,
): Promise<UploadResult> {
  const passphrase = env.BACKUP_PASSPHRASE;

  const note = async (result: UploadResult): Promise<UploadResult> => {
    await pool.query(
      `UPDATE backup_run
          SET offsite_key = $2, offsite_at = $3, offsite_error = $4
        WHERE backup_run_id = $1`,
      [
        backupRunId,
        result.key ?? null,
        result.ok ? new Date().toISOString() : null,
        result.ok ? null : (result.error ?? result.skipped ?? 'not attempted'),
      ],
    );
    return result;
  };

  if (!store.configured) {
    return note({ ok: false, skipped: store.why ?? 'offsite storage is not configured' });
  }
  if (passphrase === undefined || passphrase.length < 16) {
    // Refused rather than uploaded in the clear. A dump holds every reporter's number in
    // the district, and "we will encrypt it later" is how it leaves unencrypted forever.
    return note({
      ok: false,
      skipped:
        'no BACKUP_PASSPHRASE of at least 16 characters — refusing to send the district’s record out unencrypted',
    });
  }

  try {
    const plaintext = await readFile(dumpPath);
    const encrypted = encryptDump(plaintext, passphrase);
    const key = `${basename(dumpPath)}.enc`;

    await store.put(key, encrypted);

    return await note({
      ok: true,
      key,
      bytes: encrypted.length,
      // The hash of what was actually sent, so the copy in the bucket can be checked against
      // the ledger without downloading and decrypting it first.
      sha256: createHash('sha256').update(encrypted).digest('hex'),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Loud. A silent upload failure buys a year of false confidence.
    log('error', 'off-site backup upload failed', { backupRunId, error });
    return note({ ok: false, error });
  }
}
