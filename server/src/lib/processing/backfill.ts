// Infer video_processing_steps rows from what's on disk. Used by the one-time
// backfill script for existing videos and by duplicateVideo (which copies files
// but not step rows, so the copy would otherwise have derivatives yet fail the
// table-gated serving check).
//
// Validates video artifacts with the same isProbablyPlayable helper used at
// generation time, so a backfilled video serves exactly what it should:
// cleaned-up videos (no HLS) keep their `source` step `ready` and simply lack
// the segment-derived steps — they are never flagged as needing repair.

import { join } from "path";
import type { ProcessingStepKind } from "../../db/schema";
import { probeMetadata } from "../derivatives";
import { hasAudioStream } from "../ffprobe";
import { getTranscript, getVideo } from "../store";
import { isProbablyPlayable } from "./playable";
import {
  applicabilityContext,
  PROCESSING_STEPS,
  type StepContext,
  sourceExpectedDuration,
} from "./registry";
import { fileSizeBytes, markStepFailed, markStepReady, markStepSkipped } from "./steps-store";

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

// Infer and persist step rows for one video from on-disk presence. Idempotent.
export async function inferStepsFromDisk(videoId: string): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video) return;
  const ctx = applicabilityContext(video);
  const sourceFile = join(ctx.dir, "source.mp4");

  for (const step of PROCESSING_STEPS) {
    if (!step.appliesTo(ctx)) continue;
    await inferStep(step.kind, ctx, sourceFile);
  }
}

async function inferStep(
  kind: ProcessingStepKind,
  ctx: StepContext,
  sourceFile: string,
): Promise<void> {
  const { videoId, dir } = ctx;

  switch (kind) {
    case "source": {
      if (!(await exists(sourceFile))) return; // no row — nothing to serve
      const ok = await isProbablyPlayable(sourceFile, {
        expectedDuration: sourceExpectedDuration(ctx),
      });
      if (ok) await markStepReady(videoId, "source", { sizeBytes: fileSizeBytes(sourceFile) });
      else await markStepFailed(videoId, "source", "backfill: source.mp4 failed playability check");
      return;
    }
    case "metadata": {
      // Stored dimensions imply metadata extraction succeeded previously.
      if (ctx.video.width && ctx.video.height) await markStepReady(videoId, "metadata");
      else if (await exists(sourceFile)) {
        const meta = await probeMetadata(sourceFile);
        if (meta) await markStepReady(videoId, "metadata");
      }
      return;
    }
    case "audio": {
      // No standalone artifact — assume processed if the source carries audio.
      // This is a deliberate fidelity trade-off: a recorded video whose source
      // has audio is marked `ready` even though we can't tell whether loudnorm
      // actually ran (e.g. a pre-task-4 video, or a duplicate). A non-force
      // reprocess then skips audio; a force from-HLS rebuild is the way to
      // actually (re-)loudnorm such a video.
      if (!(await exists(sourceFile))) return;
      if (await hasAudioStream(sourceFile)) await markStepReady(videoId, "audio");
      else await markStepSkipped(videoId, "audio");
      return;
    }
    case "variant_1080":
    case "variant_720": {
      const file = join(dir, `${kind === "variant_1080" ? 1080 : 720}p.mp4`);
      if (!(await exists(file))) return;
      const ok = await isProbablyPlayable(file);
      if (ok) await markStepReady(videoId, kind, { sizeBytes: fileSizeBytes(file) });
      else await markStepFailed(videoId, kind, "backfill: variant failed playability check");
      return;
    }
    case "thumbnail":
      if (await exists(join(dir, "thumbnail.jpg"))) await markStepReady(videoId, "thumbnail");
      return;
    case "storyboard":
      if (await exists(join(dir, "storyboard.vtt"))) await markStepReady(videoId, "storyboard");
      return;
    case "peaks":
      if (await exists(join(dir, "peaks.json"))) await markStepReady(videoId, "peaks");
      return;
    case "suggested_edits":
      if (await exists(join(dir, "suggested-edits.json")))
        await markStepReady(videoId, "suggested_edits");
      return;
    case "transcript":
      if (await getTranscript(videoId)) await markStepReady(videoId, "transcript");
      return;
    case "words":
      if (await exists(join(dir, "words.json"))) await markStepReady(videoId, "words");
      return;
    // The remaining external suggestion items (title/description/chapter_titles)
    // leave no inferable on-disk trace — leave them absent ("—").
    default:
      return;
  }
}
