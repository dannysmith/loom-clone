// Washing a committed edit away so a BUILD reprocess can rebuild a consistent,
// UNEDITED video from source.mp4. Called from the pipeline's reprocess chokepoint
// before a build run on a video with lastEditedAt set. (The edit itself now runs
// as an `edit`-mode pipeline run — see processing/registry.ts + pipeline.ts.)

import { eq } from "drizzle-orm";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { probeDuration, probeMetadata } from "./derivatives";
import { deriveEditedTranscript, type Word } from "./edit-transcript";
import { logEvent } from "./events";
import { nowIso } from "./format";
import { markStepSkipped } from "./processing/steps-store";
import { DATA_DIR, getVideo, upsertTranscript } from "./store";

// Wash a committed edit away so the build pipeline can rebuild a consistent,
// UNEDITED video from source.mp4: a build run is edit-unaware and would otherwise
// regenerate the downscaled variants from the full source while the active raw
// file stayed the (shorter) edited cut, leaving the quality menu jumping
// content/length. No-op for an unedited video.
//
// It deletes the edited MP4 outputs and the edited viewer storyboard (a resumable
// run skips files that are still present, so they must be removed up front; the
// build pipeline then regenerates the applicable ones from the full source),
// re-derives the full transcript/captions from the unedited words.json, resets
// the cached metadata from source.mp4, and clears lastEditedAt. source.mp4, the
// thumbnail, peaks and the editor storyboard already reflect the original, so
// they're left alone.
export async function resetAllEdits(videoId: string): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video?.lastEditedAt) return;

  const derivDir = join(DATA_DIR, videoId, "derivatives");
  const sourcePath = join(derivDir, "source.mp4");

  const [meta, duration] = await Promise.all([
    probeMetadata(sourcePath),
    probeDuration(sourcePath),
  ]);
  if (!meta || duration === null) {
    throw new Error(`resetAllEdits: cannot probe source.mp4 for ${videoId}`);
  }

  // Re-derive the full transcript + captions.srt from the unedited words.json.
  // The edit overwrote both with the edited cut and the original isn't preserved
  // separately, so reconstruct it (one kept segment spanning the whole source).
  const wordsFile = Bun.file(join(derivDir, "words.json"));
  if (await wordsFile.exists()) {
    const words = (await wordsFile.json()) as Word[];
    const full = deriveEditedTranscript(words, [{ start: 0, end: duration }]);
    if (full.srt) await Bun.write(join(derivDir, "captions.srt"), full.srt);
    if (full.plainText) await upsertTranscript(videoId, "srt", full.plainText);
  }

  // Flip the DB to unedited FIRST, then delete the edited files. If a failure
  // strands the cleanup, the video is already unedited (activeRawFilename →
  // source.mp4, which still serves) with some harmless orphaned files — never
  // still-marked-edited with its active file deleted. Clear lastEditedAt + reset
  // the cached metadata to the original source, and settle the edited_output
  // ledger row so it isn't a phantom `ready`.
  await markStepSkipped(videoId, "edited_output");
  await getDb()
    .update(videos)
    .set({
      lastEditedAt: null,
      durationSeconds: duration,
      fileBytes: meta.fileBytes,
      width: meta.width,
      height: meta.height,
      aspectRatio: Math.round((meta.width / meta.height) * 10000) / 10000,
      updatedAt: nowIso(),
    })
    .where(eq(videos.id, videoId));

  // Delete the edited outputs the build pipeline won't otherwise overwrite on a
  // resumable run: the source-resolution {H}p.mp4, the downscaled {720,1080}p.mp4
  // variants, the edited viewer storyboard, and edits.json. The build pipeline
  // (run next, from the reprocess chokepoint) regenerates the applicable
  // variants/storyboard from the full source.
  const entries = await readdir(derivDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((f) => /^\d+p\.mp4$/.test(f) || f === "storyboard.vtt" || f === "edits.json")
      .map((f) => rm(join(derivDir, f), { force: true })),
  );

  await logEvent(videoId, "edits_reset");
  console.log(`[edit-reset] ${videoId} edits reset — rebuilding from source.mp4`);
}
