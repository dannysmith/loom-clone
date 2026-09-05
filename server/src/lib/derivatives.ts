import { eq } from "drizzle-orm";
import { rename, rm } from "fs/promises";
import { join, resolve } from "path";
import { getDb } from "../db/client";
import { type ProcessingStepKind, videos } from "../db/schema";
import { spawnFfmpeg } from "./ffmpeg";
import { hasAudioStream, probeJson } from "./ffprobe";
import { DATA_DIR, derivativesDir } from "./paths";
import { isProbablyPlayable } from "./processing/playable";
import type { Silence } from "./suggested-edits";

// Resolved absolutely so it survives test chdir() calls.
const ARNNDN_MODEL = resolve(import.meta.dir, "../../assets/audio-models/cb.rnnn");

// Low-level derivative generators. Each writes `<name>.tmp` then renames it
// atomically to its final name on success, so a crash mid-generation leaves
// either a stale-but-complete final file or nothing at all — never a
// half-written output. Orchestration (ordering, step tracking, status
// reconciliation) lives in ./processing/pipeline.ts; this module only knows
// how to produce individual files.

// Cache the ffmpeg PATH lookup — no need to scan on every invocation.
let ffmpegPath: string | null | undefined; // undefined = not checked yet

async function runFfmpeg(args: string[]): Promise<void> {
  if (ffmpegPath === undefined) {
    ffmpegPath = Bun.which("ffmpeg");
    if (!ffmpegPath) {
      console.warn("[derivatives] ffmpeg not found on PATH — derivative generation will fail");
    }
  }
  if (!ffmpegPath) {
    throw new Error("ffmpeg not found on PATH");
  }

  const { exitCode, stderr } = await spawnFfmpeg(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...args,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${stderr.trim()}`);
  }
}

// Run the stitch ffmpeg, then validate the tmp BEFORE renaming over any
// existing source.mp4 (mirrors processAudio): a forced re-stitch that produces
// an unplayable file must not clobber the previous good source, and a failed
// ffmpeg must not leave an orphan .tmp behind. Structural check only (no
// expectedDuration) — the registry's `source` step re-checks duration after.
async function stitchSource(args: string[], tmp: string, final: string): Promise<void> {
  try {
    await runFfmpeg(args);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  if (!(await isProbablyPlayable(tmp))) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new Error(
      "stitched source.mp4 failed playability check — keeping the previous source.mp4",
    );
  }
  await rename(tmp, final);
}

// Stitch the converged HLS segments into derivatives/source.mp4 (recorded
// videos). Writes source.mp4.tmp then renames atomically.
export async function generateSourceFromHls(videoId: string, dir: string): Promise<void> {
  const playlist = join(DATA_DIR, videoId, "stream.m3u8");
  const tmp = join(dir, "source.mp4.tmp");
  const final = join(dir, "source.mp4");
  await stitchSource(
    [
      // m3u8 references init.mp4 and seg_*.m4s — allow all extensions so the
      // HLS demuxer doesn't reject .m4s sources.
      "-allowed_extensions",
      "ALL",
      "-i",
      playlist,
      "-c",
      "copy",
      // Put the moov atom at the front so `<video>` can begin playback before
      // the whole file is downloaded.
      "-movflags",
      "+faststart",
      // Explicit format — the `.tmp` output filename defeats ffmpeg's
      // extension-based format detection.
      "-f",
      "mp4",
      tmp,
    ],
    tmp,
    final,
  );
}

// Remux an uploaded upload.mp4 → derivatives/source.mp4 with faststart
// (uploaded videos — no HLS segments exist).
export async function generateSourceFromUpload(videoId: string, dir: string): Promise<void> {
  const input = join(DATA_DIR, videoId, "upload.mp4");
  const tmp = join(dir, "source.mp4.tmp");
  const final = join(dir, "source.mp4");
  await stitchSource(
    ["-i", input, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp],
    tmp,
    final,
  );
}

// Probe duration of a video file using ffprobe. Returns seconds or null
// if ffprobe fails or isn't available.
export async function probeDuration(filePath: string): Promise<number | null> {
  const data = (await probeJson([
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    filePath,
  ])) as { format?: { duration?: string } } | null;
  const d = Number.parseFloat(data?.format?.duration ?? "");
  return Number.isFinite(d) ? d : null;
}

// Full video metadata from ffprobe: dimensions, file size and duration. One
// probe serves every caller — the pipeline seeds the source's height and
// duration from a single call, and the presentation step reads the master's
// size and duration from another.
export type ProbeMetadata = {
  width: number;
  height: number;
  fileBytes: number;
  // Container duration — how long the file plays, following whichever stream
  // runs longest. This is what a viewer experiences, so it's what gets cached as
  // durationSeconds and what the EDL is expressed against.
  duration: number;
  // The video stream's own duration, which is usually a little shorter. Used for
  // validation, where the expectation is video-derived and comparing it against
  // the container would measure the wrong thing.
  videoDuration: number;
};

export async function probeMetadata(filePath: string): Promise<ProbeMetadata | null> {
  const data = (await probeJson([
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-select_streams",
    "v:0",
    filePath,
  ])) as {
    streams?: Array<{ width?: number; height?: number; duration?: string }>;
    format?: { size?: string; duration?: string };
  } | null;
  if (!data) return null;

  const stream = data.streams?.[0];
  const w = stream?.width;
  const h = stream?.height;
  const size = Number.parseInt(data.format?.size ?? "", 10);
  const duration = Number.parseFloat(data.format?.duration ?? "");
  const streamDuration = Number.parseFloat(stream?.duration ?? "");

  if (!w || !h || !Number.isFinite(size) || !Number.isFinite(duration)) return null;
  return {
    width: w,
    height: h,
    fileBytes: size,
    duration,
    videoDuration: Number.isFinite(streamDuration) ? streamDuration : duration,
  };
}

// Read recording.json sidecar for camera/mic names and recording health.
type RecordingMeta = {
  cameraName: string | null;
  microphoneName: string | null;
  recordingHealth: string | null;
};

async function readRecordingJson(videoDir: string): Promise<RecordingMeta> {
  const defaults: RecordingMeta = { cameraName: null, microphoneName: null, recordingHealth: null };
  try {
    const file = Bun.file(join(videoDir, "recording.json"));
    if (!(await file.exists())) return defaults;
    const data = (await file.json()) as {
      inputs?: { camera?: { name?: string }; microphone?: { name?: string } };
      compositionStats?: { terminalFailure?: boolean; [k: string]: unknown };
    };

    const cameraName = data.inputs?.camera?.name || null;
    const microphoneName = data.inputs?.microphone?.name || null;

    let recordingHealth: string | null = null;
    if (data.compositionStats) {
      if (data.compositionStats.terminalFailure) {
        recordingHealth = "terminal_failure";
      } else {
        // Any non-zero counter besides terminalFailure indicates gpu_wobble.
        const hasNonZero = Object.entries(data.compositionStats).some(
          ([k, v]) => k !== "terminalFailure" && typeof v === "number" && v > 0,
        );
        if (hasNonZero) recordingHealth = "gpu_wobble";
      }
    }

    return { cameraName, microphoneName, recordingHealth };
  } catch {
    return defaults;
  }
}

// Extracts GEOMETRY from source.mp4 plus the recording.json sidecar, and writes
// them to the DB. Doesn't produce a file — it's a mandatory pipeline step (gates
// `ready`), which is why it reads the source rather than the presentation master:
// it has to be able to run before the master exists. The geometry is identical
// either way, because nothing in the presentation pipeline scales the video.
//
// The two properties that DO differ between source and master — `fileBytes` and
// `durationSeconds` — are owned by the presentation step, which probes the file
// viewers are actually served. See setPresentationMetadata.
//
// Returns false when ffprobe fails/unavailable so the step is marked failed.
// `opts.preProbed` lets the caller pass an already-computed probe (the pipeline
// seeds one) so the source isn't probed twice in the same run.
export async function extractMetadata(
  videoId: string,
  opts: { sourceFile?: string; preProbed?: ProbeMetadata } = {},
): Promise<boolean> {
  const videoDir = join(DATA_DIR, videoId);
  const sourceFile = opts.sourceFile ?? join(derivativesDir(videoId), "source.mp4");

  const [probe, recording] = await Promise.all([
    opts.preProbed ?? probeMetadata(sourceFile),
    readRecordingJson(videoDir),
  ]);

  if (!probe) {
    console.warn(`[derivatives] ${videoId} metadata extraction: ffprobe failed or unavailable`);
    return false;
  }

  const aspectRatio = Math.round((probe.width / probe.height) * 10000) / 10000;

  await getDb()
    .update(videos)
    .set({
      width: probe.width,
      height: probe.height,
      aspectRatio,
      cameraName: recording.cameraName,
      microphoneName: recording.microphoneName,
      recordingHealth: recording.recordingHealth,
    })
    .where(eq(videos.id, videoId));

  console.log(`[derivatives] ${videoId} metadata: ${probe.width}x${probe.height}`);
  return true;
}

// Record whether source.mp4 is a true original. Set true whenever the source is
// (re-)stitched from the HLS segments or an upload; set false by the migration
// for videos whose source already had the audio chain written into it in place,
// before the presentation master existed.
export async function setSourcePristine(videoId: string, pristine: boolean): Promise<void> {
  await getDb().update(videos).set({ sourcePristine: pristine }).where(eq(videos.id, videoId));
}

// Cache the size and duration of the presentation master — the properties that
// describe what a viewer actually gets, and the only two that differ between the
// pristine source and the served file (an edited master is shorter; any master
// is a different size once the audio has been re-encoded). Written by the
// presentation step from its own probe of the file it just produced.
export async function setPresentationMetadata(
  videoId: string,
  probe: ProbeMetadata,
): Promise<void> {
  await getDb()
    .update(videos)
    .set({ fileBytes: probe.fileBytes, durationSeconds: probe.duration })
    .where(eq(videos.id, videoId));
}

// --- Audio processing chain ---
//
// highpass=80 → arnndn(cb.rnnn) → afftdn(profiled nf, nr=12)
//   → agate(-45 dBFS, 5/300 ms, soft 2.5 dB knee, ratio 10)
//   → dynaudnorm(f=500, g=11, m=10) → loudnorm(-14 LUFS, two-pass)
//
// Order is part of the design: gate runs after denoise so the threshold can
// sit well below speech without clipping word ends; dynaudnorm runs after
// the gate so it never sees noise to amplify; loudnorm is last so the global
// target stays exact. The afftdn noise floor (`nf`) is profiled per recording
// from the loudest silent region (see profileNoiseFloor).
//
// Video track is copied; audio re-encoded to AAC 160 kbps.

type LoudnormMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

// Default afftdn noise floor when profiling is unavailable (no qualifying
// silent region, or the volumedetect probe failed).
const DEFAULT_NOISE_FLOOR_DB = -50;
const NOISE_FLOOR_MIN_DB = -65;
const NOISE_FLOOR_MAX_DB = -30;

// Workaround for an ffmpeg bug, NOT a tuning choice: arnndn can emit a frame of
// NaN samples when it flushes at end-of-stream, which poisons everything
// downstream and makes the AAC encoder fail the whole encode with "Input
// contains (near) NaN/+-Inf". It's non-deterministic (measured on a real 66s
// recording: 6 of 8 identical runs affected, always the final 480-sample frame,
// 384 of which are EOF padding rather than real audio) — the signature of
// uninitialised memory in the flush path. Related: ffmpeg ticket #10863.
//
// Round-tripping through 16-bit integer turns any non-finite sample into a
// finite one. Verified to clear it in 10 of 10 runs, where a mono downmix (7 of
// 10 still affected), per-channel arnndn instances (10 of 10 affected) and
// `-filter_threads 1` did not.
//
// It sits immediately after arnndn so a single bad sample can't reach afftdn,
// whose FFT would smear it across a whole window. The 16-bit floor is ~96 dB
// below full scale, under a chain that ends in a 160 kbps AAC encode — the
// quantisation is inaudible here. Remove it once arnndn is fixed upstream.
const ARNNDN_NAN_GUARD = "aformat=sample_fmts=s16,aformat=sample_fmts=fltp";

function audioFilterChain(noiseFloorDb: number): string {
  // Linear threshold for -45 dBFS = 10^(-45/20) ≈ 0.0056. Hardcoded rather
  // than computed at call time — the gate threshold is a tuned constant.
  const filters = [
    "highpass=f=80",
    `arnndn=m=${ARNNDN_MODEL}`,
    ARNNDN_NAN_GUARD,
    `afftdn=nf=${noiseFloorDb}:nr=12`,
    "agate=threshold=0.0056:ratio=10:attack=5:release=300:knee=2.5",
    "dynaudnorm=f=500:g=11:m=10:p=0.95",
  ];
  return filters.join(",");
}

function loudnormPass1Filter(noiseFloorDb: number): string {
  return `${audioFilterChain(noiseFloorDb)},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`;
}

function loudnormPass2Filter(noiseFloorDb: number, m: LoudnormMeasurement): string {
  return (
    `${audioFilterChain(noiseFloorDb)},loudnorm=I=-14:TP=-1.5:LRA=11` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`
  );
}

// Estimate the recording's noise floor from its longest silent region and
// return a value suitable for afftdn's `nf` parameter (in dB). The pipeline
// already detects silences for suggested-edits; we reuse them rather than
// running silencedetect again.
//
// Returns DEFAULT_NOISE_FLOOR_DB if no silence ≥ 1 s is available, ffmpeg is
// missing, the probe fails, or volumedetect output is malformed. Result is
// clamped to [NOISE_FLOOR_MIN_DB, NOISE_FLOOR_MAX_DB] so a freak measurement
// can't produce nonsense filter settings.
async function profileNoiseFloor(
  sourcePath: string,
  silences: Silence[] | undefined,
): Promise<number> {
  if (!silences || silences.length === 0) return DEFAULT_NOISE_FLOOR_DB;

  // Pick the longest silence at least 1 s long.
  let longest: Silence | undefined;
  let longestLen = 0;
  for (const s of silences) {
    const len = s.end - s.start;
    if (len >= 1.0 && len > longestLen) {
      longest = s;
      longestLen = len;
    }
  }
  if (!longest) return DEFAULT_NOISE_FLOOR_DB;

  const fp = Bun.which("ffmpeg");
  if (!fp) return DEFAULT_NOISE_FLOOR_DB;

  // Sample at most 2 s — enough for a stable mean, fast.
  const sampleLength = Math.min(2.0, longestLen);

  try {
    // info level + -nostats: volumedetect logs `mean_volume:` at info; the
    // 2 s sample keeps the output tiny regardless.
    const { exitCode: exit, stderr } = await spawnFfmpeg(fp, [
      "-y",
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-ss",
      String(longest.start),
      "-t",
      String(sampleLength),
      "-i",
      sourcePath,
      "-af",
      "volumedetect",
      "-vn",
      "-f",
      "null",
      "-",
    ]);
    if (exit !== 0) return DEFAULT_NOISE_FLOOR_DB;

    const match = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    if (!match?.[1]) return DEFAULT_NOISE_FLOOR_DB;

    const measured = Math.round(Number.parseFloat(match[1]));
    if (!Number.isFinite(measured)) return DEFAULT_NOISE_FLOOR_DB;
    return Math.max(NOISE_FLOOR_MIN_DB, Math.min(NOISE_FLOOR_MAX_DB, measured));
  } catch {
    return DEFAULT_NOISE_FLOOR_DB;
  }
}

// Parse the loudnorm JSON measurement block from ffmpeg stderr. The JSON
// appears after a "[Parsed_loudnorm_N @ ...]" line.
function parseLoudnormJson(stderr: string): LoudnormMeasurement {
  // Find the last JSON object in the output — loudnorm prints it at the end.
  const lastBrace = stderr.lastIndexOf("}");
  if (lastBrace === -1) throw new Error("No loudnorm JSON found in ffmpeg output");
  const firstBrace = stderr.lastIndexOf("{", lastBrace);
  if (firstBrace === -1) throw new Error("No loudnorm JSON found in ffmpeg output");

  const jsonStr = stderr.substring(firstBrace, lastBrace + 1);
  const data = JSON.parse(jsonStr) as Record<string, string>;

  const required = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
  for (const key of required) {
    if (!(key in data)) throw new Error(`Missing "${key}" in loudnorm JSON`);
  }

  return data as unknown as LoudnormMeasurement;
}

// Checks whether the arnndn model file exists. If not, audio processing
// is skipped with a clear error.
async function checkAudioModel(): Promise<boolean> {
  const file = Bun.file(ARNNDN_MODEL);
  if (!(await file.exists())) {
    console.error(
      `[derivatives] arnndn model not found at ${ARNNDN_MODEL} — audio processing will be skipped. ` +
        "Download cb.rnnn from https://github.com/richardpl/arnndn-models and place it in server/assets/audio-models/.",
    );
    return false;
  }
  return true;
}

// Two-pass audio processing from `inputPath` to `outputPath`: the video track is
// copied untouched, the audio is run through the chain above and re-encoded.
// Nothing is modified in place — this is what makes the pristine source.mp4
// possible, and what makes "reprocess with a better chain" a repeatable
// operation rather than a one-shot.
//
// `opts.noiseFloorDb` feeds afftdn. Callers profile it from the SOURCE (see
// profileNoiseFloor) even when the input here is an edited cut, because silence
// timestamps are in source coordinates; the measured floor is a property of the
// recording, not of the cut.
//
// Returns true when the audio was processed; false when it was skipped (no audio
// stream, or the arnndn model is missing) — in which case nothing is written and
// the caller is responsible for producing `outputPath` some other way.
export async function applyAudioChain(
  inputPath: string,
  outputPath: string,
  opts: { noiseFloorDb?: number } = {},
): Promise<boolean> {
  if (!(await hasAudioStream(inputPath))) return false;
  if (!(await checkAudioModel())) return false;

  const fp = Bun.which("ffmpeg");
  if (!fp) throw new Error("ffmpeg not found on PATH");

  const sourcePath = inputPath;
  const noiseFloorDb = opts.noiseFloorDb ?? DEFAULT_NOISE_FLOOR_DB;

  // Pass 1: measure loudness through the full denoise chain.
  //
  // MUST stay at `-loglevel info`: loudnorm's `print_format=json` measurement
  // block is logged at info level and is suppressed at `error`/`warning`
  // (verified on ffmpeg 8.1.1) — dropping the level would make parseLoudnormJson
  // throw and skip normalisation entirely. `-nostats` removes the per-second
  // progress line (the only unbounded-growth component); spawnFfmpeg's tail
  // bounds whatever remains.
  const { exitCode: pass1Exit, stderr: pass1Stderr } = await spawnFfmpeg(fp, [
    "-y",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-i",
    sourcePath,
    "-af",
    loudnormPass1Filter(noiseFloorDb),
    "-f",
    "null",
    "-",
  ]);
  if (pass1Exit !== 0) {
    throw new Error(`audio pass 1 failed (exit ${pass1Exit}): ${pass1Stderr.trim()}`);
  }

  const measurement = parseLoudnormJson(pass1Stderr);

  // Pass 2: apply the measured values, encode audio as AAC 160 kbps.
  const tmpOut = `${outputPath}.tmp`;
  const { exitCode: pass2Exit, stderr: pass2Stderr } = await spawnFfmpeg(fp, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-af",
    loudnormPass2Filter(noiseFloorDb, measurement),
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
    tmpOut,
  ]);
  if (pass2Exit !== 0) {
    await rm(tmpOut, { force: true }).catch(() => {});
    throw new Error(`audio pass 2 failed (exit ${pass2Exit}): ${pass2Stderr.trim()}`);
  }

  // Validate before the rename — an unplayable output must never land at
  // `outputPath`, where a staged swap or the serving gate could pick it up.
  if (!(await isProbablyPlayable(tmpOut))) {
    await rm(tmpOut, { force: true }).catch(() => {});
    throw new Error("audio output failed playability check");
  }

  await rename(tmpOut, outputPath);
  return true;
}

// Profile the noise floor for the audio chain from a file's silent regions.
// Exposed so the presentation step can measure the SOURCE and then run the chain
// over an edited cut. Returns the fixed default when there's nothing to measure.
export async function profileNoiseFloorFor(
  sourcePath: string,
  silences: Silence[] | undefined,
): Promise<number> {
  return profileNoiseFloor(sourcePath, silences);
}

// Remux a file into `outputPath` with both streams copied and the moov atom up
// front. Used for a presentation master that needs no audio work and no cuts —
// an upload, or a video whose source already carries processed audio — so the
// master is produced without re-encoding anything.
export async function remuxCopy(inputPath: string, outputPath: string): Promise<void> {
  const tmp = `${outputPath}.tmp`;
  try {
    await runFfmpeg(["-i", inputPath, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp]);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await rename(tmp, outputPath);
}

// --- Video variant generation ---

// Canonical downscaled-variant definitions, highest-first: the step kind, the
// target height, and the CRF quality. Single source of truth — the processing
// registry (which steps apply / how they run) and the viewer's <source> list
// (resolve.ts) both key off this, so a rendition can't be added to one place
// and forgotten in another.
export const VARIANTS: ReadonlyArray<{ kind: ProcessingStepKind; height: number; crf: number }> = [
  { kind: "variant_1080", height: 1080, crf: 20 },
  { kind: "variant_720", height: 720, crf: 23 },
];

// Build the ffmpeg argument list for a single variant encode.
//
// `-fps_mode passthrough` is load-bearing. Our HLS-origin source.mp4 is
// genuinely variable-frame-rate (the recorder's metronome emits at the
// sources' real delivery cadence, not a fixed grid — see the cadence rework
// in task 21) and carries no SPS VUI timing, so ffmpeg can only *guess* an
// `r_frame_rate` for it. That guess is frequently wrong and frequently *below*
// the real frame density (e.g. the HLS demuxer's 25 fps fallback on a 27 fps
// recording, or 30 declared on a ~53 fps recording). Without passthrough,
// libx264 re-times every frame onto that bogus constant grid and silently
// *drops* the surplus frames — a 27 fps source loses ~1 frame in 13, a 53 fps
// source loses nearly half — degrading the variant with judder. Passthrough
// honours the source PTS verbatim, so every real frame survives regardless of
// what r_frame_rate the container declares. We deliberately do NOT force a
// CFR `-r`: the input is honestly VFR and forcing a rate would either drop
// frames (rate too low) or duplicate them (rate too high). ffmpeg nudges any
// equal-DTS collisions by a tick during muxing, so the output container stays
// monotonic and plays cleanly.
export function _variantFfmpegArgs(
  sourcePath: string,
  height: number,
  crf: number,
  outPath: string,
): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-fps_mode",
    "passthrough",
    "-vf",
    `scale=-2:${height}`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    String(crf),
    "-profile:v",
    "high",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outPath,
  ];
}

// Generate a single downsampled variant (e.g. 720p.mp4) from `sourcePath`.
// Writes <height>p.mp4.tmp then renames atomically. Throws on ffmpeg failure.
export async function generateVariant(
  dir: string,
  height: number,
  sourcePath: string,
): Promise<void> {
  const crf = VARIANTS.find((v) => v.height === height)?.crf ?? 23;
  const outFile = `${height}p.mp4`;
  const tmpPath = join(dir, `${outFile}.tmp`);
  const finalPath = join(dir, outFile);
  const started = Date.now();

  const fp = Bun.which("ffmpeg");
  if (!fp) throw new Error("ffmpeg not found on PATH");

  const { exitCode, stderr } = await spawnFfmpeg(
    fp,
    _variantFfmpegArgs(sourcePath, height, crf, tmpPath),
  );
  if (exitCode !== 0) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw new Error(`variant ${outFile} failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  await rename(tmpPath, finalPath);
  console.log(`[derivatives] ${outFile} generated (${Date.now() - started}ms)`);
}

// Test-only: expose for direct testing.
export { parseLoudnormJson as _parseLoudnormJson };
