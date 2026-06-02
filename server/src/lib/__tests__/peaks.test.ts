import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { generatePeaks, type PeaksData } from "../peaks";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;
const PEAKS_PER_SECOND = 50; // mirror of the constant in peaks.ts

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Generate a short source.mp4 with a non-trivial (amplitude-varying) audio
// track so peak values differ across windows.
async function generateTestSource(dir: string, duration: number): Promise<void> {
  await mkdir(dir, { recursive: true });
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
      `testsrc=duration=${duration}:size=160x120:rate=15`,
      "-f",
      "lavfi",
      // Tremolo gives a slow amplitude swing → distinct per-window peaks.
      "-i",
      `sine=frequency=440:duration=${duration}:sample_rate=48000`,
      "-af",
      "tremolo=f=3:d=0.8",
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
      join(dir, "source.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`fixture generation failed: ${stderr}`);
}

// The ORIGINAL buffered algorithm, reproduced here as the oracle: extract the
// same 8 kHz mono PCM, load it whole, window it. The streaming implementation
// in peaks.ts must produce a byte-identical result.
async function computePeaksBuffered(sourcePath: string, duration: number): Promise<PeaksData> {
  const rawPath = `${sourcePath}.oracle.pcm`;
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      rawPath,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error("oracle extraction failed");

  const samples = new Int16Array(await Bun.file(rawPath).arrayBuffer());
  const totalPeaks = Math.ceil(duration * PEAKS_PER_SECOND);
  const samplesPerPeak = Math.max(1, Math.floor(samples.length / totalPeaks));
  const data: number[] = [];
  for (let i = 0; i < totalPeaks; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, samples.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(samples[j] ?? 0);
      if (abs > max) max = abs;
    }
    data.push(Math.round((max / 32768) * 10000) / 10000);
  }
  return { length: data.length, sampleRate: PEAKS_PER_SECOND, data };
}

describe("generatePeaks (streaming)", () => {
  test.skipIf(!ffmpegAvailable)("output is byte-identical to the buffered algorithm", async () => {
    const duration = 3;
    const dir = join(env.tempDir, "vid-peaks", "derivatives");
    const source = join(dir, "source.mp4");
    await generateTestSource(dir, duration);

    const expected = await computePeaksBuffered(source, duration);

    const ok = await generatePeaks(dir, duration);
    expect(ok).toBe(true);

    const actual = (await Bun.file(join(dir, "peaks.json")).json()) as PeaksData;

    expect(actual.sampleRate).toBe(expected.sampleRate);
    expect(actual.length).toBe(expected.length);
    expect(actual.data).toEqual(expected.data);
    // JSON serialisation must match exactly (byte-identical file).
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  test.skipIf(!ffmpegAvailable)("removes the temp PCM file", async () => {
    const duration = 2;
    const dir = join(env.tempDir, "vid-peaks-tmp", "derivatives");
    await generateTestSource(dir, duration);
    await generatePeaks(dir, duration);
    expect(await Bun.file(join(dir, "_peaks_raw.tmp")).exists()).toBe(false);
  });

  test("returns false for sub-1s duration", async () => {
    const dir = join(env.tempDir, "vid-peaks-short", "derivatives");
    expect(await generatePeaks(dir, 0.5)).toBe(false);
  });
});
