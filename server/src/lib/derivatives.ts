import { eq } from "drizzle-orm";
import { mkdir, rename, rm } from "fs/promises";
import { join, resolve } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { logEvent } from "./events";
import { generatePeaks } from "./peaks";
import { DATA_DIR, getVideo } from "./store";
import { generateEditorStoryboard, generateStoryboard } from "./storyboard";
import { generateSuggestedEdits } from "./suggested-edits";
import { extractAndPromoteThumbnails } from "./thumbnails";

// Resolved absolutely so it survives test chdir() calls.
const ARNNDN_MODEL = resolve(import.meta.dir, "../../assets/audio-models/cb.rnnn");

// A derivative is any file produced from the converged HLS segments. Each
// recipe declares its final output filename (relative to data/<id>/derivatives/)
// and a generator that writes `<filename>.tmp` into that directory. The
// orchestrator renames `.tmp` → final atomically on success, so a crash mid-
// generation leaves either a stale-but-complete final file or nothing at all —
// never a half-written output.
export interface Recipe {
  filename: string;
  generate(videoId: string, dir: string): Promise<void>;
}

function derivativesDir(videoId: string): string {
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

  const proc = Bun.spawn([ffmpegPath, "-y", "-hide_banner", "-loglevel", "error", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${stderr.trim()}`);
  }
}

// Reads the cached duration populated by setVideoStatus when the video
// transitions to `complete`. Derivatives are scheduled after that transition,
// so this is always set by the time the thumbnail recipe runs. Returns 0 for
// the rare case of a missing video record so ffmpeg just picks frame 0.
async function videoDuration(videoId: string): Promise<number> {
  const video = await getVideo(videoId, { includeTrashed: true });
  return video?.durationSeconds ?? 0;
}

const sourceMp4Recipe: Recipe = {
  filename: "source.mp4",
  async generate(videoId, dir) {
    const playlist = join(DATA_DIR, videoId, "stream.m3u8");
    const out = join(dir, "source.mp4.tmp");
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
      out,
    ]);
  },
};

// For uploaded videos: transcode upload.mp4 → derivatives/source.mp4 with faststart.
const uploadSourceRecipe: Recipe = {
  filename: "source.mp4",
  async generate(videoId, dir) {
    const input = join(DATA_DIR, videoId, "upload.mp4");
    const out = join(dir, "source.mp4.tmp");
    await runFfmpeg(["-i", input, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", out]);
  },
};

// Recipes run in order. source.mp4 must land before post-recipe steps.
// Thumbnail extraction is handled as a post-recipe step (not a Recipe) because
// it produces multiple files and manages its own atomicity.
const recipes: Recipe[] = [sourceMp4Recipe];
const uploadRecipes: Recipe[] = [uploadSourceRecipe];

const inFlight = new Map<string, Promise<void>>();

// Fire-and-forget. Repeated calls while a generation is in flight collapse to
// the same promise, preventing two ffmpegs from racing on the same video.
export function scheduleDerivatives(videoId: string): void {
  if (inFlight.has(videoId)) return;
  const p = generateDerivatives(videoId).finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, p);
  p.catch((err) => {
    console.error(`[derivatives] ${videoId} unexpected failure:`, err);
  });
}

// Test-only: returns the in-flight promise for a given video id so tests can
// await fire-and-forget generation. Undefined if nothing is running.
export function _inFlightPromise(videoId: string): Promise<void> | undefined {
  return inFlight.get(videoId);
}

// Fire-and-forget for uploaded videos. Uses uploadRecipes (no HLS → MP4 step).
export function scheduleUploadDerivatives(videoId: string): void {
  if (inFlight.has(videoId)) return;
  const p = generateFromRecipes(videoId, uploadRecipes).finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, p);
  p.catch((err) => {
    console.error(`[derivatives] ${videoId} upload derivatives failed:`, err);
  });
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
// Not a Recipe (doesn't produce a file) — called as a post-recipe step.
export async function extractMetadata(videoId: string): Promise<void> {
  const dir = derivativesDir(videoId);
  const sourcePath = join(dir, "source.mp4");
  const videoDir = join(DATA_DIR, videoId);

  const [probe, recording] = await Promise.all([
    probeMetadata(sourcePath),
    readRecordingJson(videoDir),
  ]);

  if (!probe) {
    console.warn(`[derivatives] ${videoId} metadata extraction: ffprobe failed or unavailable`);
    return;
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
}

// --- Audio processing: highpass → arnndn → two-pass loudnorm ---

// The audio filter chain applied to source.mp4. Denoises speech (arnndn with
// the cb.rnnn model), removes sub-speech rumble (highpass at 80 Hz), and
// normalises loudness to -14 LUFS (EBU R128 two-pass loudnorm). Video is
// copied untouched; only the audio track is re-encoded to AAC at 160 kbps.

type LoudnormMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

function audioFilterChain(): string {
  return `highpass=f=80,arnndn=m=${ARNNDN_MODEL}`;
}

function loudnormPass1Filter(): string {
  return `${audioFilterChain()},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`;
}

function loudnormPass2Filter(m: LoudnormMeasurement): string {
  return (
    `${audioFilterChain()},loudnorm=I=-14:TP=-1.5:LRA=11` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`
  );
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
// with the processed version (video copied, audio re-encoded).
export async function processAudio(sourcePath: string): Promise<void> {
  if (!(await hasAudioStream(sourcePath))) return;
  if (!(await checkAudioModel())) return;

  const fp = Bun.which("ffmpeg");
  if (!fp) throw new Error("ffmpeg not found on PATH");

  // Pass 1: measure loudness through the full denoise chain.
  const pass1 = Bun.spawn(
    [fp, "-y", "-hide_banner", "-i", sourcePath, "-af", loudnormPass1Filter(), "-f", "null", "-"],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [pass1Stderr, pass1Exit] = await Promise.all([
    new Response(pass1.stderr).text(),
    pass1.exited,
  ]);
  if (pass1Exit !== 0) {
    throw new Error(`audio pass 1 failed (exit ${pass1Exit}): ${pass1Stderr.trim()}`);
  }

  const measurement = parseLoudnormJson(pass1Stderr);

  // Pass 2: apply the measured values, encode audio as AAC 160 kbps.
  const tmpOut = `${sourcePath}.audio-tmp`;
  const pass2 = Bun.spawn(
    [
      fp,
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-af",
      loudnormPass2Filter(measurement),
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
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [pass2Stderr, pass2Exit] = await Promise.all([
    new Response(pass2.stderr).text(),
    pass2.exited,
  ]);
  if (pass2Exit !== 0) {
    await rm(tmpOut, { force: true }).catch(() => {});
    throw new Error(`audio pass 2 failed (exit ${pass2Exit}): ${pass2Stderr.trim()}`);
  }

  // Atomic replace: rename processed file over the original.
  await rename(tmpOut, sourcePath);
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

// Generate downsampled MP4 variants. When inputPath is provided (e.g. an
// edited output), variants are generated from that file instead of source.mp4.
export async function generateVariants(dir: string, inputPath?: string): Promise<void> {
  const sourcePath = inputPath ?? join(dir, "source.mp4");
  const meta = await probeMetadata(sourcePath);
  if (!meta) return;

  const needed = variantsForHeight(meta.height);
  if (needed.length === 0) return;

  const fp = Bun.which("ffmpeg");
  if (!fp) throw new Error("ffmpeg not found on PATH");

  for (const variant of needed) {
    const outFile = `${variant.height}p.mp4`;
    const tmpPath = join(dir, `${outFile}.tmp`);
    const finalPath = join(dir, outFile);
    const started = Date.now();

    const proc = Bun.spawn(
      [
        fp,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sourcePath,
        "-vf",
        `scale=-2:${variant.height}`,
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        String(variant.crf),
        "-profile:v",
        "high",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        tmpPath,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw new Error(`variant ${outFile} failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    await rename(tmpPath, finalPath);
    const ms = Date.now() - started;
    console.log(`[derivatives] ${outFile} generated (${ms}ms)`);
  }
}

// Test-only: expose for direct testing.
export { parseLoudnormJson as _parseLoudnormJson, variantsForHeight as _variantsForHeight };

async function generateDerivatives(videoId: string): Promise<void> {
  return generateFromRecipes(videoId, recipes);
}

async function generateFromRecipes(videoId: string, recipeList: Recipe[]): Promise<void> {
  const dir = derivativesDir(videoId);
  await mkdir(dir, { recursive: true });
  const pipelineStarted = Date.now();
  const steps: string[] = [];

  for (const recipe of recipeList) {
    const tmp = join(dir, `${recipe.filename}.tmp`);
    const final = join(dir, recipe.filename);
    const started = Date.now();
    try {
      await recipe.generate(videoId, dir);
      await rename(tmp, final);
      const ms = Date.now() - started;
      console.log(`[derivatives] ${videoId}/${recipe.filename} (${ms}ms)`);
    } catch (err) {
      console.error(
        `[derivatives] ${videoId}/${recipe.filename} failed:`,
        err instanceof Error ? err.message : err,
      );
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  // Post-recipe step 1: audio processing (denoise + loudnorm).
  // Runs before thumbnails and metadata so they see the final file.
  const sourcePath = join(dir, "source.mp4");
  const sourceExists = await Bun.file(sourcePath).exists();
  if (sourceExists) {
    const audioStarted = Date.now();
    try {
      await processAudio(sourcePath);
      const ms = Date.now() - audioStarted;
      console.log(`[derivatives] ${videoId}/audio processed (${ms}ms)`);
      steps.push("audio");
    } catch (err) {
      console.error(
        `[derivatives] ${videoId} audio processing failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Post-recipe step 2+3: thumbnail candidates + metadata extraction.
  // Both depend on source.mp4 existing.
  const duration = await videoDuration(videoId);
  try {
    await extractAndPromoteThumbnails(dir, duration);
    console.log(`[derivatives] ${videoId}/thumbnail candidates extracted`);
    steps.push("thumbnails");
  } catch (err) {
    console.error(
      `[derivatives] ${videoId} thumbnail extraction failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await extractMetadata(videoId);
    steps.push("metadata");
  } catch (err) {
    console.error(
      `[derivatives] ${videoId} metadata extraction failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Post-recipe step: delete upload.mp4 now that source.mp4 is confirmed valid.
  // For uploaded videos, upload.mp4 is the input that produced source.mp4 — keeping
  // both is pure waste. Gate on metadata success (fileBytes populated) so we never
  // delete the only copy of a video.
  if (sourceExists && steps.includes("metadata")) {
    const uploadPath = join(DATA_DIR, videoId, "upload.mp4");
    if (await Bun.file(uploadPath).exists()) {
      try {
        await rm(uploadPath, { force: true });
        console.log(`[derivatives] ${videoId} upload.mp4 deleted (source.mp4 confirmed)`);
      } catch (err) {
        console.error(
          `[derivatives] ${videoId} failed to delete upload.mp4:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Post-recipe step 4: generate downsampled variants (720p, 1080p).
  if (sourceExists) {
    try {
      await generateVariants(dir);
      steps.push("variants");
    } catch (err) {
      console.error(
        `[derivatives] ${videoId} variant generation failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Post-recipe step 5: storyboard sprite sheet + VTT (skipped for short videos).
  if (sourceExists && duration >= 60) {
    const storyStarted = Date.now();
    try {
      const generated = await generateStoryboard(dir, duration);
      if (generated) {
        const ms = Date.now() - storyStarted;
        console.log(`[derivatives] ${videoId}/storyboard generated (${ms}ms)`);
        steps.push("storyboard");
      }
    } catch (err) {
      console.error(
        `[derivatives] ${videoId} storyboard generation failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Post-recipe step 6: editor storyboard (dense frame extraction for the editing timeline).
  if (sourceExists && duration >= 5) {
    const editorStoryStarted = Date.now();
    try {
      const generated = await generateEditorStoryboard(dir, duration);
      if (generated) {
        const ms = Date.now() - editorStoryStarted;
        console.log(`[derivatives] ${videoId}/editor-storyboard generated (${ms}ms)`);
        steps.push("editor-storyboard");
      }
    } catch (err) {
      console.error(
        `[derivatives] ${videoId} editor storyboard generation failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Post-recipe step 7: audio peaks for wavesurfer.js.
  if (sourceExists && duration >= 1) {
    const peaksStarted = Date.now();
    try {
      const generated = await generatePeaks(dir, duration);
      if (generated) {
        const ms = Date.now() - peaksStarted;
        console.log(`[derivatives] ${videoId}/peaks.json generated (${ms}ms)`);
        steps.push("peaks");
      }
    } catch (err) {
      console.error(
        `[derivatives] ${videoId} peaks generation failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Post-recipe step 8: suggested edits from silence detection.
  // Skip if the user has already committed an edit (lastEditedAt set) — once
  // they've used the editor we never want to surface auto-suggestions again.
  // generateSuggestedEdits also no-ops when the file already exists, so a
  // repeat run from healing is idempotent.
  if (sourceExists && duration >= 5) {
    const video = await getVideo(videoId, { includeTrashed: true });
    if (!video?.lastEditedAt) {
      const suggestStarted = Date.now();
      try {
        const generated = await generateSuggestedEdits(dir, duration);
        if (generated) {
          const ms = Date.now() - suggestStarted;
          console.log(`[derivatives] ${videoId}/suggested-edits.json generated (${ms}ms)`);
          steps.push("suggested-edits");
        }
      } catch (err) {
        console.error(
          `[derivatives] ${videoId} suggested-edits generation failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Log a single summary event so the admin activity feed shows when
  // post-processing finished and what was produced.
  if (steps.length > 0) {
    const totalMs = Date.now() - pipelineStarted;
    try {
      await logEvent(videoId, "derivatives_ready", { steps, durationMs: totalMs });
    } catch {
      // DB may be gone in tests — don't let event logging crash the pipeline.
    }
  }
}
