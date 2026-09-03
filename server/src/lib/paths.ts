import { join } from "path";

// On-disk layout for per-video data. Deliberately free of project imports:
// every module that touches the filesystem needs these paths, and when they
// lived in `store.ts` that made the store the module the whole lib routed
// through — which is what forced the `await import()` cycle-breaks. Keep this
// module dependency-free.

// Relative on purpose. Tests chdir into a temp directory and inherit an
// isolated `data/`; in production the Docker bind-mount maps it to
// /mnt/data/loom-clone. Never resolve it against an absolute prefix.
export const DATA_DIR = "data";

// Generated outputs (MP4 cuts, thumbnails, peaks, captions, the EDL) live in a
// subdirectory of the video's data dir, so wiping and regenerating them never
// touches the recorded footage beside them.
export function derivativesDir(videoId: string): string {
  return join(DATA_DIR, videoId, "derivatives");
}
