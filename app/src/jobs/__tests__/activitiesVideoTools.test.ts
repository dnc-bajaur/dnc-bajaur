/**
 * The real ffmpeg, with the converter's own arguments (ADR-0039 §4, Bajaur — C3).
 *
 * `activitiesVideo.test.ts` proves the upload and the bookkeeping with stand-in tools; this
 * proves the part only ffmpeg can judge — that the arguments make what the ADR says:
 *
 *   * a landscape 1080p video becomes 1280×720, an upright one 720×1280 — never enlarged;
 *   * H.264 video and AAC sound in an MP4 whose index comes first, so a phone starts playing
 *     before the whole file has arrived;
 *   * a JPEG poster frame, its long edge 480;
 *   * a file with no picture, or no video at all, is an ordinary failure — and a missing
 *     ffmpeg is `ToolMissing`, which the converter treats as "wait", never as "failed".
 *
 * Skipped on a developer's machine without ffmpeg — **never in CI**: there the workflow installs
 * it, and a missing one fails the run, as a missing database does (`testing/loadEnv.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolMissing, ffmpegTools } from '../activitiesVideo.js';

const env = { FFMPEG_PATH: process.env['FFMPEG_PATH'], FFPROBE_PATH: process.env['FFPROBE_PATH'] };
const ffmpeg = env.FFMPEG_PATH?.trim() || 'ffmpeg';
const ffprobe = env.FFPROBE_PATH?.trim() || 'ffprobe';

function available(): boolean {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    execFileSync(ffprobe, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const present = available();
if (!present && process.env['CI'] !== undefined) {
  throw new Error(
    'ffmpeg is not installed and CI is set. The workflow installs it; without it the Activities ' +
      'video converter would ship untested.',
  );
}

interface Probed {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
}

function probe(path: string): Probed {
  return JSON.parse(
    execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  ) as Probed;
}

/** A short test card with a tone, made by ffmpeg itself. */
function sample(path: string, width: number, height: number, seconds = 2): void {
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${width}x${height}:rate=25:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ],
    { stdio: 'ignore' },
  );
}

(present ? describe : describe.skip)('the converter’s ffmpeg arguments', () => {
  const tools = ffmpegTools(env);
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dnc-bajaur-ffmpeg-'));
    sample(join(dir, 'landscape.mp4'), 1920, 1080);
    sample(join(dir, 'upright.mp4'), 1080, 1920);
    sample(join(dir, 'small.mp4'), 640, 360);
  }, 120_000);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the length', async () => {
    const { durationSeconds } = await tools.probe(join(dir, 'landscape.mp4'));
    expect(durationSeconds).toBeGreaterThan(1.5);
    expect(durationSeconds).toBeLessThan(2.5);
  });

  it('makes 720p H.264 + AAC, index first, in both orientations, never enlarged', async () => {
    for (const [name, width, height] of [
      ['landscape', 1280, 720],
      ['upright', 720, 1280],
      ['small', 640, 360],
    ] as const) {
      const out = join(dir, `${name}.out.mp4`);
      await tools.convert(join(dir, `${name}.mp4`), out);
      const streams = probe(out).streams;
      const video = streams.find((s) => s.codec_type === 'video')!;
      const audio = streams.find((s) => s.codec_type === 'audio')!;
      expect({ name, codec: video.codec_name, width: video.width, height: video.height }).toEqual({
        name,
        codec: 'h264',
        width,
        height,
      });
      expect(audio.codec_name).toBe('aac');
      // `+faststart`: the index (`moov`) is before the pictures (`mdat`).
      const bytes = readFileSync(out).toString('latin1');
      expect(bytes.indexOf('moov')).toBeGreaterThan(0);
      expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
    }
  }, 120_000);

  it('makes a JPEG poster with a 480 px long edge', async () => {
    const out = join(dir, 'poster.jpg');
    await tools.poster(join(dir, 'upright.mp4'), out, 1);
    const bytes = readFileSync(out);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const video = probe(out).streams[0]!;
    expect({ width: video.width, height: video.height }).toEqual({ width: 270, height: 480 });
  }, 60_000);

  it('fails a file with no picture, or no video at all — as a failure, not a missing tool', async () => {
    const tone = join(dir, 'tone.m4a');
    execFileSync(
      ffmpeg,
      ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', tone],
      { stdio: 'ignore' },
    );
    await expect(tools.probe(tone)).rejects.toThrow(/no picture/);

    const junk = join(dir, 'junk.mp4');
    writeFileSync(junk, Buffer.alloc(4096, 7));
    const refused = await tools.probe(junk).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(ToolMissing);
  }, 60_000);
});

describe('a missing ffmpeg', () => {
  it('is ToolMissing, so the converter waits instead of failing the video', async () => {
    const none = ffmpegTools({
      FFMPEG_PATH: 'dnc-bajaur-no-such-ffmpeg',
      FFPROBE_PATH: 'dnc-bajaur-no-such-ffprobe',
    });
    await expect(none.probe('x.mp4')).rejects.toBeInstanceOf(ToolMissing);
    await expect(none.convert('x.mp4', 'y.mp4')).rejects.toBeInstanceOf(ToolMissing);
  });
});
