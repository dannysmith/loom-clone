// Process-wide registry of videos that currently have a post-processing run
// actively touching their derivatives/ dir. Shared by the main pipeline
// (pipeline.ts) and the edit pipeline (edit-pipeline.ts), which each keep their
// own coalescing in-flight map for within-pipeline dedupe — this is the single
// CROSS-pipeline signal so either pipeline (and the editor gate) can tell
// whether ANY run is currently writing a video's derivatives.
//
// Why it exists: reconcile publishes `ready` the moment source + metadata
// validate, while the SAME run is still rewriting source.mp4 in place (audio)
// and cutting variants — minutes, for a long recording. Without this lock the
// editor's page-load and commit gates both pass during that window, letting an
// edit commit start a second ffmpeg + ledger writer against the same dir (the
// two pipelines previously had separate in-flight maps and couldn't see each
// other). That is exactly the quality-menu-jumps-content corruption Task 4 set
// out to prevent. This is the shared per-video lock of decision 4 in the
// pipeline-unification task; Phase 3 collapses the two pipelines into one and
// this becomes the only in-flight map.

// Reference-counted: this is an ADVISORY signal, and as Phase 3 routes more run
// types through it (main pipeline, reprocess, per-artifact regen, edit) two
// holders can briefly overlap. A plain Set would clear on the first release and
// read "free" while another run is still writing; the count keeps hasActiveRun
// honest until the LAST holder releases.
const active = new Map<string, number>();

// Is a post-processing run (main pipeline or edit) currently in flight for this
// video? The editor page-load and commit gates consult this on top of
// `status === ready`.
export function hasActiveRun(videoId: string): boolean {
  return (active.get(videoId) ?? 0) > 0;
}

export function markRunActive(videoId: string): void {
  active.set(videoId, (active.get(videoId) ?? 0) + 1);
}

export function clearRunActive(videoId: string): void {
  const count = active.get(videoId) ?? 0;
  if (count <= 1)
    active.delete(videoId); // also a safe no-op for an unknown id
  else active.set(videoId, count - 1);
}
