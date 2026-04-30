// Applies an edit decision list (EDL) to a video's source.mp4, producing
// an edited output named by resolution (e.g. 1440p.mp4). Triggers
// re-generation of downscaled variants, storyboard, and edited captions.

import { eq } from "drizzle-orm";
import { rename } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { purgeVideo } from "./cdn";
import {
  computeKeptSegments,
  deriveEditedTranscript,
  type Edit,
  type Segment,
  type Word,
} from "./edit-transcript";
import { logEvent } from "./events";
import { nowIso } from "./format";
import { generatePeaks } from "./peaks";
import { DATA_DIR, getVideo, upsertTranscript } from "./store";
import { generateEditorStoryboard, generateStoryboard } from "./storyboard";

export type Edl = {
  version: number;
  source: string;
  edits: Edit[];
};

// In-flight edit operations, similar to the derivatives pattern.
const inFlight = new Map<string, Promise<void>>();

export function applyEdits(videoId: string): void {
  if (inFlight.has(videoId)) return;
  const p = runEditPipeline(videoId).finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, p);
  p.catch((err) => {
    console.error(`[edit-pipeline] ${videoId} failed:`, err);
  });
}

// Test-only: returns the in-flight promise for awaiting in tests.
export function _editInFlightPromise(videoId: string): Promise<void> | undefined {
  return inFlight.get(videoId);
}

// --- Pipeline ---

async function runEditPipeline(videoId: string): Promise<void> {
  const started = Date.now();
  const derivDir = join(DATA_DIR, videoId, "derivatives");

  // 1. Read the EDL.
  const edlPath = join(derivDir, "edits.json");
  const edlFile = Bun.file(edlPath);
  if (!(await edlFile.exists())) {
    throw new Error("No edits.json found");
  }
  const edl = (await edlFile.json()) as Edl;

  // 2. Probe source resolution.
  const sourcePath = join(derivDir, "source.mp4");
  const meta = await probeMetadata(sourcePath);
  if (!meta) throw new Error("Could not probe source.mp4 metadata");

  // 3. Compute kept segments.
  const duration = await probeDuration(sourcePath);
  if (duration === null) throw new Error("Could not probe source.mp4 duration");

  const keptSegments = computeKeptSegments(edl.edits, duration);
  if (keptSegments.length === 0) {
    throw new Error("All content would be removed by edits");
  }

  // 4. Run ffmpeg to produce the edited video at source resolution.
  const outputFile = `${meta.height}p.mp4`;
  const outputPath = join(derivDir, outputFile);
  const tmpPath = join(derivDir, `${outputFile}.tmp`);

  const args = buildFfmpegEditArgs(sourcePath, tmpPath, keptSegments);
  await runFfmpeg(args);
  await rename(tmpPath, outputPath);
  console.log(`[edit-pipeline] ${videoId}/${outputFile} produced`);

  // 5. Regenerate downscaled variants from the edited output.
  try {
    await generateEditedVariants(derivDir, outputPath, meta.height);
  } catch (err) {
    console.error(
      `[edit-pipeline] ${videoId} variant generation failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 6. Regenerate viewer-facing storyboard from edited output.
  const editedDuration = await probeDuration(outputPath);
  if (editedDuration !== null && editedDuration >= 60) {
    try {
      await generateStoryboard(derivDir, editedDuration, outputPath);
      console.log(`[edit-pipeline] ${videoId}/storyboard regenerated`);
    } catch (err) {
      console.error(
        `[edit-pipeline] ${videoId} storyboard regeneration failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 7. Regenerate editor storyboard from edited output.
  if (editedDuration !== null && editedDuration >= 5) {
    try {
      await generateEditorStoryboard(derivDir, editedDuration, outputPath);
      console.log(`[edit-pipeline] ${videoId}/editor-storyboard regenerated`);
    } catch (err) {
      console.error(
        `[edit-pipeline] ${videoId} editor storyboard regeneration failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 8. Regenerate peaks from the edited output.
  if (editedDuration !== null) {
    try {
      await generatePeaks(derivDir, editedDuration, outputPath);
      console.log(`[edit-pipeline] ${videoId}/peaks.json regenerated`);
    } catch (err) {
      console.error(
        `[edit-pipeline] ${videoId} peaks regeneration failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 9. Derive edited captions from words.json + EDL.
  try {
    await deriveEditedCaptions(videoId, derivDir, keptSegments);
  } catch (err) {
    console.error(
      `[edit-pipeline] ${videoId} caption derivation failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 10. Update DB metadata from the edited output.
  const editedMeta = await probeMetadata(outputPath);
  if (editedMeta && editedDuration !== null) {
    await getDb()
      .update(videos)
      .set({
        durationSeconds: editedDuration,
        fileBytes: editedMeta.fileBytes,
        lastEditedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(videos.id, videoId));
  }

  // 11. Purge CDN cache.
  const video = await getVideo(videoId);
  if (video) {
    purgeVideo(video.slug);
  }

  const totalMs = Date.now() - started;
  await logEvent(videoId, "edits_committed", { durationMs: totalMs, edits: edl.edits.length });
  console.log(`[edit-pipeline] ${videoId} complete (${totalMs}ms)`);
}

// --- Helpers ---

async function deriveEditedCaptions(
  videoId: string,
  derivDir: string,
  keptSegments: Segment[],
): Promise<void> {
  const wordsPath = join(derivDir, "words.json");
  const wordsFile = Bun.file(wordsPath);
  if (!(await wordsFile.exists())) return;

  const originalWords = (await wordsFile.json()) as Word[];
  const result = deriveEditedTranscript(originalWords, keptSegments);

  // Write edited captions.srt (overwrite — the original is recoverable from words.json).
  if (result.srt) {
    const srtPath = join(derivDir, "captions.srt");
    await Bun.write(srtPath, result.srt);
  }

  // Update DB transcript with edited plain text.
  if (result.plainText) {
    await upsertTranscript(videoId, "srt", result.plainText);
  }
}

function buildFfmpegEditArgs(sourcePath: string, outputPath: string, kept: Segment[]): string[] {
  if (kept.length === 1) {
    // Simple trim — no complex filter needed.
    const seg = kept[0]!;
    return [
      "-i",
      sourcePath,
      "-ss",
      String(seg.start),
      "-to",
      String(seg.end),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outputPath,
    ];
  }

  // Complex filter for multiple kept segments with audio crossfade at joins.
  const CROSSFADE_MS = 0.03; // 30ms audio crossfade to prevent clicks.
  const vSelects: string[] = [];
  const aSelects: string[] = [];

  for (let i = 0; i < kept.length; i++) {
    const seg = kept[i]!;
    vSelects.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    aSelects.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
  }

  const vInputs = kept.map((_, i) => `[v${i}]`).join("");
  const aInputs = kept.map((_, i) => `[a${i}]`).join("");

  const filterComplex = [
    ...vSelects,
    ...aSelects,
    `${vInputs}concat=n=${kept.length}:v=1:a=0[vout]`,
    `${aInputs}concat=n=${kept.length}:v=0:a=1[apre]`,
    // Short fade-in to prevent clicks at concat join points.
    `[apre]afade=t=in:d=${CROSSFADE_MS}[aout]`,
  ].join(";");

  return [
    "-i",
    sourcePath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}

// Variant generation from an edited source (not source.mp4).
const VARIANTS = [
  { height: 1080, crf: 20 },
  { height: 720, crf: 23 },
] as const;

async function generateEditedVariants(
  derivDir: string,
  editedPath: string,
  sourceHeight: number,
): Promise<void> {
  const needed = VARIANTS.filter((v) => sourceHeight > v.height);
  if (needed.length === 0) return;

  for (const variant of needed) {
    const outFile = `${variant.height}p.mp4`;
    const tmpPath = join(derivDir, `${outFile}.tmp`);
    const finalPath = join(derivDir, outFile);

    await runFfmpeg([
      "-i",
      editedPath,
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
    ]);
    await rename(tmpPath, finalPath);
    console.log(`[edit-pipeline] ${outFile} regenerated`);
  }
}

// --- ffmpeg / ffprobe wrappers ---

let ffmpegPath: string | null | undefined;

async function runFfmpeg(args: string[]): Promise<void> {
  if (ffmpegPath === undefined) {
    ffmpegPath = Bun.which("ffmpeg");
  }
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const proc = Bun.spawn([ffmpegPath, "-y", "-hide_banner", "-loglevel", "error", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${stderr.trim()}`);
  }
}

type ProbeMetadata = { width: number; height: number; fileBytes: number };

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

async function probeDuration(filePath: string): Promise<number | null> {
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

// Exported for tests.
export { buildFfmpegEditArgs as _buildFfmpegEditArgs, computeKeptSegments };
