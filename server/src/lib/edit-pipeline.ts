// Applies an edit decision list (EDL) to a video's source.mp4, producing
// an edited output named by resolution (e.g. 1440p.mp4). Triggers
// re-generation of downscaled variants, storyboard, and edited captions.
//
// Edit regeneration is atomic-as-a-set (the reason `reprocessing` is its own
// status): the full regenerated set is built and validated in a side staging
// directory, then swapped into place in one fast pass of renames. A crash or
// failure during the slow generation phase leaves the previous outputs
// untouched — never a new {H}p.mp4 beside a stale variant or half-rewritten VTT.

import { eq } from "drizzle-orm";
import { mkdir, readdir, rename, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { purgeVideo } from "./cdn";
import { generateVariants, probeDuration, probeMetadata } from "./derivatives";
import {
  computeKeptSegments,
  deriveEditedTranscript,
  type Edit,
  type Segment,
  type Word,
} from "./edit-transcript";
import { logEvent } from "./events";
import { spawnFfmpeg } from "./ffmpeg";
import { nowIso } from "./format";
import { isProbablyPlayable } from "./processing/playable";
import { DATA_DIR, getVideo, upsertTranscript } from "./store";
import { generateStoryboard } from "./storyboard";

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

  // Mark the video as reprocessing so the UI shows the right state and
  // prevents concurrent edits. Post-edit regeneration must land as an atomic
  // set, which is why it gets its own status rather than reusing `processing`.
  await getDb()
    .update(videos)
    .set({ status: "reprocessing", updatedAt: nowIso() })
    .where(eq(videos.id, videoId));

  try {
    await _runEditPipelineInner(videoId, derivDir, started);
  } catch (err) {
    // Restore to ready on failure so the video isn't stuck in reprocessing
    // (the pre-edit source.mp4 is untouched and still serves).
    await getDb()
      .update(videos)
      .set({ status: "ready", updatedAt: nowIso() })
      .where(eq(videos.id, videoId));
    throw err;
  }
}

async function _runEditPipelineInner(
  videoId: string,
  derivDir: string,
  started: number,
): Promise<void> {
  // 1. Read the EDL.
  const edlPath = join(derivDir, "edits.json");
  const edlFile = Bun.file(edlPath);
  if (!(await edlFile.exists())) {
    throw new Error("No edits.json found");
  }
  const edl = (await edlFile.json()) as Edl;

  // 2. Probe source — get resolution and duration in one pass.
  const sourcePath = join(derivDir, "source.mp4");
  const [meta, duration] = await Promise.all([
    probeMetadata(sourcePath),
    probeDuration(sourcePath),
  ]);
  if (!meta) throw new Error(`Could not probe source.mp4 metadata at ${sourcePath}`);
  if (duration === null) throw new Error(`Could not probe source.mp4 duration at ${sourcePath}`);

  // 3. Compute kept segments.
  const keptSegments = computeKeptSegments(edl.edits, duration);
  if (keptSegments.length === 0) {
    throw new Error("All content would be removed by edits");
  }

  // 4. Build the full regenerated set in a staging directory. Generators write
  //    into `stagingDir` (their first arg); the real derivatives stay untouched
  //    until the whole set is validated and swapped. A failure anywhere here
  //    throws — the catch in runEditPipeline restores `ready` and the previous
  //    outputs are intact. Everything applicable is mandatory: a partial set
  //    would defeat the atomicity guarantee.
  const stagingDir = join(derivDir, ".edit-staging");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    // 4a. Edited video at source resolution.
    const outputFile = `${meta.height}p.mp4`;
    const stagedOutput = join(stagingDir, outputFile);
    const tmpPath = `${stagedOutput}.tmp`;
    await runFfmpeg(buildFfmpegEditArgs(sourcePath, tmpPath, keptSegments));
    await rename(tmpPath, stagedOutput);

    const editedDuration = (await probeDuration(stagedOutput)) ?? duration;

    // 4b. Downscaled variants, cut from the staged edited output.
    await generateVariants(stagingDir, stagedOutput);

    // 4c. Viewer storyboard (≥60s only). Editor-specific files
    //     (editor-storyboard, peaks.json) are NOT regenerated — the editor
    //     always works from source.mp4, so those reflect the original.
    if (editedDuration >= 60) {
      await generateStoryboard(stagingDir, editedDuration, stagedOutput);
    }

    // 4d. Edited captions (from the unchanged words.json + the EDL).
    const editedPlainText = await deriveEditedCaptions(derivDir, stagingDir, keptSegments);

    // 5. Validate every staged video file before touching the real ones.
    const stagedFiles = (await readdir(stagingDir)).filter((f) => !f.endsWith(".tmp"));
    for (const f of stagedFiles) {
      if (!f.endsWith(".mp4")) continue;
      const ok = await isProbablyPlayable(join(stagingDir, f), {
        expectedDuration: editedDuration,
      });
      if (!ok) throw new Error(`staged edited output ${f} failed playability check`);
    }

    // 6. Swap the validated set into place. Per-file renames within the same
    //    directory are atomic, and we only reach here once the whole set is
    //    built and validated — so there's no slow-generation window in which a
    //    new file can sit beside a stale one.
    for (const f of stagedFiles) {
      await rename(join(stagingDir, f), join(derivDir, f));
    }
    console.log(`[edit-pipeline] ${videoId} swapped ${stagedFiles.length} edited output(s)`);

    // 7. Update the DB transcript with the edited plain text (post-swap).
    if (editedPlainText) await upsertTranscript(videoId, "srt", editedPlainText);

    // 8. Update DB metadata from the now-in-place edited output and restore
    //    status to `ready`. lastEditedAt flips the active raw file to
    //    {H}p.mp4 — set only after the file is on disk so serving stays valid.
    const editedMeta = await probeMetadata(join(derivDir, outputFile));
    await getDb()
      .update(videos)
      .set({
        status: "ready",
        durationSeconds: editedMeta ? editedDuration : undefined,
        fileBytes: editedMeta?.fileBytes,
        lastEditedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(videos.id, videoId));

    // 9. Drop the suggested-edits.json file. Suggestions are a one-shot helper
    //    for the very first edit pass — once the user has committed, we never
    //    surface auto-suggestions again. The lastEditedAt flag (set above) also
    //    guards against the derivatives pipeline regenerating them on a heal.
    await rm(join(derivDir, "suggested-edits.json"), { force: true }).catch((err) => {
      console.warn(`[edit-pipeline] failed to remove suggested-edits.json for ${videoId}:`, err);
    });

    // 10. Purge CDN cache.
    const video = await getVideo(videoId);
    if (video) purgeVideo(video.slug);

    const totalMs = Date.now() - started;
    await logEvent(videoId, "edits_committed", { durationMs: totalMs, edits: edl.edits.length });
    console.log(`[edit-pipeline] ${videoId} complete (${totalMs}ms)`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Helpers ---

// Derives edited captions from the unchanged words.json + the EDL, writing
// captions.srt into `outDir` (the staging dir). Returns the edited plain text
// for the caller to upsert into the transcript after the swap, or null when
// there's no words.json to edit.
async function deriveEditedCaptions(
  derivDir: string,
  outDir: string,
  keptSegments: Segment[],
): Promise<string | null> {
  const wordsFile = Bun.file(join(derivDir, "words.json"));
  if (!(await wordsFile.exists())) return null;

  const originalWords = (await wordsFile.json()) as Word[];
  const result = deriveEditedTranscript(originalWords, keptSegments);

  if (result.srt) {
    await Bun.write(join(outDir, "captions.srt"), result.srt);
  }
  return result.plainText || null;
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
      // Honour the source PTS verbatim. source.mp4 is genuinely VFR with an
      // unreliable declared r_frame_rate (see _variantFfmpegArgs in
      // derivatives.ts); without passthrough, libx264 re-times frames onto the
      // bogus constant grid and silently drops the surplus.
      "-fps_mode",
      "passthrough",
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
    // VFR-safe: pass the concatenated filtergraph PTS straight through rather
    // than forcing a constant rate (see the simple-trim branch above).
    "-fps_mode",
    "passthrough",
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

// --- ffmpeg wrapper (local to this module — derivatives.ts has its own) ---

let ffmpegPath: string | null | undefined;

async function runFfmpeg(args: string[]): Promise<void> {
  if (ffmpegPath === undefined) {
    ffmpegPath = Bun.which("ffmpeg");
  }
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

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

// Exported for tests.
export { buildFfmpegEditArgs as _buildFfmpegEditArgs, computeKeptSegments };
