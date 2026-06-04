import { eq } from "drizzle-orm";
import { rename, rm } from "fs/promises";
import { join, resolve } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { spawnFfmpeg } from "./ffmpeg";
import { isProbablyPlayable } from "./processing/playable";
import { DATA_DIR } from "./store";
import type { Silence } from "./suggested-edits";

// Resolved absolutely so it survives test chdir() calls.
const ARNNDN_MODEL = resolve(import.meta.dir, "../../assets/audio-models/cb.rnnn");

// Low-level derivative generators. Each writes `<name>.tmp` then renames it
// atomically to its final name on success, so a crash mid-generation leaves
// either a stale-but-complete final file or nothing at all — never a
// half-written output. Orchestration (ordering, step tracking, status
// reconciliation) lives in ./processing/pipeline.ts; this module only knows
// how to produce individual files.

export function derivativesDir(videoId: string): string {
  return join(DATA_DIR, videoId, "derivatives");
}

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

// Stitch the converged HLS segments into derivatives/source.mp4 (recorded
// videos). Writes source.mp4.tmp then renames atomically.
export async function generateSourceFromHls(videoId: string, dir: string): Promise<void> {
  const playlist = join(DATA_DIR, videoId, "stream.m3u8");
  const tmp = join(dir, "source.mp4.tmp");
  const final = join(dir, "source.mp4");
  await runFfmpeg([
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
  ]);
  await rename(tmp, final);
}

// Remux an uploaded upload.mp4 → derivatives/source.mp4 with faststart
// (uploaded videos — no HLS segments exist).
export async function generateSourceFromUpload(videoId: string, dir: string): Promise<void> {
  const input = join(DATA_DIR, videoId, "upload.mp4");
  const tmp = join(dir, "source.mp4.tmp");
  const final = join(dir, "source.mp4");
  await runFfmpeg(["-i", input, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp]);
  await rename(tmp, final);
}

// Probe duration of a video file using ffprobe. Returns seconds or null
// if ffprobe fails or isn't available.
export async function probeDuration(filePath: string): Promise<number | null> {
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) return null;

  try {
    const proc = Bun.spawn(
      [ffprobePath, "-v", "quiet", "-print_format", "json", "-show_format", filePath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const data = JSON.parse(stdout) as { format?: { duration?: string } };
    const d = Number.parseFloat(data.format?.duration ?? "");
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

// Full video metadata from ffprobe: dimensions and file size.
export type ProbeMetadata = {
  width: number;
  height: number;
  fileBytes: number;
};

export async function probeMetadata(filePath: string): Promise<ProbeMetadata | null> {
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) return null;

  try {
    const proc = Bun.spawn(
      [
        ffprobePath,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-select_streams",
        "v:0",
        filePath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;

    const data = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { size?: string };
    };

    const stream = data.streams?.[0];
    const w = stream?.width;
    const h = stream?.height;
    const size = Number.parseInt(data.format?.size ?? "", 10);

    if (!w || !h || !Number.isFinite(size)) return null;
    return { width: w, height: h, fileBytes: size };
  } catch {
    return null;
  }
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

// Extracts metadata from source.mp4 and recording.json, writes it to the DB.
// Doesn't produce a file — it's a mandatory pipeline step (gates `ready`).
// Returns false when ffprobe fails/unavailable so the step is marked failed.
export async function extractMetadata(videoId: string): Promise<boolean> {
  const dir = derivativesDir(videoId);
  const sourcePath = join(dir, "source.mp4");
  const videoDir = join(DATA_DIR, videoId);

  const [probe, recording] = await Promise.all([
    probeMetadata(sourcePath),
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
      fileBytes: probe.fileBytes,
      cameraName: recording.cameraName,
      microphoneName: recording.microphoneName,
      recordingHealth: recording.recordingHealth,
    })
    .where(eq(videos.id, videoId));

  console.log(
    `[derivatives] ${videoId} metadata: ${probe.width}x${probe.height}, ${probe.fileBytes} bytes`,
  );
  return true;
}

// Re-probe source.mp4 and update the cached fileBytes. Used after in-place
// audio replacement, which runs AFTER metadata extraction (so the byte count
// recorded by extractMetadata reflects the pre-loudnorm source). Dimensions
// don't change with audio processing, so only fileBytes needs refreshing.
export async function refreshFileBytes(videoId: string): Promise<void> {
  const sourcePath = join(derivativesDir(videoId), "source.mp4");
  const probe = await probeMetadata(sourcePath);
  if (!probe) return;
  await getDb().update(videos).set({ fileBytes: probe.fileBytes }).where(eq(videos.id, videoId));
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

function audioFilterChain(noiseFloorDb: number): string {
  // Linear threshold for -45 dBFS = 10^(-45/20) ≈ 0.0056. Hardcoded rather
  // than computed at call time — the gate threshold is a tuned constant.
  const filters = [
    "highpass=f=80",
    `arnndn=m=${ARNNDN_MODEL}`,
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

// Check whether a file contains an audio stream.
async function hasAudioStream(filePath: string): Promise<boolean> {
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) return false;
  try {
    const proc = Bun.spawn(
      [
        ffprobePath,
        "-v",
        "quiet",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 && stdout.trim().includes("audio");
  } catch {
    return false;
  }
}

// Two-pass audio processing on an existing source.mp4. Replaces it in-place
// with the processed version (video copied, audio re-encoded). The
// `silences` argument feeds the afftdn noise-floor profile; if omitted the
// chain falls back to a fixed -50 dB noise floor.
// Returns true when the source was actually re-encoded (loudnormed) and
// replaced in place; false when audio processing was skipped (no audio stream
// or the arnndn model is missing) — in which case the original source.mp4 is
// left untouched and remains fully playable.
export async function processAudio(sourcePath: string, silences?: Silence[]): Promise<boolean> {
  if (!(await hasAudioStream(sourcePath))) return false;
  if (!(await checkAudioModel())) return false;

  const fp = Bun.which("ffmpeg");
  if (!fp) throw new Error("ffmpeg not found on PATH");

  const noiseFloorDb = await profileNoiseFloor(sourcePath, silences);

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
  const tmpOut = `${sourcePath}.audio-tmp`;
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

  // Validate the processed file BEFORE overwriting the good served source —
  // never replace a known-playable file with an unvalidated one.
  if (!(await isProbablyPlayable(tmpOut))) {
    await rm(tmpOut, { force: true }).catch(() => {});
    throw new Error("audio output failed playability check — keeping original source.mp4");
  }

  // Atomic replace: rename processed file over the original.
  await rename(tmpOut, sourcePath);
  return true;
}

// --- Video variant generation ---

// Variant definitions: target height and CRF quality.
const VARIANTS = [
  { height: 1080, crf: 20 },
  { height: 720, crf: 23 },
] as const;

// Determine which variants to generate based on source height.
// ≤720p: nothing. 721–1080p: 720p only. ≥1081p: 1080p and 720p.
function variantsForHeight(sourceHeight: number): Array<{ height: number; crf: number }> {
  return VARIANTS.filter((v) => sourceHeight > v.height);
}

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

// Generate all downsampled MP4 variants needed for a source. When inputPath is
// provided (e.g. an edited output) variants come from that file instead of
// source.mp4. Used by the edit-pipeline's atomic regeneration; the main
// post-recording pipeline drives variants per-height via the step registry.
export async function generateVariants(dir: string, inputPath?: string): Promise<void> {
  const sourcePath = inputPath ?? join(dir, "source.mp4");
  const meta = await probeMetadata(sourcePath);
  if (!meta) return;

  for (const variant of variantsForHeight(meta.height)) {
    await generateVariant(dir, variant.height, sourcePath);
  }
}

// Test-only: expose for direct testing.
export { parseLoudnormJson as _parseLoudnormJson, variantsForHeight as _variantsForHeight };
