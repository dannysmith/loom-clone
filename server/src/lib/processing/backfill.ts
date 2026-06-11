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
import { probeMetadata } from "../derivatives";
import { hasAudioStream } from "../ffprobe";
import { getTranscript, getVideo } from "../store";
import {
  applicabilityContext,
  PROCESSING_STEPS,
  type ProcessingStep,
  type StepContext,
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
    await inferStep(step, ctx, sourceFile);
  }
}

async function inferStep(
  step: ProcessingStep,
  ctx: StepContext,
  sourceFile: string,
): Promise<void> {
  const { videoId, dir } = ctx;

  // The few steps with no servable artifact need bespoke inference; everything
  // else is driven off the registry's artifact()/validate() below.
  switch (step.kind) {
    case "metadata":
      // Stored dimensions imply metadata extraction succeeded previously.
      if (ctx.video.width && ctx.video.height) await markStepReady(videoId, "metadata");
      else if (await exists(sourceFile)) {
        const meta = await probeMetadata(sourceFile);
        if (meta) await markStepReady(videoId, "metadata");
      }
      return;
    case "audio":
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
    case "transcript":
      if (await getTranscript(videoId)) await markStepReady(videoId, "transcript");
      return;
    case "words":
      // External (Mac-sent), so no registry artifact — but it does leave
      // words.json on disk, so it's inferable.
      if (await exists(join(dir, "words.json"))) await markStepReady(videoId, "words");
      return;
  }

  // Generic file-producing steps (source, variants, thumbnail, storyboard,
  // peaks, suggested_edits): validate against the SAME artifact()/validate() the
  // pipeline used at generation time, off the registry — so renaming an artifact
  // can't silently break backfill/duplicate. The remaining external suggestion
  // items (title/description/chapter_titles) have no artifact and leave no
  // on-disk trace, so they fall through here as "—".
  const path = step.artifact?.(ctx);
  if (!path) return;
  if (!(await exists(path))) return; // no row — nothing to serve
  const ok = step.validate ? await step.validate(ctx) : true;
  if (ok) await markStepReady(videoId, step.kind, { sizeBytes: fileSizeBytes(path) });
  else await markStepFailed(videoId, step.kind, `backfill: ${step.kind} failed validation`);
}
