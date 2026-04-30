import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";

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
  const proc = Bun.spawn(
    [
      ffmpegPath,
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
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    await rm(rawTmpPath, { force: true }).catch(() => {});
    throw new Error(`peaks audio extraction failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  // Read raw PCM and compute peaks.
  const rawFile = Bun.file(rawTmpPath);
  const rawBuffer = await rawFile.arrayBuffer();
  await rm(rawTmpPath, { force: true }).catch(() => {});

  const samples = new Int16Array(rawBuffer);
  const totalPeaks = Math.ceil(duration * PEAKS_PER_SECOND);
  const samplesPerPeak = Math.max(1, Math.floor(samples.length / totalPeaks));
  const peaks: number[] = [];

  for (let i = 0; i < totalPeaks; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, samples.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(samples[j] ?? 0);
      if (abs > max) max = abs;
    }
    // Normalize to 0..1 range, rounded to 4 decimal places.
    peaks.push(Math.round((max / 32768) * 10000) / 10000);
  }

  const peaksData: PeaksData = { length: peaks.length, sampleRate: PEAKS_PER_SECOND, data: peaks };
  await Bun.write(tmpPath, JSON.stringify(peaksData));
  await rename(tmpPath, finalPath);

  return true;
}
