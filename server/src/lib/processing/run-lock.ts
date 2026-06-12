// Process-wide registry of videos that currently have a post-processing run
// actively touching their derivatives/ dir, keyed by videoId. The pipeline's
// schedule() marks a video active for the lifetime of a run (build or edit) so
// the editor page-load and commit gates can tell whether ANY run is currently
// writing a video's derivatives.
//
// Why it exists: reconcile publishes `ready` the moment source + metadata
// validate, while the SAME run is still rewriting source.mp4 in place (audio)
// and cutting variants — minutes, for a long recording. Without this lock the
// editor's page-load and commit gates both pass during that window, letting an
// edit commit start a second ffmpeg + ledger writer against the same dir — the
// quality-menu-jumps-content corruption Task 4 set out to prevent. This is the
// shared per-video lock of decision 4 in the pipeline-unification task.

// Reference-counted: this is an ADVISORY signal, and run types routed through it
// (build, reprocess, per-artifact regen, edit) can briefly overlap. A plain Set
// would clear on the first release and read "free" while another run is still
// writing; the count keeps hasActiveRun honest until the LAST holder releases.
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
