#!/usr/bin/env bun
/**
 * One-time backfill of the video_processing_steps table for existing videos.
 * The 0012 migration renamed `complete` → `ready` but could not create step
 * rows (that needs ffprobe validation), so until this runs, table-gated serving
 * has nothing to gate on. Run it immediately after deploying the migration.
 *
 * It infers each step's state from on-disk presence, validating source.mp4 /
 * variants with the same isProbablyPlayable helper used at generation time.
 * It does NOT regenerate anything — many old videos no longer have HLS segments
 * (cleaned up) and couldn't be rebuilt anyway. Cleaned-up videos keep their
 * `source` step `ready` (so they keep serving the MP4) and simply lack the
 * segment-derived steps. Idempotent — safe to re-run.
 *
 * Usage:
 *   bun run videos:backfill-processing-steps
 */
import { initDb } from "../src/db/client";
import { inferStepsFromDisk } from "../src/lib/processing/backfill";
import { recoverStrandedReprocessing } from "../src/lib/processing/reconcile";
import { getStepStates } from "../src/lib/processing/steps-store";
import { listVideos } from "../src/lib/store";

async function main(): Promise<number> {
  await initDb();

  const videos = await listVideos({ includeTrashed: true });
  console.log(`Found ${videos.length} videos to backfill.\n`);

  let processed = 0;
  let failed = 0;

  for (const video of videos) {
    try {
      await inferStepsFromDisk(video.id);
      const steps = await getStepStates(video.id);
      const ready = [...steps.values()].filter((s) => s.state === "ready").map((s) => s.kind);
      const source = steps.get("source")?.state ?? "—";
      console.log(
        `  OK    ${video.id}  ${video.slug}  source=${source}  ready=[${ready.join(", ")}]`,
      );
      processed++;
    } catch (err) {
      console.error(`  FAIL  ${video.id}  ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  // Now that step rows exist, settle any video the 0012 migration parked in
  // `reprocessing` (a mid-edit video at migration time) back to `ready`.
  await recoverStrandedReprocessing();

  console.log(`\nDone: ${processed} processed, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

const code = await main();
process.exit(code);
