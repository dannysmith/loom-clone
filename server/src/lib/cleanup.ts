import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { DATA_DIR } from "./store";

const STALE_DAYS = 10;

// Deletes HLS segments and thumbnail candidates for videos that have been
// complete for longer than STALE_DAYS and have a valid source.mp4 on disk.
// Safe to run frequently — the query and filesystem checks prevent premature
// deletion. Called daily by the timer in index.ts.
export async function cleanupStaleFiles(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const candidates = await getDb()
    .select({ id: videos.id })
    .from(videos)
    .where(
      and(
        eq(videos.status, "complete"),
        isNull(videos.trashedAt),
        lte(videos.completedAt, cutoff),
        gt(videos.fileBytes, 0),
      ),
    );

  let cleaned = 0;

  for (const { id } of candidates) {
    const videoDir = join(DATA_DIR, id);
    const sourcePath = join(videoDir, "derivatives", "source.mp4");

    // Belt-and-suspenders: verify source.mp4 exists on disk before removing
    // the HLS segments it was built from.
    if (!(await Bun.file(sourcePath).exists())) continue;

    let filesRemoved = 0;

    // Delete fixed-name HLS files.
    for (const file of ["init.mp4", "stream.m3u8"]) {
      const p = join(videoDir, file);
      if (await Bun.file(p).exists()) {
        await rm(p, { force: true });
        filesRemoved++;
      }
    }

    // Delete numbered segment files (seg_0.m4s, seg_1.m4s, ...).
    try {
      const entries = await readdir(videoDir);
      for (const entry of entries) {
        if (/^seg_\d+\.m4s$/.test(entry)) {
          await rm(join(videoDir, entry), { force: true });
          filesRemoved++;
        }
      }
    } catch {
      // Directory may have been removed between the query and now.
    }

    // Delete thumbnail candidate images (the promoted thumbnail.jpg is kept).
    const candidatesDir = join(videoDir, "derivatives", "thumbnail-candidates");
    if (await Bun.file(candidatesDir).exists()) {
      await rm(candidatesDir, { recursive: true, force: true });
      filesRemoved++;
    }

    if (filesRemoved > 0) {
      cleaned++;
      console.log(`[cleanup] ${id}: removed ${filesRemoved} stale files`);
    }
  }

  if (cleaned > 0) {
    console.log(`[cleanup] cleaned stale files from ${cleaned} video(s)`);
  }
}
