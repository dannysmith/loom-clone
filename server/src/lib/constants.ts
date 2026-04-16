// Fallback segment duration in seconds when the client doesn't send
// x-segment-duration and when the playlist builder has no duration sidecar
// entry for a file. The writer emits ~4s segments, so this is a sane default.
export const DEFAULT_SEGMENT_DURATION = 4;
