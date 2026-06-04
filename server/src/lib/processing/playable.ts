// Shared "is this file structurally a playable video?" check.
//
// One ffprobe reading container + stream headers only — NO decode, so it's
// fast. It catches a byte-complete source.mp4 that doesn't actually play (e.g.
// a `-c copy` stitch of a long, mode-switching recording with no decodable
// video stream or a nonsense duration). It deliberately does NOT catch
// declared-vs-actual frame-rate mismatches — that needs a full decode, and a
// declared ≠ avg frame rate is normal for honest VFR content, so a header-only
// heuristic there would false-positive on every healthy recording.

export type PlayableOpts = {
  // When known, the probed duration must land within tolerance of this.
  // Recordings: the segment-duration sum. Uploads: probeDuration at intake.
  expectedDuration?: number;
};

// Tolerance for the duration sanity check: ±2 s or ±2%, whichever is larger.
function durationWithinTolerance(actual: number, expected: number): boolean {
  const tolerance = Math.max(2, expected * 0.02);
  return Math.abs(actual - expected) <= tolerance;
}

type ProbeShape = {
  streams?: Array<{ codec_type?: string }>;
  format?: { duration?: string };
};

// Returns true when the file at `path` has a video stream and a finite
// duration that (when expectedDuration is supplied) is within tolerance.
// Returns false on any probe failure, missing video stream, or non-finite /
// out-of-tolerance duration. ffprobe missing → returns false (we can't
// validate, so don't claim it's good).
export async function isProbablyPlayable(path: string, opts: PlayableOpts = {}): Promise<boolean> {
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) return false;

  try {
    const proc = Bun.spawn(
      [ffprobePath, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return false;

    const data = JSON.parse(stdout) as ProbeShape;

    const hasVideo = (data.streams ?? []).some((s) => s.codec_type === "video");
    if (!hasVideo) return false;

    const duration = Number.parseFloat(data.format?.duration ?? "");
    if (!Number.isFinite(duration) || duration <= 0) return false;

    if (opts.expectedDuration != null && opts.expectedDuration > 0) {
      if (!durationWithinTolerance(duration, opts.expectedDuration)) return false;
    }

    return true;
  } catch {
    return false;
  }
}
