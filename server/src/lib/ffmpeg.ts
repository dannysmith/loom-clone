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
// error message on failure. silencedetect emits lines throughout the decode,
// but its total volume is bounded by the number of detected silences (well
// under the 64 KB tail for any real recording).
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

  const [stderr, stdout, exitCode] = await Promise.all([
    readStreamTail(proc.stderr as ReadableStream<Uint8Array>, tailBytes),
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
