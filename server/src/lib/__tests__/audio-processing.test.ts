import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { _parseLoudnormJson, processAudio } from "../derivatives";
import { DATA_DIR } from "../store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// --- parseLoudnormJson (pure logic) ---

describe("parseLoudnormJson", () => {
  test("extracts measurement from typical ffmpeg stderr", () => {
    const stderr = `
[Parsed_loudnorm_2 @ 0x600003c44000]
{
	"input_i" : "-21.75",
	"input_tp" : "-18.06",
	"input_lra" : "0.30",
	"input_thresh" : "-31.75",
	"output_i" : "-14.05",
	"output_tp" : "-10.31",
	"output_lra" : "0.00",
	"output_thresh" : "-24.05",
	"normalization_type" : "linear",
	"target_offset" : "0.05"
}
`;
    const result = _parseLoudnormJson(stderr);
    expect(result.input_i).toBe("-21.75");
    expect(result.input_tp).toBe("-18.06");
    expect(result.input_lra).toBe("0.30");
    expect(result.input_thresh).toBe("-31.75");
    expect(result.target_offset).toBe("0.05");
  });

  test("throws on missing JSON", () => {
    expect(() => _parseLoudnormJson("no json here")).toThrow("No loudnorm JSON found");
  });

  test("throws on incomplete JSON", () => {
    const stderr = '{ "input_i": "-20" }';
    expect(() => _parseLoudnormJson(stderr)).toThrow('Missing "input_tp"');
  });
});

// --- End-to-end audio processing ---

// Generate a test source.mp4 with a sine tone + video
async function generateTestSource(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, "source.mp4");
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=320x240:rate=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3:sample_rate=48000",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outPath,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`fixture generation failed: ${stderr}`);
  return outPath;
}

// Measure the integrated loudness of a file using ffmpeg loudnorm in measure mode
async function measureLUFS(filePath: string): Promise<number> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-i",
      filePath,
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`LUFS measurement failed: ${stderr}`);

  const lastBrace = stderr.lastIndexOf("}");
  const firstBrace = stderr.lastIndexOf("{", lastBrace);
  const json = JSON.parse(stderr.substring(firstBrace, lastBrace + 1)) as { input_i: string };
  return Number.parseFloat(json.input_i);
}

describe("processAudio (end-to-end)", () => {
  test.skipIf(!ffmpegAvailable)(
    "processes audio and output LUFS is within ±1 of -14",
    async () => {
      const dir = join(DATA_DIR, "test-audio");
      const sourcePath = await generateTestSource(dir);

      const sizeBefore = Bun.file(sourcePath).size;

      await processAudio(sourcePath);

      // File should exist and be different (re-encoded audio).
      const sizeAfter = Bun.file(sourcePath).size;
      expect(sizeAfter).toBeGreaterThan(0);
      // Size will differ because audio was re-encoded at 160k vs 64k.
      expect(sizeAfter).not.toBe(sizeBefore);

      // Verify output loudness is within ±1 LU of target (-14 LUFS).
      const lufs = await measureLUFS(sourcePath);
      expect(lufs).toBeGreaterThan(-15);
      expect(lufs).toBeLessThan(-13);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "preserves video track (dimensions unchanged)",
    async () => {
      const dir = join(DATA_DIR, "test-audio-video");
      const sourcePath = await generateTestSource(dir);

      await processAudio(sourcePath);

      // Verify video dimensions are preserved via ffprobe.
      const proc = Bun.spawn(
        [
          "ffprobe",
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_streams",
          "-select_streams",
          "v:0",
          sourcePath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const data = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
      expect(data.streams?.[0]?.width).toBe(320);
      expect(data.streams?.[0]?.height).toBe(240);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "is idempotent — re-running produces valid output",
    async () => {
      const dir = join(DATA_DIR, "test-audio-idempotent");
      const sourcePath = await generateTestSource(dir);

      await processAudio(sourcePath);
      const size1 = Bun.file(sourcePath).size;

      await processAudio(sourcePath);
      const size2 = Bun.file(sourcePath).size;

      // Both runs should produce valid files.
      expect(size1).toBeGreaterThan(0);
      expect(size2).toBeGreaterThan(0);

      // LUFS should still be on target after double-processing.
      const lufs = await measureLUFS(sourcePath);
      expect(lufs).toBeGreaterThan(-15);
      expect(lufs).toBeLessThan(-13);
    },
    120_000,
  );
});

// --- Chain-effect tests: noise floor + dynamic-range compression ---

// Build a multi-segment fixture: tone @ 0.3 / 5s, noise @ 0.003 / 4s,
// tone @ 0.12 / 5s, noise @ 0.003 / 4s, tone @ 0.3 / 5s. Total ~23 s.
// The two tone amplitudes are 8 dB apart (0.3 vs 0.12); the noise pad is
// at ~-50 dBFS. After processing, the gate should drive the noise pads
// well below the input level, and dynaudnorm should bring the two tone
// segments to within ~3 dB of each other.
async function generateMultiSegmentFixture(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, "source.mp4");
  const filterComplex = [
    "sine=f=500:duration=5:sample_rate=48000,volume=0.3[t1]",
    "anoisesrc=duration=4:amplitude=0.003:color=white,asetnsamples=n=1024[n1]",
    "sine=f=500:duration=5:sample_rate=48000,volume=0.12[t2]",
    "anoisesrc=duration=4:amplitude=0.003:color=white,asetnsamples=n=1024[n2]",
    "sine=f=500:duration=5:sample_rate=48000,volume=0.3[t3]",
    "[t1][n1][t2][n2][t3]concat=n=5:v=0:a=1[out]",
  ].join(";");

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=320x240:rate=15:duration=23:color=black",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=48000",
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`multi-segment fixture failed: ${stderr}`);
  return outPath;
}

// Mean volume over a [start, start+length] window, in dB.
async function meanVolume(file: string, start: number, length: number): Promise<number> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-ss",
      String(start),
      "-t",
      String(length),
      "-i",
      file,
      "-af",
      "volumedetect",
      "-vn",
      "-f",
      "null",
      "-",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(`volumedetect failed: ${stderr}`);
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  if (!match?.[1]) throw new Error(`no mean_volume in: ${stderr}`);
  return Number.parseFloat(match[1]);
}

describe("processAudio (chain effects)", () => {
  test.skipIf(!ffmpegAvailable)(
    "gate floors the noise pad in silent regions",
    async () => {
      const dir = join(DATA_DIR, "test-audio-noise-floor");
      const sourcePath = await generateMultiSegmentFixture(dir);

      await processAudio(sourcePath);

      // First noise pad is at ~9-13s (after the 5s loud tone + with a small
      // safety margin to avoid the gate's release tail). Mean volume in
      // the middle of that pad must be below the gate threshold (-45 dBFS)
      // by a comfortable margin.
      const padDb = await meanVolume(sourcePath, 10, 2);
      expect(padDb).toBeLessThan(-50);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "dynaudnorm levels the two tone segments to within ~4 dB",
    async () => {
      const dir = join(DATA_DIR, "test-audio-dynamic-range");
      const sourcePath = await generateMultiSegmentFixture(dir);

      await processAudio(sourcePath);

      // Loud tone occupies 0-5s, quiet tone occupies 14-19s.
      // Sample 1s windows comfortably inside each segment to avoid edges.
      const loudDb = await meanVolume(sourcePath, 1.5, 2);
      const quietDb = await meanVolume(sourcePath, 15.5, 2);

      // Input gap is 8 dB. After dynaudnorm + loudnorm we expect this
      // significantly compressed. Allow up to 4 dB residual gap.
      expect(Math.abs(loudDb - quietDb)).toBeLessThan(4);
    },
    60_000,
  );
});
