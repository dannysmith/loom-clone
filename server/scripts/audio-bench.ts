#!/usr/bin/env bun
/**
 * Audio chain A/B bench. Runs N named filter chains against a single input
 * and reports per-output integrated LUFS, true peak, P10 noise floor in
 * silent regions, and P90-P10 dynamic range in speech regions, plus wall-
 * clock processing time.
 *
 * Usage:
 *   bun scripts/audio-bench.ts <input.mp4>
 *   bun scripts/audio-bench.ts --synthetic
 *
 * The --synthetic flag generates a fixture (3 speech-band tones at varying
 * amplitudes, separated by low-amplitude noise) so the bench can be run with
 * no input file. Synthetic fixtures aren't a substitute for a real recording
 * but they're useful for sanity-checking that filters do what they claim.
 *
 * Outputs land in a `bench-<basename>/` directory next to the input, one
 * `.mp4` per chain plus `bench-results.json` with the measurements.
 */
import { mkdir, rm } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

const ARNNDN_MODEL = resolve(import.meta.dir, "../assets/audio-models/cb.rnnn");

// Each chain is the filter sequence that runs BEFORE loudnorm. Both passes of
// loudnorm get appended automatically. `nf` is the afftdn noise floor; bench
// uses a fixed -50 dB rather than profiling — keeps variants directly
// comparable.
type Chain = {
  name: string;
  filter: string;
  description: string;
};

function chains(): Chain[] {
  const HIGHPASS = "highpass=f=80";
  const ARNNDN = `arnndn=m=${ARNNDN_MODEL}`;
  const AFFTDN = "afftdn=nf=-50:nr=12";
  const AGATE = "agate=threshold=0.0056:ratio=10:attack=5:release=300:knee=2.5";
  const DYNAUDNORM = "dynaudnorm=f=500:g=11:m=10:p=0.95";

  return [
    {
      name: "baseline",
      filter: [HIGHPASS, ARNNDN].join(","),
      description: "today's chain (highpass + arnndn)",
    },
    {
      name: "gate-only",
      filter: [HIGHPASS, ARNNDN, AGATE].join(","),
      description: "baseline + agate",
    },
    {
      name: "dynaudnorm-only",
      filter: [HIGHPASS, ARNNDN, DYNAUDNORM].join(","),
      description: "baseline + dynaudnorm (no gate — noise floor will rise)",
    },
    {
      name: "afftdn-only",
      filter: [HIGHPASS, ARNNDN, AFFTDN].join(","),
      description: "baseline + afftdn",
    },
    {
      name: "candidate",
      filter: [HIGHPASS, ARNNDN, AFFTDN, AGATE, DYNAUDNORM].join(","),
      description: "proposed full chain (afftdn + gate + dynaudnorm)",
    },
  ];
}

const LOUDNORM_TARGET = "I=-14:TP=-1.5:LRA=11";

type Measurement = {
  name: string;
  description: string;
  outputPath: string;
  processingMs: number;
  integratedLufs: number;
  truePeak: number;
  noiseFloorDb: number | null;
  speechDynamicRangeDb: number | null;
};

async function runFfmpeg(args: string[]): Promise<{ stderr: string; exit: number }> {
  const fp = Bun.which("ffmpeg");
  if (!fp) throw new Error("ffmpeg not found on PATH");
  const proc = Bun.spawn([fp, ...args], { stderr: "pipe", stdout: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, exit };
}

// Generate a synthetic test fixture: tone-noise-tone-noise-tone with the
// middle tone 8 dB quieter to simulate moving away from the mic. Total ~28 s.
async function generateSyntheticFixture(outPath: string): Promise<void> {
  // Loud tone (500 Hz @ 0.3 = -10 dBFS), quiet tone (500 Hz @ 0.12 = -18
  // dBFS), and very quiet white noise (-50 dBFS) in between. Five segments
  // concatenated.
  const filter = [
    "sine=f=500:duration=5:sample_rate=48000,volume=0.3[t1]",
    "anoisesrc=duration=4:amplitude=0.003:color=white,asetnsamples=n=1024[n1]",
    "sine=f=500:duration=5:sample_rate=48000,volume=0.12[t2]",
    "anoisesrc=duration=4:amplitude=0.003:color=white,asetnsamples=n=1024[n2]",
    "sine=f=500:duration=5:sample_rate=48000,volume=0.3[t3]",
    "[t1][n1][t2][n2][t3]concat=n=5:v=0:a=1[out]",
  ].join(";");

  const { stderr, exit } = await runFfmpeg([
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
    filter,
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
  ]);
  if (exit !== 0) throw new Error(`synthetic fixture generation failed: ${stderr.trim()}`);
}

// Run the full two-pass loudnorm against `input` with the given chain's
// pre-filter, write the result to `output`. Returns processing wall-clock ms.
async function runChain(input: string, output: string, chain: Chain): Promise<number> {
  const started = Date.now();

  // Pass 1: measure with full chain.
  const pass1Filter = `${chain.filter},loudnorm=${LOUDNORM_TARGET}:print_format=json`;
  const pass1 = await runFfmpeg([
    "-y",
    "-hide_banner",
    "-i",
    input,
    "-af",
    pass1Filter,
    "-f",
    "null",
    "-",
  ]);
  if (pass1.exit !== 0) throw new Error(`pass 1 failed (${chain.name}): ${pass1.stderr.trim()}`);

  const m = parseLoudnormJson(pass1.stderr);

  // Pass 2: apply measured values.
  const pass2Filter =
    `${chain.filter},loudnorm=${LOUDNORM_TARGET}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`;
  const pass2 = await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-af",
    pass2Filter,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ]);
  if (pass2.exit !== 0) throw new Error(`pass 2 failed (${chain.name}): ${pass2.stderr.trim()}`);

  return Date.now() - started;
}

function parseLoudnormJson(stderr: string): {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
} {
  const lastBrace = stderr.lastIndexOf("}");
  const firstBrace = stderr.lastIndexOf("{", lastBrace);
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("no loudnorm JSON in stderr");
  }
  return JSON.parse(stderr.substring(firstBrace, lastBrace + 1));
}

// Measure integrated LUFS and true peak by running loudnorm in measure mode
// over the output file (no chain on top — straight measurement).
async function measureLoudness(file: string): Promise<{ lufs: number; truePeak: number }> {
  const { stderr, exit } = await runFfmpeg([
    "-y",
    "-hide_banner",
    "-i",
    file,
    "-af",
    `loudnorm=${LOUDNORM_TARGET}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  if (exit !== 0) throw new Error(`loudness measurement failed: ${stderr.trim()}`);
  const m = parseLoudnormJson(stderr);
  return { lufs: Number.parseFloat(m.input_i), truePeak: Number.parseFloat(m.input_tp) };
}

// Detect silent regions using ffmpeg silencedetect. Threshold and minimum
// duration match the production pipeline (-30 dB / 1 s).
type Silence = { start: number; end: number };

async function detectSilences(file: string, duration: number): Promise<Silence[]> {
  const { stderr, exit } = await runFfmpeg([
    "-y",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-i",
    file,
    "-af",
    "silencedetect=noise=-30dB:d=1",
    "-vn",
    "-f",
    "null",
    "-",
  ]);
  if (exit !== 0) return [];

  const silences: Silence[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const startMatch = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (startMatch?.[1] !== undefined) {
      pendingStart = Math.max(0, Number.parseFloat(startMatch[1]));
      continue;
    }
    const endMatch = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (endMatch?.[1] !== undefined && pendingStart !== null) {
      const end = Math.min(duration, Number.parseFloat(endMatch[1]));
      if (end > pendingStart) silences.push({ start: pendingStart, end });
      pendingStart = null;
    }
  }
  if (pendingStart !== null && duration > pendingStart) {
    silences.push({ start: pendingStart, end: duration });
  }
  return silences;
}

// Probe duration via ffprobe.
async function probeDuration(file: string): Promise<number> {
  const ffprobe = Bun.which("ffprobe");
  if (!ffprobe) throw new Error("ffprobe not found");
  const proc = Bun.spawn([ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exit !== 0) return 0;
  const data = JSON.parse(stdout) as { format?: { duration?: string } };
  return Number.parseFloat(data.format?.duration ?? "0") || 0;
}

// Mean volume in dB over a [start, start+length] window. Used both for noise
// floor (silent regions) and speech levels.
async function meanVolumeWindow(
  file: string,
  start: number,
  length: number,
): Promise<number | null> {
  if (length <= 0) return null;
  const { stderr, exit } = await runFfmpeg([
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
  ]);
  if (exit !== 0) return null;
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  if (!match?.[1]) return null;
  const v = Number.parseFloat(match[1]);
  return Number.isFinite(v) ? v : null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? null;
}

// Estimate per-output noise floor: P10 of mean_volume across silent windows.
// Speech dynamic range: P90 - P10 of mean_volume across non-silent windows
// of fixed size.
async function measureFloorAndRange(
  file: string,
  duration: number,
): Promise<{ noiseFloorDb: number | null; speechDynamicRangeDb: number | null }> {
  const silences = await detectSilences(file, duration);

  // Noise floor: mean_volume over each silent region (capped to 2 s sample).
  const silentReadings: number[] = [];
  for (const s of silences) {
    const len = Math.min(2.0, s.end - s.start);
    const v = await meanVolumeWindow(file, s.start, len);
    if (v !== null) silentReadings.push(v);
  }
  silentReadings.sort((a, b) => a - b);

  // Speech regions: complement of silences. Sample 1 s windows every 2 s.
  const speechReadings: number[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) {
      // Walk this speech run in 1 s windows, every 2 s.
      for (let t = cursor; t + 1.0 <= s.start; t += 2.0) {
        const v = await meanVolumeWindow(file, t, 1.0);
        if (v !== null) speechReadings.push(v);
      }
    }
    cursor = s.end;
  }
  if (cursor < duration) {
    for (let t = cursor; t + 1.0 <= duration; t += 2.0) {
      const v = await meanVolumeWindow(file, t, 1.0);
      if (v !== null) speechReadings.push(v);
    }
  }
  speechReadings.sort((a, b) => a - b);

  const noiseFloorDb = percentile(silentReadings, 0.1);
  const p10 = percentile(speechReadings, 0.1);
  const p90 = percentile(speechReadings, 0.9);
  const speechDynamicRangeDb = p10 !== null && p90 !== null ? p90 - p10 : null;

  return { noiseFloorDb, speechDynamicRangeDb };
}

function fmtDb(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "  n/a ";
  return `${v >= 0 ? " " : ""}${v.toFixed(1)} dB`;
}

function printTable(rows: Measurement[]): void {
  const header = ["chain", "time", "LUFS", "TP", "noise floor", "DR (P90-P10)"];
  const widths = [20, 8, 8, 8, 14, 14];

  function pad(s: string, w: number): string {
    return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  }
  const line = widths.map((w) => "-".repeat(w)).join(" ");

  console.log(header.map((h, i) => pad(h, widths[i] ?? 0)).join(" "));
  console.log(line);
  for (const r of rows) {
    const cells = [
      pad(r.name, widths[0] ?? 0),
      pad(`${(r.processingMs / 1000).toFixed(2)}s`, widths[1] ?? 0),
      pad(r.integratedLufs.toFixed(1), widths[2] ?? 0),
      pad(r.truePeak.toFixed(1), widths[3] ?? 0),
      pad(fmtDb(r.noiseFloorDb), widths[4] ?? 0),
      pad(
        r.speechDynamicRangeDb !== null ? `${r.speechDynamicRangeDb.toFixed(1)} dB` : "n/a",
        widths[5] ?? 0,
      ),
    ];
    console.log(cells.join(" "));
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun scripts/audio-bench.ts <input.mp4>");
    console.error("       bun scripts/audio-bench.ts --synthetic");
    return 1;
  }

  if (!Bun.which("ffmpeg") || !Bun.which("ffprobe")) {
    console.error("error: ffmpeg/ffprobe not found on PATH");
    return 1;
  }

  let inputPath: string;
  if (args[0] === "--synthetic") {
    inputPath = resolve("bench-synthetic.mp4");
    console.log(`Generating synthetic fixture at ${inputPath} ...`);
    await generateSyntheticFixture(inputPath);
  } else {
    inputPath = resolve(args[0] ?? "");
    if (!(await Bun.file(inputPath).exists())) {
      console.error(`error: input file not found: ${inputPath}`);
      return 1;
    }
  }

  const inputBase = basename(inputPath, ".mp4");
  const outDir = join(dirname(inputPath), `bench-${inputBase}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log(`Bench output dir: ${outDir}\n`);

  const variants = chains();
  const results: Measurement[] = [];

  for (const chain of variants) {
    const outputPath = join(outDir, `out-${chain.name}.mp4`);
    process.stdout.write(`[${chain.name}] running... `);
    let processingMs: number;
    try {
      processingMs = await runChain(inputPath, outputPath, chain);
    } catch (err) {
      console.log(`FAILED — ${err instanceof Error ? err.message : err}`);
      continue;
    }
    process.stdout.write("measuring... ");

    const duration = await probeDuration(outputPath);
    const { lufs, truePeak } = await measureLoudness(outputPath);
    const { noiseFloorDb, speechDynamicRangeDb } = await measureFloorAndRange(outputPath, duration);

    results.push({
      name: chain.name,
      description: chain.description,
      outputPath,
      processingMs,
      integratedLufs: lufs,
      truePeak,
      noiseFloorDb,
      speechDynamicRangeDb,
    });

    console.log("done.");
  }

  console.log();
  printTable(results);
  console.log();

  const resultsPath = join(outDir, "bench-results.json");
  await Bun.write(resultsPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${resultsPath}`);

  return 0;
}

const exitCode = await main();
process.exit(exitCode);
