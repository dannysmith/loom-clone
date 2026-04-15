import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";
import { DATA_DIR } from "./store";

// A derivative is any file produced from the converged HLS segments. Each
// recipe declares its final output filename (relative to data/<id>/derivatives/)
// and a generator that writes `<filename>.tmp` into that directory. The
// orchestrator renames `.tmp` → final atomically on success, so a crash mid-
// generation leaves either a stale-but-complete final file or nothing at all —
// never a half-written output.
export interface Recipe {
  filename: string;
  generate(videoId: string, dir: string): Promise<void>;
}

function derivativesDir(videoId: string): string {
  return join(DATA_DIR, videoId, "derivatives");
}

let ffmpegMissingLogged = false;

async function runFfmpeg(args: string[]): Promise<void> {
  if (!Bun.which("ffmpeg")) {
    if (!ffmpegMissingLogged) {
      ffmpegMissingLogged = true;
      console.warn(
        "[derivatives] ffmpeg not found on PATH — derivative generation will fail"
      );
    }
    throw new Error("ffmpeg not found on PATH");
  }

  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", ...args],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${stderr.trim()}`);
  }
}

async function totalDurationFromSegments(videoId: string): Promise<number> {
  const file = Bun.file(join(DATA_DIR, videoId, "segments.json"));
  if (!(await file.exists())) return 0;
  try {
    const obj = (await file.json()) as Record<string, number>;
    return Object.values(obj).reduce((a, b) => a + (Number(b) || 0), 0);
  } catch {
    return 0;
  }
}

const sourceMp4Recipe: Recipe = {
  filename: "source.mp4",
  async generate(videoId, dir) {
    const playlist = join(DATA_DIR, videoId, "stream.m3u8");
    const out = join(dir, "source.mp4.tmp");
    await runFfmpeg([
      // m3u8 references init.mp4 and seg_*.m4s — allow all extensions so the
      // HLS demuxer doesn't reject .m4s sources.
      "-allowed_extensions", "ALL",
      "-i", playlist,
      "-c", "copy",
      // Put the moov atom at the front so `<video>` can begin playback before
      // the whole file is downloaded.
      "-movflags", "+faststart",
      // Explicit format — the `.tmp` output filename defeats ffmpeg's
      // extension-based format detection.
      "-f", "mp4",
      out,
    ]);
  },
};

const thumbnailRecipe: Recipe = {
  filename: "thumbnail.jpg",
  async generate(videoId, dir) {
    const source = join(dir, "source.mp4");
    const out = join(dir, "thumbnail.jpg.tmp");
    const duration = await totalDurationFromSegments(videoId);
    const t = duration > 0 ? Math.min(1.0, duration / 2) : 0;
    await runFfmpeg([
      "-ss", t.toFixed(3),
      "-i", source,
      "-vframes", "1",
      "-vf", "scale=1280:-1",
      "-f", "image2",
      out,
    ]);
  },
};

// Recipes run in order. source.mp4 must land before thumbnail tries to read it.
const recipes: Recipe[] = [sourceMp4Recipe, thumbnailRecipe];

const inFlight = new Map<string, Promise<void>>();

// Fire-and-forget. Repeated calls while a generation is in flight collapse to
// the same promise, preventing two ffmpegs from racing on the same video.
export function scheduleDerivatives(videoId: string): void {
  if (inFlight.has(videoId)) return;
  const p = generateDerivatives(videoId).finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, p);
  p.catch((err) => {
    console.error(`[derivatives] ${videoId} unexpected failure:`, err);
  });
}

async function generateDerivatives(videoId: string): Promise<void> {
  const dir = derivativesDir(videoId);
  await mkdir(dir, { recursive: true });

  for (const recipe of recipes) {
    const tmp = join(dir, `${recipe.filename}.tmp`);
    const final = join(dir, recipe.filename);
    const started = Date.now();
    try {
      await recipe.generate(videoId, dir);
      await rename(tmp, final);
      const ms = Date.now() - started;
      console.log(`[derivatives] ${videoId}/${recipe.filename} (${ms}ms)`);
    } catch (err) {
      console.error(
        `[derivatives] ${videoId}/${recipe.filename} failed:`,
        err instanceof Error ? err.message : err
      );
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}
