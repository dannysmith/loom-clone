import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";
import { spawnFfmpeg } from "./ffmpeg";

// Generates peaks.json for wavesurfer.js from source.mp4.
// Extracts mono PCM audio at a low sample rate, computes peak amplitudes
// per time window, and writes a JSON file that wavesurfer.js can load directly.

const PEAKS_PER_SECOND = 50; // 50 peaks/second gives a smooth waveform at reasonable data size.

export type PeaksData = {
  length: number;
  sampleRate: number;
  data: number[];
};

export async function generatePeaks(
  derivDir: string,
  duration: number,
  inputPath?: string,
): Promise<boolean> {
  if (duration < 1) return false;

  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const sourcePath = inputPath ?? join(derivDir, "source.mp4");
  const tmpPath = join(derivDir, "peaks.json.tmp");
  const finalPath = join(derivDir, "peaks.json");
  const rawTmpPath = join(derivDir, "_peaks_raw.tmp");

  await mkdir(derivDir, { recursive: true });

  // Extract mono audio as raw 16-bit signed PCM at 8kHz (enough for peak visualization).
  const { exitCode, stderr } = await spawnFfmpeg(ffmpegPath, [
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
    rawTmpPath,
  ]);
  if (exitCode !== 0) {
    await rm(rawTmpPath, { force: true }).catch(() => {});
    throw new Error(`peaks audio extraction failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  // Compute peaks by streaming the raw PCM rather than buffering all ~22 MB
  // (for a 23-min video) into one ArrayBuffer at the tail of the pipeline.
  // samplesPerPeak is derived from the file SIZE (a stat, no read) so the
  // output is byte-identical to the buffered version.
  const rawFile = Bun.file(rawTmpPath);
  const totalSamples = Math.floor(rawFile.size / 2); // s16le → 2 bytes/sample
  const totalPeaks = Math.ceil(duration * PEAKS_PER_SECOND);
  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / totalPeaks));
  // Only the first totalPeaks*samplesPerPeak samples feed buckets; any trailing
  // remainder is ignored, matching the original windowing exactly.
  const sampleLimit = totalPeaks * samplesPerPeak;

  const rawMax = new Int32Array(totalPeaks); // per-bucket max |sample|
  let sampleIdx = 0;
  let carryLow = -1; // low byte held across a chunk boundary, -1 = none

  const accumulate = (lo: number, hi: number): void => {
    const u = lo | (hi << 8);
    const v = u >= 0x8000 ? u - 0x10000 : u; // s16le → signed
    const abs = v < 0 ? -v : v;
    const bucket = (sampleIdx / samplesPerPeak) | 0;
    if (abs > rawMax[bucket]!) rawMax[bucket] = abs;
    sampleIdx++;
  };

  streaming: for await (const chunk of rawFile.stream()) {
    const len = chunk.length;
    let i = 0;
    if (carryLow >= 0 && len > 0) {
      accumulate(carryLow, chunk[0]!);
      carryLow = -1;
      i = 1;
      if (sampleIdx >= sampleLimit) break;
    }
    for (; i + 1 < len; i += 2) {
      accumulate(chunk[i]!, chunk[i + 1]!);
      if (sampleIdx >= sampleLimit) break streaming;
    }
    // One trailing byte: hold its low half for the next chunk.
    if (i === len - 1) carryLow = chunk[i]!;
  }

  await rm(rawTmpPath, { force: true }).catch(() => {});

  const peaks: number[] = new Array(totalPeaks);
  for (let i = 0; i < totalPeaks; i++) {
    // Normalize to 0..1 range, rounded to 4 decimal places.
    peaks[i] = Math.round((rawMax[i]! / 32768) * 10000) / 10000;
  }

  const peaksData: PeaksData = { length: peaks.length, sampleRate: PEAKS_PER_SECOND, data: peaks };
  await Bun.write(tmpPath, JSON.stringify(peaksData));
  await rename(tmpPath, finalPath);

  return true;
}
