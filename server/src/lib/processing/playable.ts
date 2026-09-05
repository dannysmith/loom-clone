// Shared "is this file structurally a playable video?" check.
//
// One ffprobe reading container + stream headers only — NO decode, so it's
// fast. It catches a byte-complete source.mp4 that doesn't actually play (e.g.
// a `-c copy` stitch of a long, mode-switching recording with no decodable
// video stream or a nonsense duration). It deliberately does NOT catch
// declared-vs-actual frame-rate mismatches — that needs a full decode, and a
// declared ≠ avg frame rate is normal for honest VFR content, so a header-only
// heuristic there would false-positive on every healthy recording.

import { probeJson } from "../ffprobe";

export type PlayableOpts = {
  // When known, the VIDEO duration must land within tolerance of this. Every
  // expectation passed here describes how much video content the file should
  // hold: the segment-duration sum for a recording (the Mac reports each
  // segment's video-track length), the source's video duration for an upload,
  // the sum of kept segment lengths for a presentation master.
  expectedDuration?: number;
};

// Tolerance for the duration sanity check: ±2 s or ±2%, whichever is larger.
//
// It's this loose because the check hunts gross failures — a truncated stitch, a
// render that produced ten seconds instead of fifty — not drift. Honest sources
// disagree with themselves by small amounts all the time: audio and video tracks
// rarely end on the same frame, the audio chain pads its output out to a whole
// number of filter frames, and a `-c copy` stitch inherits whatever its segment
// boundaries gave it. Measured across real recordings those gaps run to about a
// quarter of a second. The 2 s floor stops a very short video failing on a
// fraction of a second that the percentage wouldn't cover.
function durationWithinTolerance(actual: number, expected: number): boolean {
  const tolerance = Math.max(2, expected * 0.02);
  return Math.abs(actual - expected) <= tolerance;
}

type ProbeShape = {
  streams?: Array<{ codec_type?: string; duration?: string }>;
  format?: { duration?: string };
};

// Returns true when the file at `path` has a video stream and a finite
// duration that (when expectedDuration is supplied) is within tolerance.
// Returns false on any probe failure, missing video stream, or non-finite /
// out-of-tolerance duration. ffprobe missing → returns false (we can't
// validate, so don't claim it's good).
export async function isProbablyPlayable(path: string, opts: PlayableOpts = {}): Promise<boolean> {
  const data = (await probeJson([
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ])) as ProbeShape | null;
  if (!data) return false; // ffprobe missing / failed / unparseable → can't claim it's good

  const videoStream = (data.streams ?? []).find((s) => s.codec_type === "video");
  if (!videoStream) return false;

  // Measure the VIDEO stream, not the container. `format.duration` follows
  // whichever stream runs longest — usually audio — so comparing it against a
  // video-derived expectation measures one thing while expecting another. Fall
  // back to the container for the odd file whose streams carry no duration of
  // their own.
  const streamDuration = Number.parseFloat(videoStream.duration ?? "");
  const duration = Number.isFinite(streamDuration)
    ? streamDuration
    : Number.parseFloat(data.format?.duration ?? "");
  if (!Number.isFinite(duration) || duration <= 0) return false;

  if (opts.expectedDuration != null && opts.expectedDuration > 0) {
    if (!durationWithinTolerance(duration, opts.expectedDuration)) return false;
  }

  return true;
}
