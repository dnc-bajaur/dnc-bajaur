/**
 * Activities videos — the converter (ADR-0039 §4, Bajaur — phase C3).
 *
 * A video arrives as the phone recorded it: often 1080p or 4K, HEVC on an iPhone, tens or
 * hundreds of megabytes. This turns each one into **720p H.264 with AAC sound in an MP4** —
 * what every phone and browser plays — plus a small poster frame for the list, and deletes the
 * original. Only the converted file is ever shown, zipped or backed up.
 *
 * **One at a time.** ffmpeg uses every core it is given, and the server also runs the control
 * room. One process converts (an advisory lock of its own), one video after another; a video
 * that arrives while it works waits its turn. Each conversion has a time limit, so a file that
 * makes ffmpeg hang becomes *failed* rather than a converter that never moves again.
 *
 * **Nothing fails silently** (ADR-0039 "We must therefore also"):
 *
 *   * a video ffmpeg refuses, or one longer than three minutes, is marked **failed** with the
 *     reason, logged as `video_failed`, and listed by `npm run doctor`; the post says so;
 *   * if ffmpeg is **not installed**, nothing is marked failed — the video is not at fault, and
 *     it converts the moment ffmpeg is there. It waits as *processing*; the server's journal says
 *     why at error level, and `doctor` and the DC's Activities warning both show it waiting.
 *
 * **Restart-safe.** The status is in the database and the original stays on disk until the
 * converted file has replaced it, so a server restarted mid-conversion simply converts that
 * video again. Output is written beside the target as `.part` and renamed into place, so a
 * half-written MP4 is never served.
 *
 * Not part of the emergency path: its own timer and its own lock, and it touches nothing but
 * `activity_media` and `activity_log`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';

import type { Pool } from '../db/pool.js';
import { log } from '../obs/log.js';
import { MAX_VIDEO_SECONDS, inside } from '../api/activities.js';

/** Fixed, and distinct from the scheduler's and the housekeeping's (`activitiesRetention.ts`). */
const VIDEO_LOCK_KEY = 4_112_040;

/** The timed pass, for a video whose wake-up was missed (a restart, another process). */
const CHECK_INTERVAL_MS = 60_000;

/** How long one conversion may take before it is called a failure. */
const CONVERT_TIMEOUT_MS = 20 * 60_000;

/** The long edge of the poster frame, matching a photo's thumbnail. */
const POSTER_EDGE = 480;

/** ffmpeg (or ffprobe) is not on this machine — the server's fault, never the video's. */
export class ToolMissing extends Error {}

/** The three things the converter asks of ffmpeg. A test passes its own. */
export interface VideoTools {
  /** The length in seconds; throws if the file has no video in it. */
  probe(input: string): Promise<{ readonly durationSeconds: number }>;
  /** 720p H.264 + AAC, MP4, ready to play before it has fully downloaded. */
  convert(input: string, output: string): Promise<void>;
  /** One JPEG frame, its long edge 480 px. */
  poster(video: string, output: string, atSeconds: number): Promise<void>;
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new ToolMissing(`${file} is not installed on this server`));
        }
        if (error.killed)
          return reject(new Error(`took longer than ${timeoutMs / 60_000} minutes`));
        // The last line ffmpeg wrote is the one that says what was wrong.
        const last = stderr.trim().split(/\r?\n/).at(-1)?.trim();
        reject(new Error(last !== undefined && last !== '' ? last : error.message));
      },
    );
  });
}

/**
 * The real tools. `FFMPEG_PATH` / `FFPROBE_PATH` name them where they are not on the PATH (a
 * Windows office machine); otherwise `ffmpeg` and `ffprobe` are found the usual way.
 */
export function ffmpegTools(env: {
  readonly FFMPEG_PATH?: string | undefined;
  readonly FFPROBE_PATH?: string | undefined;
}): VideoTools {
  const ffmpeg = env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const ffprobe = env.FFPROBE_PATH?.trim() || 'ffprobe';
  return {
    async probe(input) {
      const out = await run(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_type:format=duration',
          '-of',
          'json',
          input,
        ],
        60_000,
      );
      const parsed = JSON.parse(out) as {
        streams?: { codec_type?: string }[];
        format?: { duration?: string };
      };
      if (!(parsed.streams ?? []).some((s) => s.codec_type === 'video')) {
        throw new Error('there is no picture in this file');
      }
      const seconds = Number(parsed.format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('the length of this video cannot be read');
      }
      return { durationSeconds: seconds };
    },
    async convert(input, output) {
      // The short edge becomes 720 (never enlarged), so an upright phone video is 720 wide —
      // "720p" the way a phone means it. Even sizes, because H.264 in 4:2:0 needs them.
      const scale =
        "scale=w='if(gte(iw,ih),-2,min(720,trunc(iw/2)*2))'" +
        ":h='if(gte(iw,ih),min(720,trunc(ih/2)*2),-2)',format=yuv420p";
      await run(
        ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-y',
          '-i',
          input,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          scale,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          // A last guard on the length: never more than three minutes and a second is kept.
          '-t',
          String(MAX_VIDEO_SECONDS + 1),
          '-f',
          'mp4',
          output,
        ],
        CONVERT_TIMEOUT_MS,
      );
    },
    async poster(video, output, atSeconds) {
      const scale =
        `scale=w='if(gte(iw,ih),min(${POSTER_EDGE},iw),-2)'` +
        `:h='if(gte(iw,ih),-2,min(${POSTER_EDGE},ih))'`;
      await run(
        ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          atSeconds.toFixed(2),
          '-i',
          video,
          '-frames:v',
          '1',
          '-vf',
          scale,
          '-q:v',
          '4',
          '-f',
          'mjpeg',
          output,
        ],
        60_000,
      );
    },
  };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function minutes(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type ConvertOutcome = 'converted' | 'failed' | 'gone';

interface Waiting {
  media_id: string;
  post_id: string;
  stored_path: string;
  upload_path: string;
}

async function markFailed(pool: Pool, root: string, v: Waiting, reason: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE activity_media
        SET status = 'failed', failure = $2, upload_path = NULL, received_bytes = NULL,
            status_at = now()
      WHERE media_id = $1 AND status = 'processing'`,
    [v.media_id, reason],
  );
  await rm(inside(root, v.upload_path), { force: true }).catch(() => {});
  if (res.rowCount === 0) return false;
  await pool.query(
    `INSERT INTO activity_log (type, actor_person_id, post_id, detail)
     VALUES ('video_failed', NULL, $1, $2)`,
    [v.post_id, JSON.stringify({ mediaId: v.media_id, reason })],
  );
  log('error', 'an Activities video could not be converted', {
    mediaId: v.media_id,
    reason,
  });
  return true;
}

/**
 * Convert one video. A `ToolMissing` is thrown on, untouched: the video waits for ffmpeg.
 */
async function convertOne(
  pool: Pool,
  root: string,
  tools: VideoTools,
  v: Waiting,
): Promise<ConvertOutcome> {
  const input = inside(root, v.upload_path);
  const output = inside(root, v.stored_path);
  const posterRelative = v.stored_path.replace(/\.mp4$/, '.poster.jpg');
  const poster = inside(root, posterRelative);
  const outputPart = `${output}.part`;
  const posterPart = `${poster}.part`;
  const cleanUp = async (): Promise<void> => {
    for (const p of [outputPart, posterPart]) await rm(p, { force: true }).catch(() => {});
  };

  let seconds: number;
  try {
    seconds = (await tools.probe(input)).durationSeconds;
    if (seconds > MAX_VIDEO_SECONDS + 1) {
      return (await markFailed(
        pool,
        root,
        v,
        `it is ${minutes(seconds)} long; videos may be at most 3 minutes`,
      ))
        ? 'failed'
        : 'gone';
    }
    await tools.convert(input, outputPart);
  } catch (e) {
    await cleanUp();
    if (e instanceof ToolMissing) throw e;
    const reason = `ffmpeg could not convert it: ${e instanceof Error ? e.message : String(e)}`;
    return (await markFailed(pool, root, v, reason.slice(0, 500))) ? 'failed' : 'gone';
  }

  // The poster is a convenience: without one the list shows a plain play button.
  let hasPoster = true;
  try {
    await tools.poster(outputPart, posterPart, Math.min(1, seconds / 2));
  } catch (e) {
    if (e instanceof ToolMissing) {
      await cleanUp();
      throw e;
    }
    hasPoster = false;
    log('warn', 'no poster frame for an Activities video', {
      mediaId: v.media_id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  let size: number;
  let sha256: string;
  try {
    size = (await stat(outputPart)).size;
    sha256 = await sha256Of(outputPart);
    await rename(outputPart, output);
    if (hasPoster) await rename(posterPart, poster);
  } catch {
    // The post was deleted while ffmpeg ran: its folder, and the files in it, are gone.
    await cleanUp();
    return 'gone';
  }

  const done = await pool.query(
    `UPDATE activity_media
        SET status = 'ready', content_type = 'video/mp4', byte_size = $2, sha256 = $3,
            thumb_path = $4, duration_seconds = $5, upload_path = NULL, received_bytes = NULL,
            failure = NULL, status_at = now()
      WHERE media_id = $1 AND status = 'processing'`,
    [v.media_id, size, sha256, hasPoster ? posterRelative : null, Math.round(seconds * 100) / 100],
  );
  if (done.rowCount === 0) {
    // Deleted while it was converting: what was just written belongs to nobody.
    await rm(output, { force: true }).catch(() => {});
    await rm(poster, { force: true }).catch(() => {});
    return 'gone';
  }
  await rm(input, { force: true }).catch(() => {});
  return 'converted';
}

export interface ConvertPass {
  /** False when another process held the lock — a normal outcome. */
  readonly ran: boolean;
  readonly converted: number;
  readonly failed: number;
  /** Set when ffmpeg is missing: the videos wait, and this says why. */
  readonly waiting?: string;
}

/** Convert every waiting video, oldest first, under the lock. Exposed for tests and `tick`. */
export async function runConversions(options: {
  readonly pool: Pool;
  readonly root: string;
  readonly tools: VideoTools;
}): Promise<ConvertPass> {
  const { pool, root, tools } = options;
  const client = await pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [VIDEO_LOCK_KEY],
    );
    if (got.rows[0]?.locked !== true) return { ran: false, converted: 0, failed: 0 };
    try {
      let converted = 0;
      let failed = 0;
      const tried = new Set<string>();
      for (;;) {
        const next = await pool.query<Waiting>(
          `SELECT media_id, post_id, stored_path, upload_path FROM activity_media
            WHERE status = 'processing' AND upload_path IS NOT NULL
              AND NOT (media_id = ANY($1::uuid[]))
            ORDER BY status_at, media_id LIMIT 1`,
          [[...tried]],
        );
        const v = next.rows[0];
        if (v === undefined) break;
        tried.add(v.media_id);
        try {
          const outcome = await convertOne(pool, root, tools, v);
          if (outcome === 'converted') converted += 1;
          if (outcome === 'failed') failed += 1;
        } catch (e) {
          if (e instanceof ToolMissing) return { ran: true, converted, failed, waiting: e.message };
          throw e;
        }
      }
      return { ran: true, converted, failed };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [VIDEO_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export interface VideoConverter {
  start(): void;
  stop(): void;
  /** Convert now — called when the last byte of a video arrives. */
  kick(): void;
  tick(): Promise<ConvertPass | null>;
}

export function createVideoConverter(options: {
  readonly pool: Pool;
  readonly root: string;
  readonly tools: VideoTools;
  readonly intervalMs?: number;
}): VideoConverter {
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  let saidMissing = false;

  async function tick(): Promise<ConvertPass | null> {
    if (running) {
      // A video arrived while a pass was converting another: run once more when it ends.
      again = true;
      return null;
    }
    running = true;
    try {
      let pass: ConvertPass;
      do {
        again = false;
        pass = await runConversions(options);
        if (pass.converted > 0 || pass.failed > 0) {
          log('info', 'Activities videos converted', { ...pass });
        }
        if (pass.waiting !== undefined) {
          // Once per outage, not every minute: the journal should say it, not drown in it.
          if (!saidMissing) {
            log('error', 'Activities videos are waiting: ffmpeg is not available', {
              why: pass.waiting,
            });
          }
          saidMissing = true;
          again = false;
        } else {
          saidMissing = false;
        }
      } while (again);
      return pass;
    } catch (err) {
      // A failed pass must never stop the timer; the next one tries again.
      log('error', 'the Activities video converter threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      // Whatever was waiting when the server stopped is converted now, not in a minute.
      void tick();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    kick(): void {
      void tick();
    },
    tick,
  };
}
