// Shared ffprobe runner. Spawns ffprobe with the given args and returns the
// parsed JSON output, or null on any failure (ffprobe missing, non-zero exit,
// unparseable output). Callers pass `-print_format json` and extract their own
// fields. Centralises the spawn/await/parse/try-catch boilerplate that the
// playability, metadata, duration and audio-stream probes would otherwise each
// repeat. Imports nothing app-level, so any module can use it without a cycle.

export async function probeJson(args: string[]): Promise<unknown | null> {
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) return null;
  try {
    // stderr is ignored, not piped — we never read it, and an unconsumed pipe
    // could deadlock a probe that writes a lot to it.
    const proc = Bun.spawn([ffprobePath, ...args], { stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// Whether the file at `path` contains at least one audio stream.
export async function hasAudioStream(path: string): Promise<boolean> {
  const data = (await probeJson([
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "a",
    path,
  ])) as { streams?: unknown[] } | null;
  return (data?.streams?.length ?? 0) > 0;
}
