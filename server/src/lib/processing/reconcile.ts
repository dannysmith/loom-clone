// reconcile(videoId) — the single owner of the POST-FOOTAGE status transitions.
// It reads the video_processing_steps rows and sets `processing` / `ready` /
// `processing_failed` from whether the mandatory steps (source + metadata) have
// validated. It also owns the `incomplete → ready` recovery transition.
//
// It does NOT own the recording↔healing boundary (decided in the /complete
// handler by diffing the client timeline against on-disk segments). It settles a
// `reprocessing` video (an edit run) UP to `ready` once its mandatory steps
// validate, but never demotes one — the edit run owns the failure path
// (restoring `ready`), and a crash leaves it for recoverStrandedReprocessing on
// boot. Call it after each pipeline step (running:true) and once when a run
// settles (running:false).

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import type { ProcessingStepKind, VideoProcessingStep } from "../../db/schema";
import { videos } from "../../db/schema";
import { purgeGlobalFeeds } from "../cdn";
import { RECONCILE_OWNED } from "../status";
import { getVideo, markVideoReady, setVideoStatus } from "../store";
import { REQUIRED_KINDS } from "./registry";
import { getStepStates } from "./steps-store";

// The one rollup rule, in one place: every required step `ready` → `ready`; any
// required step `failed` → `processing_failed`; otherwise still `processing`.
// Pure — callers layer the run/hold/incomplete nuances on top. This logic used
// to be hand-written three times (here, recoverStrandedReprocessing,
// duplicateVideo) and had already drifted.
export function rollupFromSteps(
  steps: ReadonlyMap<ProcessingStepKind, VideoProcessingStep>,
): "ready" | "processing" | "processing_failed" {
  const requiredStates = REQUIRED_KINDS.map((k) => steps.get(k)?.state);
  if (requiredStates.every((s) => s === "ready")) return "ready";
  if (requiredStates.some((s) => s === "failed")) return "processing_failed";
  return "processing";
}

export async function reconcile(
  videoId: string,
  opts: { running: boolean; hold?: boolean },
): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video || video.trashedAt) return;
  // reconcile settles its owned post-footage statuses plus `reprocessing` (an
  // edit run, which it only ever promotes UP to `ready`).
  const isReprocessing = video.status === "reprocessing";
  if (!RECONCILE_OWNED.has(video.status) && !isReprocessing) return;

  const rollup = rollupFromSteps(await getStepStates(videoId));
  // Leaving `ready` (a forced rebuild that demoted, or a regressed mandatory
  // step) must drop the video from the public feeds promptly — the origin query
  // filters status='ready', but the BunnyCDN-cached feed would otherwise keep
  // listing it until TTL. markVideoReady re-purges on the way back in.
  const wasReady = video.status === "ready";

  // Promote to `ready` once the mandatory steps validate — unless we're holding
  // for a forced multi-file rebuild that is still regenerating its expected
  // outputs (variants/storyboard/…). The hold keeps status (and feeds) honest
  // until the whole forced set has re-validated at running:false.
  if (rollup === "ready" && !opts.hold) {
    await markVideoReady(videoId);
    return;
  }

  // An edit run is the only owner of `reprocessing`'s downward transitions
  // (restoring `ready` on failure); reconcile only ever settles it UP (above),
  // never demotes it to processing/processing_failed.
  if (isReprocessing) return;

  // `incomplete` only ever escapes upward to `ready` (above). Its footage was
  // never whole, so while a recovery run is still in progress — or if it failed
  // — leave it `incomplete` (it keeps serving its partial HLS); never relabel it
  // `processing`/`processing_failed`.
  if (video.status === "incomplete") return;

  // A deterministic failure of a mandatory step (and no active run that could
  // still produce it) → processing_failed: HLS still plays, but there's no
  // stable validated MP4 and it needs manual attention.
  if (!opts.running && rollup === "processing_failed") {
    if (video.status !== "processing_failed") {
      await setVideoStatus(videoId, "processing_failed");
      if (wasReady) purgeGlobalFeeds();
    }
    return;
  }

  // Still working, held for a forced rebuild, or interrupted with mandatory
  // steps pending. Show `processing` (the latter simply sits here until a manual
  // reprocess kicks it).
  if (video.status !== "processing") {
    await setVideoStatus(videoId, "processing");
    if (wasReady) purgeGlobalFeeds();
  }
}

// A `reprocessing` row means an edit/reprocess was in flight when the process
// last stopped. Those runs are in-memory fire-and-forget, so a restart (or the
// 0012 migration's processing→reprocessing remap of a mid-edit video) strands
// them — reconcile deliberately doesn't own `reprocessing`. On boot no edit can
// still be running, so any reprocessing video whose mandatory steps validated is
// safe to settle back to `ready` (it serves the untouched source.mp4 / original
// outputs; a half-applied edit never set lastEditedAt, so activeRawFilename
// resolves to source.mp4). Videos without validated mandatory steps are left for
// a manual reprocess. Run once at startup and from the backfill script.
export async function recoverStrandedReprocessing(): Promise<void> {
  const rows = await getDb()
    .select({ id: videos.id })
    .from(videos)
    .where(and(eq(videos.status, "reprocessing"), isNull(videos.trashedAt)));

  let recovered = 0;
  for (const { id } of rows) {
    const rollup = rollupFromSteps(await getStepStates(id));
    if (rollup !== "ready") continue; // can't safely settle — leave for manual reprocess
    await markVideoReady(id);
    recovered++;
    console.log(`[reconcile] recovered stranded reprocessing video ${id} → ready`);
  }
  if (recovered > 0) {
    console.log(`[reconcile] recovered ${recovered} stranded reprocessing video(s)`);
  }
}
