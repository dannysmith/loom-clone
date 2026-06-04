// reconcile(videoId) — the single owner of the POST-FOOTAGE status transitions.
// It reads the video_processing_steps rows and sets `processing` / `ready` /
// `processing_failed` from whether the mandatory steps (source + metadata) have
// validated. It also owns the `incomplete → ready` recovery transition.
//
// It does NOT own the recording↔healing boundary (decided in the /complete
// handler by diffing the client timeline against on-disk segments), and it does
// NOT touch `reprocessing` (owned transiently by the editor, which must land an
// atomic set before reconciling — and recovered on boot by
// recoverStrandedReprocessing). Call it after each pipeline step (running:true)
// and once when a run settles (running:false).

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { getVideo, markVideoReady, setVideoStatus } from "../store";
import { REQUIRED_KINDS } from "./registry";
import { getStepStates } from "./steps-store";

// The post-footage statuses reconcile may transition. This is ALSO the set of
// statuses from which a manual reprocess makes sense (readiness.canReprocess
// imports it) — keeping them one constant means a reprocessable status can never
// lack an owner to settle it back to `ready`/`processing_failed`. Excluded:
// recording/healing (owned by /complete), reprocessing (owned by the editor),
// deleting (terminal).
export const RECONCILE_OWNED: ReadonlySet<string> = new Set([
  "processing",
  "ready",
  "processing_failed",
  "incomplete",
]);

export async function reconcile(
  videoId: string,
  opts: { running: boolean; hold?: boolean },
): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video || video.trashedAt) return;
  if (!RECONCILE_OWNED.has(video.status)) return;

  const steps = await getStepStates(videoId);
  const requiredStates = REQUIRED_KINDS.map((k) => steps.get(k)?.state);
  const allReady = requiredStates.every((s) => s === "ready");
  const anyFailed = requiredStates.some((s) => s === "failed");

  // Promote to `ready` once the mandatory steps validate — unless we're holding
  // for a forced multi-file rebuild that is still regenerating its expected
  // outputs (variants/storyboard/…). The hold keeps status (and feeds) honest
  // until the whole forced set has re-validated at running:false.
  if (allReady && !opts.hold) {
    await markVideoReady(videoId);
    return;
  }

  // `incomplete` only ever escapes upward to `ready` (above). Its footage was
  // never whole, so while a recovery run is still in progress — or if it failed
  // — leave it `incomplete` (it keeps serving its partial HLS); never relabel it
  // `processing`/`processing_failed`.
  if (video.status === "incomplete") return;

  // A deterministic failure of a mandatory step (and no active run that could
  // still produce it) → processing_failed: HLS still plays, but there's no
  // stable validated MP4 and it needs manual attention.
  if (!opts.running && anyFailed) {
    if (video.status !== "processing_failed") await setVideoStatus(videoId, "processing_failed");
    return;
  }

  // Still working, held for a forced rebuild, or interrupted with mandatory
  // steps pending. Show `processing` (the latter simply sits here until a manual
  // reprocess kicks it).
  if (video.status !== "processing") await setVideoStatus(videoId, "processing");
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
    const steps = await getStepStates(id);
    const allReady = REQUIRED_KINDS.every((k) => steps.get(k)?.state === "ready");
    if (!allReady) continue; // can't safely settle — leave for manual reprocess
    await markVideoReady(id);
    recovered++;
    console.log(`[reconcile] recovered stranded reprocessing video ${id} → ready`);
  }
  if (recovered > 0) {
    console.log(`[reconcile] recovered ${recovered} stranded reprocessing video(s)`);
  }
}
