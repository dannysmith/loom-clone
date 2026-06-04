// reconcile(videoId) — the single owner of the POST-FOOTAGE status transitions.
// It reads the video_processing_steps rows and sets `processing` / `ready` /
// `processing_failed` from whether the mandatory steps (source + metadata) have
// validated.
//
// It does NOT own the recording↔healing boundary (decided in the /complete
// handler by diffing the client timeline against on-disk segments), and it does
// NOT touch `reprocessing` (owned transiently by the editor / manual reprocess,
// which must land an atomic set before reconciling). Call it after each pipeline
// step (running:true) and once when a run settles (running:false).

import { getVideo, markVideoReady, setVideoStatus } from "../store";
import { REQUIRED_KINDS } from "./registry";
import { getStepStates } from "./steps-store";

// reconcile only acts on videos already in one of these post-footage states.
// recording/healing → owned by /complete; reprocessing → owned by the editor;
// incomplete/deleting → terminal-ish, left alone.
const RECONCILE_OWNED = new Set(["processing", "ready", "processing_failed"]);

export async function reconcile(videoId: string, opts: { running: boolean }): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video || video.trashedAt) return;
  if (!RECONCILE_OWNED.has(video.status)) return;

  const steps = await getStepStates(videoId);
  const requiredStates = REQUIRED_KINDS.map((k) => steps.get(k)?.state);
  const allReady = requiredStates.every((s) => s === "ready");
  const anyFailed = requiredStates.some((s) => s === "failed");

  if (allReady) {
    await markVideoReady(videoId);
    return;
  }

  // A deterministic failure of a mandatory step (and no active run that could
  // still produce it) → processing_failed: HLS still plays, but there's no
  // stable validated MP4 and it needs manual attention.
  if (!opts.running && anyFailed) {
    if (video.status !== "processing_failed") await setVideoStatus(videoId, "processing_failed");
    return;
  }

  // Still working, or interrupted with mandatory steps pending. The latter
  // simply shows as `processing` in the admin until a manual reprocess kicks it.
  if (video.status !== "processing") await setVideoStatus(videoId, "processing");
}
