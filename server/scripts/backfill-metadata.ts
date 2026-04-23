#!/usr/bin/env bun
/**
 * Backfill metadata for all existing videos. Runs the metadata extraction
 * step (ffprobe + recording.json) and thumbnail candidate generation against
 * each video that has a source.mp4 derivative on disk.
 *
 * Usage:
 *   bun run videos:backfill-metadata
 */
import { join } from "path";
import { initDb } from "../src/db/client";
import { extractMetadata } from "../src/lib/derivatives";
import { DATA_DIR, listVideos } from "../src/lib/store";
import { extractAndPromoteThumbnails } from "../src/lib/thumbnails";

async function main(): Promise<number> {
  await initDb();

  const videos = await listVideos({ includeTrashed: true });
  console.log(`Found ${videos.length} videos to backfill.\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const video of videos) {
    const derivDir = join(DATA_DIR, video.id, "derivatives");
    const sourceFile = Bun.file(join(derivDir, "source.mp4"));

    if (!(await sourceFile.exists())) {
      console.log(`  SKIP  ${video.id}  (no source.mp4)`);
      skipped++;
      continue;
    }

    try {
      // Metadata extraction
      await extractMetadata(video.id);

      // Thumbnail candidates (only if duration is known)
      if (video.durationSeconds && video.durationSeconds > 0) {
        await extractAndPromoteThumbnails(derivDir, video.durationSeconds);
      }

      console.log(`  OK    ${video.id}  ${video.slug}`);
      success++;
    } catch (err) {
      console.error(`  FAIL  ${video.id}  ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} ok, ${skipped} skipped, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

const code = await main();
process.exit(code);
