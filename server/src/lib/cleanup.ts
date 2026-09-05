import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videoSegments, videos } from "../db/schema";
import { logEvent } from "./events";
import { DATA_DIR } from "./paths";
import { MEDIA_SEGMENT } from "./playlist";
import { applicabilityContext, isServable, stepByKind } from "./processing/registry";
import { hasActiveRun } from "./processing/run-lock";
import { getStep } from "./processing/steps-store";
import { getVideo } from "./store";

const STALE_DAYS = 10;

// A recording that hasn't received a segment (or been created) in this long
// with no valid /complete is given up on and marked `incomplete`. Large on
// purpose: a user may legitimately pause a recording for a long time, and a
// paused recording produces no segments.
export const STALE_RECORDING_HOURS = 4;

// A `healing` video is waiting for the Mac to re-upload missing segments,
// which can legitimately take days (a laptop closed over a weekend) — so this
// window is far more generous than the recording one. Marking `incomplete` is
// reversible: /complete accepts a re-complete from `incomplete` and schedules
// an intake reprocess, so a Mac that comes back after the sweep fired still
// heals cleanly.
export const STALE_HEALING_HOURS = 48;

// Deletes HLS segments for videos that have been `ready` for longer than
// STALE_DAYS. Once the segments are gone the MP4s are all that's left, so this
// gates on BOTH the pristine source and the served presentation master being
// validated `ready` and still on disk — never on bare file existence. That's
// what stops a temporarily-broken master from turning a video permanently
// unplayable. Called daily by the timer in index.ts.
export async function cleanupStaleFiles(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const candidates = await getDb()
    .select({ id: videos.id })
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

  for (const { id } of candidates) {
    const videoDir = join(DATA_DIR, id);

    const video = await getVideo(id, { includeTrashed: true });
    if (!video) continue;

    // An in-flight run may be reading these segments (an admin-triggered
    // rebuild-from-HLS); skip and let tomorrow's sweep retry.
    if (hasActiveRun(id)) continue;

    const ctx = applicabilityContext(video);
    let keep = false;

    // Two gates, because the two files have different jobs and losing either is
    // unrecoverable once the segments are gone.
    //
    // `source` — the pristine original everything is regenerated from. It must
    // outlive the HLS it was stitched from.
    // `presentation` — the <H>p.mp4 a viewer is actually served. If it isn't
    // servable we keep the HLS fallback, because resolve.ts would otherwise have
    // nothing to serve (source.mp4 is never served publicly).
    //
    // Same isServable predicate the viewer serves on, so the three can't drift.
    for (const kind of ["source", "presentation"] as const) {
      if (!(await isServable(stepByKind(kind)!, ctx, await getStep(id, kind)))) {
        keep = true;
        break;
      }
    }
    if (keep) continue;

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
        if (MEDIA_SEGMENT.test(entry)) {
          await rm(join(videoDir, entry), { force: true });
          filesRemoved++;
        }
      }
    } catch {
      // Directory may have been removed between the query and now.
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

export type StalledVideo = {
  id: string;
  slug: string;
  status: "recording" | "healing";
  lastActivity: string;
};

// Finds `recording` and `healing` videos whose last activity is older than
// their status's staleness window. Detection is activity-based (latest segment
// upload, falling back to a per-status baseline), not a heartbeat:
//   - `recording`: no valid /complete and no segment for STALE_RECORDING_HOURS.
//     Baseline is creation time (the row predates every segment).
//   - `healing`: no segment for STALE_HEALING_HOURS. Baseline is updatedAt —
//     the moment /complete moved it into `healing`.
// Shared by the daily sweep below (which marks them `incomplete`) and the
// self-check (which reports ones the sweep hasn't reached yet).
export async function findStalledVideos(): Promise<StalledVideo[]> {
  const cutoffs = {
    recording: new Date(Date.now() - STALE_RECORDING_HOURS * 60 * 60 * 1000).toISOString(),
    healing: new Date(Date.now() - STALE_HEALING_HOURS * 60 * 60 * 1000).toISOString(),
  };

  const rows = await getDb()
    .select({
      id: videos.id,
      slug: videos.slug,
      status: videos.status,
      createdAt: videos.createdAt,
      updatedAt: videos.updatedAt,
      lastSegmentAt: sql<string | null>`MAX(${videoSegments.uploadedAt})`,
    })
    .from(videos)
    .leftJoin(videoSegments, eq(videoSegments.videoId, videos.id))
    .where(and(inArray(videos.status, ["recording", "healing"]), isNull(videos.trashedAt)))
    .groupBy(videos.id);

  const stalled: StalledVideo[] = [];
  for (const row of rows) {
    const status = row.status as "recording" | "healing"; // the WHERE clause guarantees it
    const baseline = status === "recording" ? row.createdAt : row.updatedAt;
    const lastActivity =
      row.lastSegmentAt && row.lastSegmentAt > baseline ? row.lastSegmentAt : baseline;
    if (lastActivity >= cutoffs[status]) continue; // still within the window
    stalled.push({ id: row.id, slug: row.slug, status, lastActivity });
  }
  return stalled;
}

// Marks stalled `recording` and `healing` videos as `incomplete`. Without this
// sweep, a video whose Mac died mid-heal and never came back stays `healing`
// forever, invisible to every safety net. An `incomplete` video still serves
// whatever partial HLS it has. Runs alongside the daily cleanup timer.
export async function markStalledVideosIncomplete(): Promise<void> {
  let marked = 0;
  for (const { id, status, lastActivity } of await findStalledVideos()) {
    // Guard on the scanned status: a /complete may have arrived between the
    // scan and now, so only mark videos still in that state (and never clobber
    // a concurrent transition).
    const [updated] = await getDb()
      .update(videos)
      .set({ status: "incomplete", updatedAt: new Date().toISOString() })
      .where(and(eq(videos.id, id), eq(videos.status, status)))
      .returning({ id: videos.id });
    if (!updated) continue;

    await logEvent(id, "marked_incomplete", { lastActivity, from: status });
    marked++;
    console.log(
      `[cleanup] ${id}: marked incomplete (was ${status}, last activity ${lastActivity})`,
    );
  }

  if (marked > 0) {
    console.log(`[cleanup] marked ${marked} stalled video(s) incomplete`);
  }
}
