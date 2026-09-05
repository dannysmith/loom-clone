#!/usr/bin/env bun
/**
 * Migrate existing videos onto the presentation-master layout.
 *
 * Run this ONCE on the server after deploying the restructure. The DB half is
 * already done by then (drizzle 0015 applies on startup); this is the file half,
 * which needs ffmpeg and takes as long as copying every source.mp4.
 *
 * It never deletes or rewrites a video file. All it does is add the <H>p.mp4
 * presentation master (copied from source.mp4, which for a legacy video already
 * carries the audio chain) and seed captions.original.srt. Idempotent — an
 * interrupted run is fixed by running it again.
 *
 * Usage:
 *   bun run videos:migrate-presentation            # dry run: print the plan
 *   bun run videos:migrate-presentation --apply    # do it
 *
 * Afterwards, for any video whose HLS segments are still on disk, "Rebuild from
 * HLS" in the admin recovers a genuinely pristine original: it re-stitches
 * through the real pipeline, which flips source_pristine back to true and
 * rebuilds the presentation with the audio chain applied properly.
 */
import { initDb } from "../src/db/client";
import { freeBytes, migrateVideo, planMigration } from "../src/lib/migrate-presentation";

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  await initDb();

  const plan = await planMigration();
  const toCreate = plan.videos.filter((v) => v.masterAction === "create");
  const toSeed = plan.videos.filter((v) => v.seedCaptions);

  console.log(`${plan.videos.length} video(s)\n`);
  for (const v of plan.videos) {
    const bits = [
      v.masterAction === "create"
        ? `master ${v.masterFile} (+${gb(v.projectedBytes)})`
        : `master: ${v.masterAction}`,
      v.seedCaptions ? "seed captions.original.srt" : null,
      v.sourcePristine ? "source pristine" : "source has baked-in audio",
    ].filter(Boolean);
    console.log(`  ${v.slug.padEnd(28)} ${bits.join(" · ")}`);
  }

  console.log(
    `\n${toCreate.length} master(s) to create, ${toSeed.length} caption seed(s), ${gb(plan.totalProjectedBytes)} to add`,
  );

  // Refuse to start unless there's comfortable room. Filling the volume midway
  // through would be a far worse state than not starting.
  const free = await freeBytes();
  if (free !== null) {
    console.log(`${gb(free)} free on the data volume`);
    if (plan.totalProjectedBytes > 0 && free < plan.totalProjectedBytes * 2) {
      console.error(
        `\nRefusing to run: needs ${gb(plan.totalProjectedBytes)} and wants 2x that free as headroom.`,
      );
      return 1;
    }
  }

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to migrate.");
    return 0;
  }

  console.log("\nApplying...\n");
  let masters = 0;
  let captions = 0;
  const failures: string[] = [];
  for (const videoPlan of plan.videos) {
    const result = await migrateVideo(videoPlan);
    masters += result.mastersCreated;
    captions += result.captionsSeeded;
    if (result.error) {
      failures.push(`${videoPlan.slug}: ${result.error}`);
      console.error(`  FAILED ${videoPlan.slug}: ${result.error}`);
    } else if (result.mastersCreated || result.captionsSeeded) {
      console.log(
        `  ${videoPlan.slug}: master=${result.mastersCreated} captions=${result.captionsSeeded}`,
      );
    }
  }

  console.log(`\n${masters} master(s) created, ${captions} caption original(s) seeded`);
  if (failures.length > 0) {
    console.error(`${failures.length} video(s) failed — re-run to retry, it's idempotent`);
    return 1;
  }
  console.log("Re-run this to confirm a clean second pass, then verify a video plays.");
  return 0;
}

process.exit(await main());
