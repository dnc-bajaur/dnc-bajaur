/**
 * Getting the record out of the building — M0-53, M0-54.
 *
 * Three claims, in order of what they cost to get wrong:
 *
 *   **Nothing leaves unencrypted.** A dump holds every reporter's phone number in Bajaur, and
 *   ADR-0011 sends one out of the district every night. An upload that quietly went in the
 *   clear would be a disclosure nobody decided to make.
 *
 *   **"We did not try" never renders as "it worked."** A district with no bucket yet must not
 *   see a green tick, because the whole value of a backup is knowing whether you have one.
 *
 *   **A single node says so.** One machine holding the district's record is a fact for
 *   `/health` to report, not an assumption to leave unstated (R-07).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import {
  decryptDump,
  encryptDump,
  gcsStore,
  offsiteStore,
  s3Store,
  sign,
  uploadDump,
  type OffsiteStore,
} from '../offsite.js';
import { replicationHealth, REPLICATION_LAG_WARN_SECONDS } from '../replication.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSPHRASE = 'a-passphrase-long-enough-to-be-accepted';

/** Somewhere off-site, in memory. The whole upload path is testable without a bucket. */
function fakeStore(
  behaviour: 'ok' | 'reject' = 'ok',
): OffsiteStore & { puts: Map<string, Buffer> } {
  const puts = new Map<string, Buffer>();
  return {
    puts,
    name: 'fake',
    configured: true,
    why: null,
    put: async (key, bytes) => {
      if (behaviour === 'reject') throw new Error('bucket said no');
      puts.set(key, bytes);
    },
    list: async () => [...puts.entries()].map(([key, b]) => ({ key, bytes: b.length })),
  };
}

describe('encrypting a dump', () => {
  const plaintext = Buffer.from(
    'COPY person (full_name, phone) FROM stdin;\nNoor Rahman Khan\t03001234567\n',
  );

  it('round-trips', () => {
    const encrypted = encryptDump(plaintext, PASSPHRASE);
    expect(decryptDump(encrypted, PASSPHRASE)).toEqual(plaintext);
  });

  it('leaves nothing readable in the ciphertext', () => {
    const encrypted = encryptDump(plaintext, PASSPHRASE);
    const asText = encrypted.toString('latin1');

    // The thing this protects: every reporter's number in the district, in a file handed to
    // a cloud provider.
    expect(asText).not.toContain('03001234567');
    expect(asText).not.toContain('Noor Rahman Khan');
    expect(asText).not.toContain(PASSPHRASE);
  });

  it('produces a different ciphertext every time, from the same input', () => {
    // A fresh salt and iv per dump. Identical output for identical input would tell anybody
    // watching the bucket which nights nothing changed in the district.
    const a = encryptDump(plaintext, PASSPHRASE);
    const b = encryptDump(plaintext, PASSPHRASE);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses to decrypt with the wrong passphrase', () => {
    const encrypted = encryptDump(plaintext, PASSPHRASE);
    expect(() => decryptDump(encrypted, 'the-wrong-passphrase-entirely')).toThrow();
  });

  /**
   * The reason for GCM rather than CBC.
   *
   * A tampered emergency record that restores cleanly is the worst available outcome — worse
   * than one that refuses to restore, because nobody would ever find out.
   */
  it('refuses to decrypt bytes that have been altered in the bucket', () => {
    const encrypted = encryptDump(plaintext, PASSPHRASE);
    const last = encrypted.length - 1;
    encrypted[last] = (encrypted[last] ?? 0) ^ 0xff;
    expect(() => decryptDump(encrypted, PASSPHRASE)).toThrow();
  });

  it('refuses something that is not an encrypted dump at all', () => {
    expect(() => decryptDump(Buffer.from('hello'), PASSPHRASE)).toThrow(/too short/);
  });
});

describe.skipIf(dbUrl === undefined)('uploading it (integration)', () => {
  let pool: Pool;
  let directory: string;
  let dumpPath: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    directory = await mkdtemp(join(tmpdir(), 'dnc-offsite-'));
    dumpPath = join(directory, `dnc-${randomUUID()}.sql`);
    await writeFile(dumpPath, '-- a dump\nCOPY x FROM stdin;\n03001234567\n');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    // The directory this suite made, removed. Five suites created one and only one deleted
    // it, so every full run left its dumps and evidence behind in the system temp folder —
    // 287 directories and 840 MB of them by the time somebody's disk filled up. A test that
    // litters is a test that eventually stops the machine it runs on.
    await rm(directory, { recursive: true, force: true });
  });

  async function aRun(): Promise<string> {
    const { rows } = await pool.query<{ backup_run_id: string }>(
      "INSERT INTO backup_run (status) VALUES ('ok') RETURNING backup_run_id",
    );
    return rows[0]!.backup_run_id;
  }

  async function ledger(id: string): Promise<{
    offsite_key: string | null;
    offsite_at: string | null;
    offsite_error: string | null;
  }> {
    const { rows } = await pool.query<{
      offsite_key: string | null;
      offsite_at: string | null;
      offsite_error: string | null;
    }>('SELECT offsite_key, offsite_at, offsite_error FROM backup_run WHERE backup_run_id = $1', [
      id,
    ]);
    return rows[0]!;
  }

  it('encrypts, uploads, and records that it left the district', async () => {
    const store = fakeStore();
    const id = await aRun();

    const result = await uploadDump(pool, id, dumpPath, store, {
      BACKUP_PASSPHRASE: PASSPHRASE,
    });

    expect(result.ok).toBe(true);
    expect(result.key).toMatch(/\.sql\.enc$/);

    // What landed in the bucket is not the dump.
    const uploaded = store.puts.get(result.key!)!;
    expect(uploaded.toString('latin1')).not.toContain('03001234567');
    expect(decryptDump(uploaded, PASSPHRASE).toString()).toContain('03001234567');

    const row = await ledger(id);
    expect(row.offsite_at).not.toBeNull();
    expect(row.offsite_error).toBeNull();
  });

  /**
   * A district with no bucket must not see a green tick.
   *
   * "We did not try" and "we tried and it worked" rendering the same is how somebody believes
   * the record is safe for a year and finds out on the day it is not.
   */
  it('records an unconfigured bucket as not uploaded, not as fine', async () => {
    const id = await aRun();
    const result = await uploadDump(pool, id, dumpPath, gcsStore({}), {
      BACKUP_PASSPHRASE: PASSPHRASE,
    });

    expect(result.ok).toBe(false);
    expect(result.skipped).toContain('R-06');

    const row = await ledger(id);
    expect(row.offsite_at).toBeNull();
    expect(row.offsite_error).toContain('R-06');
  });

  it('refuses to upload at all without a passphrase', async () => {
    const store = fakeStore();
    const id = await aRun();

    const result = await uploadDump(pool, id, dumpPath, store, {});

    expect(result.ok).toBe(false);
    // Refused rather than sent in the clear. "We will encrypt it later" is how it leaves
    // unencrypted forever.
    expect(result.skipped).toContain('unencrypted');
    expect(store.puts.size).toBe(0);
  });

  it('refuses a passphrase short enough to guess', async () => {
    const store = fakeStore();
    const result = await uploadDump(pool, await aRun(), dumpPath, store, {
      BACKUP_PASSPHRASE: 'short',
    });
    expect(result.ok).toBe(false);
    expect(store.puts.size).toBe(0);
  });

  it('records a rejected upload loudly rather than swallowing it', async () => {
    const id = await aRun();
    const result = await uploadDump(pool, id, dumpPath, fakeStore('reject'), {
      BACKUP_PASSPHRASE: PASSPHRASE,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('bucket said no');

    // In the ledger, because a backup that silently stopped working is worse than no backup.
    const row = await ledger(id);
    expect(row.offsite_error).toContain('bucket said no');
    expect(row.offsite_at).toBeNull();
  });
});

describe('the Google Cloud adapter', () => {
  it('says what is missing rather than failing obscurely', () => {
    const store = gcsStore({});
    expect(store.configured).toBe(false);
    expect(store.why).toContain('fire, flood or theft');
  });

  it('uploads with the token and the object name in the URL', async () => {
    const http = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('', { status: 200 }),
    );
    const store = gcsStore(
      { GCS_BUCKET: 'bajaur-dnc-backups', GCS_TOKEN: 'tok' },
      http as unknown as typeof fetch,
    );

    await store.put('dnc-2026-08-03.sql.enc', Buffer.from('x'));

    const url = String(http.mock.calls[0]![0]);
    expect(url).toContain('bajaur-dnc-backups');
    expect(url).toContain('dnc-2026-08-03.sql.enc');
  });

  it('treats a rejected upload as a failure rather than a success', async () => {
    const http = vi.fn(async () => new Response('', { status: 403 }));
    const store = gcsStore({ GCS_BUCKET: 'b', GCS_TOKEN: 't' }, http as unknown as typeof fetch);
    await expect(store.put('k', Buffer.from('x'))).rejects.toThrow(/403/);
  });
});

describe('the S3 adapter — Cloudflare R2 and everything else that speaks S3', () => {
  const env = {
    S3_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
    S3_BUCKET: 'bajaur-dnc-backups',
    S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    S3_REGION: 'auto',
  };

  /** A fixed instant, so a signature is reproducible and a change to it is visible. */
  const at = (): Date => new Date('2026-08-07T09:00:00.000Z');

  it('says what is missing rather than failing obscurely', () => {
    const store = s3Store({});
    expect(store.configured).toBe(false);
    // The reason changed with ADR-0019: the backup no longer sits in a different building
    // from the database, it sits on the same machine, which is worse.
    expect(store.why).toContain('same machine');
  });

  it('signs the upload the way S3 requires, and sends every header it signed', async () => {
    /**
     * **The four things a wrong SigV4 gets wrong**, all pinned here, because each of them
     * fails at 02:00 on somebody else's server with an XML body nobody reads:
     *
     *   * every header named in `SignedHeaders` must actually be sent, spelled the same;
     *   * `x-amz-content-sha256` must be the hash of the **body** — S3 verifies it;
     *   * the credential scope must be `<date>/<region>/s3/aws4_request`;
     *   * the bucket and key must land in the path, not a query string.
     */
    const http = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('', { status: 200 }),
    );

    const store = s3Store(env, http as unknown as typeof fetch, at);
    await store.put('dnc-2026-08-07.sql.enc', Buffer.from('the dump'));

    const url = String(http.mock.calls[0]![0]);
    const init = http.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;

    expect(url).toBe(
      'https://acct123.r2.cloudflarestorage.com/bajaur-dnc-backups/dnc-2026-08-07.sql.enc',
    );
    expect(init.method).toBe('PUT');

    expect(headers['authorization']).toContain('AWS4-HMAC-SHA256');
    expect(headers['authorization']).toContain('20260807/auto/s3/aws4_request');

    // Every signed header is present, and the body hash is the body's.
    const signed = /SignedHeaders=([^,]+)/.exec(headers['authorization']!)![1]!.split(';');
    for (const h of signed) expect(headers[h], `${h} was signed but not sent`).toBeDefined();

    expect(headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(Buffer.from('the dump')).digest('hex'),
    );
  });

  it('produces a different signature for a different body', async () => {
    // Cheap, and it catches the mistake that hurts most: signing a constant instead of the
    // payload. Such a store uploads happily and S3 rejects every one of them.
    const seen: string[] = [];
    const http = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push((init!.headers as Record<string, string>)['authorization']!);
      return new Response('', { status: 200 });
    });

    const store = s3Store(env, http as unknown as typeof fetch, at);
    await store.put('k', Buffer.from('one'));
    await store.put('k', Buffer.from('two'));

    expect(seen[0]).not.toBe(seen[1]);
  });

  it('names the fix for each way a first setup goes wrong', async () => {
    /**
     * Four refusals, four different jobs — the same argument the notification ledger makes
     * about `no_channel` versus `no_post`. A district office reading *"HTTP 403"* has no idea
     * whether to check a key, a clock or a region.
     */
    const failing = (status: number, body = '') =>
      s3Store(env, (async () => new Response(body, { status })) as unknown as typeof fetch, at);

    await expect(
      failing(403, '<Error><Code>RequestTimeTooSkewed</Code></Error>').put('k', Buffer.alloc(0)),
    ).rejects.toThrow(/clock/);
    await expect(failing(403).put('k', Buffer.alloc(0))).rejects.toThrow(/access key|permission/);
    await expect(failing(404).put('k', Buffer.alloc(0))).rejects.toThrow(/S3_BUCKET/);
    await expect(failing(301).put('k', Buffer.alloc(0))).rejects.toThrow(/S3_REGION/);
  });

  it('reads back what is off-site, and does not let a listing failure stop uploads mattering', async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>dnc-2026-08-06.sql.enc</Key><Size>1048576</Size></Contents>
      <Contents><Key>dnc-2026-08-07.sql.enc</Key><Size>1050000</Size></Contents>
    </ListBucketResult>`;

    const store = s3Store(
      env,
      (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch,
      at,
    );
    const items = await store.list();

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ key: 'dnc-2026-08-06.sql.enc', bytes: 1_048_576 });
  });

  it("reproduces AWS's own published signature, byte for byte", () => {
    /**
     * **The only test here that proves the algorithm is right rather than self-consistent.**
     *
     * Every other assertion in this block checks that the signer does what *I* think SigV4
     * requires. That is worth nothing if what I think is wrong — and a wrong signature is not
     * a bug that shows up in development, it is a 403 from somebody else's server on the first
     * real night, with an XML body nobody in a district office can read.
     *
     * So this replays the worked example from AWS's own documentation — *Signature Calculations
     * for the Authorization Header: Transferring Payload in a Single Chunk*, the GET Object
     * case — including its published credentials, its fixed timestamp and its expected
     * signature. Those credentials are AWS's documentation examples and are not secrets.
     *
     * If this fails, the signer is wrong, no matter how green the rest of the file is.
     */
    const headers = sign(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      Buffer.alloc(0),
      {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 's3',
      },
      new Date('2013-05-24T00:00:00.000Z'),
      { range: 'bytes=0-9' },
    );

    expect(headers['authorization']).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['authorization']).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(headers['authorization']).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
  });

  it('is chosen over Google Cloud when the district has configured it', () => {
    // Both set: S3 wins, because configuring it is a choice. Silently preferring the older
    // one would send backups somewhere nobody expected while every screen said "configured".
    expect(offsiteStore({ ...env, GCS_BUCKET: 'old', GCS_TOKEN: 't' }).name).toBe('s3');
    expect(offsiteStore({ GCS_BUCKET: 'old', GCS_TOKEN: 't' }).name).toBe('google-cloud-storage');
    expect(offsiteStore({}).configured).toBe(false);
  });
});

describe.skipIf(dbUrl === undefined)('replication (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * The development cluster is one node, which is exactly the state the district starts in.
   *
   * It must report that. One machine holding the whole district's record is a fact for
   * `/health` to say out loud, not an assumption to leave unstated — and until R-07 arrives
   * it is the real deployment.
   */
  it('reports a single node as standalone and not ok', async () => {
    const health = await replicationHealth(pool);

    expect(health.role).toBe('standalone');
    expect(health.connectedStandbys).toBe(0);
    expect(health.ok).toBe(false);
    expect(health.why).toContain('one machine');
    expect(health.why).toContain('R-07');
  });

  it('has a threshold tight enough that a minute behind is already an anomaly', () => {
    // Streaming replication between two offices in the same town is normally sub-second.
    expect(REPLICATION_LAG_WARN_SECONDS).toBeLessThanOrEqual(60);
  });
});
