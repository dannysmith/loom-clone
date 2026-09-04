#!/usr/bin/env bun
/**
 * Rebuild the video_processing_steps table for existing videos from what's on
 * disk. The ledger is a receipt rather than an inventory, which makes it
 * re-derivable: this script is the recovery path whenever those rows are wrong
 * or missing — after a schema change that adds step kinds, or if a data
 * migration mis-keys them.
 *
 * It infers each step's state from on-disk presence, validating video artifacts
 * with the same isProbablyPlayable helper used at generation time. It does NOT
 * regenerate anything — many old videos no longer have HLS segments (cleaned up)
 * and couldn't be rebuilt anyway. Idempotent, so it's always safe to re-run.
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
