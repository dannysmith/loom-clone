import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videoSegments, videos } from "../db/schema";
import { logEvent } from "./events";
import { getStep } from "./processing/steps-store";
import { DATA_DIR } from "./store";
import { activeRawFilename } from "./url";

const STALE_DAYS = 10;

// A recording that hasn't received a segment (or been created) in this long
// with no valid /complete is given up on and marked `incomplete`. Large on
// purpose: a user may legitimately pause a recording for a long time, and a
// paused recording produces no segments.
const STALE_RECORDING_HOURS = 4;

// Deletes HLS segments and thumbnail candidates for videos that have been
// `ready` for longer than STALE_DAYS and have a VALIDATED source.mp4. Once the
// HLS segments are gone the MP4 is the only copy, so this gates on the `source`
// step being `ready` (isProbablyPlayable passed at generation) AND the file
// being present — never on bare existence. This is the change that stops a
// temporarily-broken MP4 from turning a video permanently unplayable.
// Called daily by the timer in index.ts.
export async function cleanupStaleFiles(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const candidates = await getDb()
    .select({
      id: videos.id,
      lastEditedAt: videos.lastEditedAt,
      height: videos.height,
    })
    .from(videos)
    .where(
      and(
        eq(videos.status, "ready"),
        isNull(videos.trashedAt),
        lte(videos.completedAt, cutoff),
        gt(videos.fileBytes, 0),
      ),
    );

  let cleaned = 0;

  for (const video of candidates) {
    const { id } = video;
    const videoDir = join(DATA_DIR, id);
    const derivDir = join(videoDir, "derivatives");
    const sourcePath = join(derivDir, "source.mp4");

    // Require the source step validated good AND the file still present before
    // removing the HLS segments it was built from. Either missing → skip.
    const sourceStep = await getStep(id, "source");
    if (sourceStep?.state !== "ready") continue;
    if (!(await Bun.file(sourcePath).exists())) continue;

    // Also require the file the viewer is ACTUALLY served — for an edited video
    // that's the {H}p.mp4 cut, not source.mp4. If it's gone we must keep the HLS
    // fallback (resolve.ts would otherwise have nothing to serve).
    const activePath = join(derivDir, activeRawFilename(video));
    if (!(await Bun.file(activePath).exists())) continue;

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

// Marks `recording` videos that never received a valid /complete and have had
// no segment activity for STALE_RECORDING_HOURS as `incomplete`. Detection is
// activity-based (latest segment upload, or creation time when no segments
// arrived), not a heartbeat. An `incomplete` video still serves whatever
// partial HLS it has. Runs alongside the daily cleanup timer.
export async function markStalledRecordingsIncomplete(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RECORDING_HOURS * 60 * 60 * 1000).toISOString();

  // Per recording video, the most recent activity timestamp: the latest
  // segment upload, falling back to the video's creation time.
  const rows = await getDb()
    .select({
      id: videos.id,
      createdAt: videos.createdAt,
      lastSegmentAt: sql<string | null>`MAX(${videoSegments.uploadedAt})`,
    })
    .from(videos)
    .leftJoin(videoSegments, eq(videoSegments.videoId, videos.id))
    .where(and(eq(videos.status, "recording"), isNull(videos.trashedAt)))
    .groupBy(videos.id);

  let marked = 0;
  for (const row of rows) {
    const lastActivity =
      row.lastSegmentAt && row.lastSegmentAt > row.createdAt ? row.lastSegmentAt : row.createdAt;
    if (lastActivity >= cutoff) continue; // still within the window

    // Guard on status === "recording": a /complete may have arrived between the
    // scan and now, so only mark videos still recording (and never clobber a
    // concurrent transition).
    const [updated] = await getDb()
      .update(videos)
      .set({ status: "incomplete", updatedAt: new Date().toISOString() })
      .where(and(eq(videos.id, row.id), eq(videos.status, "recording")))
      .returning({ id: videos.id });
    if (!updated) continue;

    await logEvent(row.id, "marked_incomplete", { lastActivity });
    marked++;
    console.log(`[cleanup] ${row.id}: marked incomplete (last activity ${lastActivity})`);
  }

  if (marked > 0) {
    console.log(`[cleanup] marked ${marked} stalled recording(s) incomplete`);
  }
}
