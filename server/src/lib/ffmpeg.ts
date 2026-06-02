// Shared ffmpeg/ffprobe spawn helper with bounded stderr capture.
//
// The post-processing pipeline spawns ffmpeg for multi-minute jobs (audio
// loudnorm passes, variant encodes, full-decode silence detection). Capturing
// their stderr with `new Response(proc.stderr).text()` accumulates the ENTIRE
// stream into one JS string for the life of the process — and at `-loglevel
// info` ffmpeg's per-second progress line makes that grow without bound. This
// helper keeps only the **last N bytes** of stderr (a rolling tail), so memory
// is bounded no matter how long the job runs or how chatty ffmpeg is.
//
// Why a tail (not a head, not the whole thing): every consumer that parses
// stderr wants content that lives at or near the *end* — the loudnorm
// `print_format=json` block, volumedetect's `mean_volume:` line, and ffmpeg's
// error message on failure.
//
// The exception is silencedetect, whose `silence_start`/`silence_end` markers
// are spread across the whole decode — a tail could drop the early ones. For
// that case pass `keepStderrLines`: stderr is read line-by-line and only
// matching lines are retained, so memory is bounded by the match count (not
// the stream length) with no risk of truncating early markers.
//
// CRITICAL: this helper never sets `-loglevel`. Several callers depend on
// info-level output (loudnorm JSON, volumedetect, silencedetect) and would
// break if forced to `error`. Log level stays caller-controlled — pass the
// flags each call site needs.

const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;

export interface SpawnFfmpegResult {
  exitCode: number;
  // The last `tailBytes` of the process's stderr, decoded as UTF-8.
  stderr: string;
  // Full stdout when `captureStdout` is set, otherwise "" (stdout is ignored).
  stdout: string;
}

export interface SpawnFfmpegOptions {
  // Capture full stdout (for ffprobe JSON / PCM-to-stdout style callers).
  // When false (default) stdout is ignored so it can never block or buffer.
  captureStdout?: boolean;
  // Override the stderr tail size in bytes.
  tailBytes?: number;
  // Retain only stderr lines matching this pattern (read line-by-line), instead
  // of a rolling tail. For parsers needing every matching line across a long
  // stream (e.g. silencedetect markers). Pass a non-global RegExp. Memory is
  // bounded by the number of matching lines.
  keepStderrLines?: RegExp;
}

// Spawn `bin` with `args` and return the exit code plus a bounded stderr tail.
// `bin` is the already-resolved ffmpeg/ffprobe path — callers keep their own
// `Bun.which()` lookup and missing-binary handling, so this helper doesn't
// change any site's not-found semantics.
export async function spawnFfmpeg(
  bin: string,
  args: string[],
  opts: SpawnFfmpegOptions = {},
): Promise<SpawnFfmpegResult> {
  const tailBytes = opts.tailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
  const proc = Bun.spawn([bin, ...args], {
    stderr: "pipe",
    stdout: opts.captureStdout ? "pipe" : "ignore",
  });

  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
  const [stderr, stdout, exitCode] = await Promise.all([
    opts.keepStderrLines
      ? collectMatchingLines(stderrStream, opts.keepStderrLines)
      : readStreamTail(stderrStream, tailBytes),
    opts.captureStdout
      ? new Response(proc.stdout as ReadableStream<Uint8Array>).text()
      : Promise.resolve(""),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

// Drain a byte stream keeping only its last `maxBytes`. Peak retained memory is
// ~maxBytes + one chunk, regardless of total stream length.
async function readStreamTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      // A single chunk larger than the cap: keep just its tail.
      if (value.byteLength >= maxBytes) {
        buf = value.slice(value.byteLength - maxBytes);
        continue;
      }

      const combinedLen = buf.byteLength + value.byteLength;
      const combined = new Uint8Array(combinedLen);
      combined.set(buf, 0);
      combined.set(value, buf.byteLength);
      buf = combinedLen > maxBytes ? combined.slice(combinedLen - maxBytes) : combined;
    }
  } finally {
    reader.releaseLock();
  }
  // ASCII-only for our parse targets; a split multibyte char at the tail
  // boundary just yields a replacement char, which never affects parsing.
  return new TextDecoder().decode(buf);
}

// Drain a byte stream line-by-line, retaining only lines matching `pattern`,
// joined by "\n". Retained memory is bounded by the matching lines, not the
// total stream length — so early matches are never lost to truncation.
async function collectMatchingLines(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const kept: string[] = [];
  let partial = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      partial += decoder.decode(value, { stream: true });
      let nl = partial.indexOf("\n");
      while (nl !== -1) {
        const line = partial.slice(0, nl);
        if (pattern.test(line)) kept.push(line);
        partial = partial.slice(nl + 1);
        nl = partial.indexOf("\n");
      }
    }
    partial += decoder.decode();
    if (partial && pattern.test(partial)) kept.push(partial);
  } finally {
    reader.releaseLock();
  }
  return kept.join("\n");
}
