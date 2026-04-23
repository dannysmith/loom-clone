import { eq } from "drizzle-orm";
import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { DATA_DIR, getVideo } from "./store";
import { extractAndPromoteThumbnails } from "./thumbnails";

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
type ProbeMetadata = {
  width: number;
  height: number;
  fileBytes: number;
};

async function probeMetadata(filePath: string): Promise<ProbeMetadata | null> {
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

async function generateDerivatives(videoId: string): Promise<void> {
  return generateFromRecipes(videoId, recipes);
}

async function generateFromRecipes(videoId: string, recipeList: Recipe[]): Promise<void> {
  const dir = derivativesDir(videoId);
  await mkdir(dir, { recursive: true });

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

  // Post-recipe steps: thumbnail candidates + metadata extraction.
  // Both depend on source.mp4 existing.
  const duration = await videoDuration(videoId);
  try {
    await extractAndPromoteThumbnails(dir, duration);
    console.log(`[derivatives] ${videoId}/thumbnail candidates extracted`);
  } catch (err) {
    console.error(
      `[derivatives] ${videoId} thumbnail extraction failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await extractMetadata(videoId);
  } catch (err) {
    console.error(
      `[derivatives] ${videoId} metadata extraction failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
