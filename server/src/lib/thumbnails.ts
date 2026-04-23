import { copyFile, mkdir, readdir, rename, rm } from "fs/promises";
import { join } from "path";
import { DATA_DIR } from "./store";

// Thumbnail candidate extraction and selection. Replaces the old single-frame
// thumbnail recipe with a multi-candidate system: extract several frames biased
// toward the beginning of the video, score them by luminance variance, and
// promote the best one.

const CANDIDATES_DIR = "thumbnail-candidates";

// Fixed-second anchors (biased toward early frames).
const FIXED_ANCHORS = [2, 5, 15];
// Percentage-of-duration anchors.
const PERCENT_ANCHORS = [0.1, 0.2, 0.4, 0.6];

// Minimum gap between kept candidates after deduplication.
const MIN_GAP = 2;
// Minimum usable timestamp (skip encoder warm-up artifacts).
const MIN_TIMESTAMP = 1;
// Buffer from end to avoid reaching-for-stop frames.
const END_BUFFER = 2;

// Build the sorted, deduplicated candidate timestamp set for a given duration.
export function buildCandidateTimestamps(duration: number): number[] {
  // Union of fixed anchors and percentage anchors.
  const raw = new Set<number>();
  for (const t of FIXED_ANCHORS) raw.add(t);
  for (const p of PERCENT_ANCHORS) raw.add(Math.round(duration * p * 100) / 100);

  // Prune: drop too-early, too-late timestamps.
  const maxT = duration - END_BUFFER;
  const pruned = [...raw].filter((t) => t >= MIN_TIMESTAMP && t <= maxT);

  // Sort ascending.
  pruned.sort((a, b) => a - b);

  // Dedupe by minimum gap: walk the list, keep a candidate only if it's
  // at least MIN_GAP seconds from the previously kept one.
  const kept: number[] = [];
  for (const t of pruned) {
    const last = kept[kept.length - 1];
    if (last === undefined || t - last >= MIN_GAP) {
      kept.push(t);
    }
  }

  // Fallback for pathologically short videos.
  if (kept.length === 0) {
    kept.push(duration / 2);
  }

  return kept;
}

export function candidatesDir(videoId: string): string {
  return join(DATA_DIR, videoId, "derivatives", CANDIDATES_DIR);
}

// Extract thumbnail candidate frames from source.mp4 and promote the best one.
// Writes candidates to derivatives/thumbnail-candidates/auto-NN.jpg and
// promotes the winner to derivatives/thumbnail.jpg.
export async function extractAndPromoteThumbnails(
  derivDir: string,
  duration: number,
): Promise<void> {
  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const source = join(derivDir, "source.mp4");
  const candDir = join(derivDir, CANDIDATES_DIR);

  // Clean any previous candidates (idempotent re-run).
  await rm(candDir, { recursive: true, force: true });
  await mkdir(candDir, { recursive: true });

  const timestamps = buildCandidateTimestamps(duration);

  // Step 1: extract each candidate frame.
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i]!;
    const filename = `auto-${String(i).padStart(2, "0")}.jpg`;
    const outPath = join(candDir, filename);
    await runFfmpegExtract(ffmpegPath, source, t, outPath);
  }

  // Step 2: score candidates by luminance variance.
  const scored = await scoreCandidates(candDir);

  // Step 3: promote the best one to thumbnail.jpg.
  await promoteBestCandidate(scored, derivDir);
}

async function runFfmpegExtract(
  ffmpegPath: string,
  source: string,
  timestamp: number,
  outPath: string,
): Promise<void> {
  const proc = Bun.spawn(
    [
      ffmpegPath,
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      timestamp.toFixed(3),
      "-i",
      source,
      "-vframes",
      "1",
      "-vf",
      "scale=1280:-2",
      "-qscale:v",
      "5",
      "-f",
      "image2",
      outPath,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg thumbnail extract failed (t=${timestamp}): ${stderr.trim()}`);
  }
}

type ScoredCandidate = {
  filename: string;
  path: string;
  variance: number;
};

// Score each candidate image by luminance variance. Higher variance = more
// visual detail (less likely to be a blank/black frame).
async function scoreCandidates(candDir: string): Promise<ScoredCandidate[]> {
  const entries = await readdir(candDir);
  const jpgs = entries.filter((f) => f.endsWith(".jpg")).sort();

  const scored: ScoredCandidate[] = [];
  for (const filename of jpgs) {
    const filePath = join(candDir, filename);
    const variance = await measureVariance(filePath);
    scored.push({ filename, path: filePath, variance });
  }
  return scored;
}

// Use ffmpeg signalstats to measure luminance variance of a single frame.
async function measureVariance(imagePath: string): Promise<number> {
  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) return fallbackVariance(imagePath);

  try {
    const proc = Bun.spawn(
      [
        ffmpegPath,
        "-y",
        "-hide_banner",
        "-i",
        imagePath,
        "-vf",
        "signalstats,metadata=print:file=-",
        "-f",
        "null",
        "-",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return fallbackVariance(imagePath);

    // Parse signalstats output from both stdout and stderr.
    const combined = stdout + stderr;
    const ylow = parseSignalStat(combined, "YLOW");
    const yhigh = parseSignalStat(combined, "YHIGH");
    if (ylow !== null && yhigh !== null) {
      // Range as a proxy for variance — sufficient for blank detection.
      return yhigh - ylow;
    }

    // Fallback: try YMIN/YMAX.
    const ymin = parseSignalStat(combined, "YMIN");
    const ymax = parseSignalStat(combined, "YMAX");
    if (ymin !== null && ymax !== null) {
      return ymax - ymin;
    }

    return fallbackVariance(imagePath);
  } catch {
    return fallbackVariance(imagePath);
  }
}

function parseSignalStat(output: string, key: string): number | null {
  const re = new RegExp(`lavfi\\.signalstats\\.${key}=(\\d+(?:\\.\\d+)?)`);
  const match = output.match(re);
  if (!match?.[1]) return null;
  const v = Number.parseFloat(match[1]);
  return Number.isFinite(v) ? v : null;
}

// Fallback variance estimation: read raw bytes and compute a simple
// brightness spread. Not as accurate as signalstats but works when
// ffprobe/signalstats is unavailable.
async function fallbackVariance(imagePath: string): Promise<number> {
  try {
    const file = Bun.file(imagePath);
    const buf = new Uint8Array(await file.arrayBuffer());
    // Sample every 100th byte as a rough luminance proxy.
    let min = 255;
    let max = 0;
    for (let i = 0; i < buf.length; i += 100) {
      const v = buf[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  } catch {
    return 0;
  }
}

// Near-blank threshold: frames with luminance range below this are considered
// blank (black screen, white screen, solid color).
const BLANK_THRESHOLD = 20;

async function promoteBestCandidate(
  candidates: ScoredCandidate[],
  derivDir: string,
): Promise<void> {
  if (candidates.length === 0) return;

  // Walk candidates in time order (they're already sorted by filename).
  // Promote the first whose variance exceeds the blank threshold.
  let winner = candidates[0]!;
  for (const c of candidates) {
    if (c.variance > BLANK_THRESHOLD) {
      winner = c;
      break;
    }
  }

  // If all are below threshold, pick the highest-variance one.
  if (winner.variance <= BLANK_THRESHOLD) {
    winner = candidates.reduce((best, c) => (c.variance > best.variance ? c : best), winner);
  }

  // Atomic copy: write .tmp then rename.
  const thumbnailPath = join(derivDir, "thumbnail.jpg");
  const tmpPath = `${thumbnailPath}.tmp`;
  await copyFile(winner.path, tmpPath);
  await rename(tmpPath, thumbnailPath);
}

// List all thumbnail candidates for a video. Returns metadata for the admin
// thumbnail picker UI.
export type ThumbnailCandidate = {
  id: string;
  filename: string;
  kind: "auto" | "custom";
  promoted: boolean;
};

export async function listThumbnailCandidates(videoId: string): Promise<ThumbnailCandidate[]> {
  const derivDir = join(DATA_DIR, videoId, "derivatives");
  const candDir = join(derivDir, CANDIDATES_DIR);

  let files: string[];
  try {
    files = await readdir(candDir);
  } catch {
    return [];
  }

  const jpgs = files.filter((f) => f.endsWith(".jpg")).sort();

  // Determine which candidate is currently promoted by comparing file sizes
  // and modification times with thumbnail.jpg.
  let promotedFilename: string | null = null;
  try {
    const thumbFile = Bun.file(join(derivDir, "thumbnail.jpg"));
    if (await thumbFile.exists()) {
      const thumbSize = thumbFile.size;
      for (const f of jpgs) {
        const candFile = Bun.file(join(candDir, f));
        if (candFile.size === thumbSize) {
          // Quick content comparison for the matching-size candidate.
          const [thumbBuf, candBuf] = await Promise.all([
            thumbFile.arrayBuffer(),
            candFile.arrayBuffer(),
          ]);
          if (buffersEqual(new Uint8Array(thumbBuf), new Uint8Array(candBuf))) {
            promotedFilename = f;
            break;
          }
        }
      }
    }
  } catch {
    // Can't determine promoted candidate — mark none.
  }

  return jpgs.map((f) => ({
    id: f.replace(/\.jpg$/, ""),
    filename: f,
    kind: f.startsWith("custom-") ? "custom" : "auto",
    promoted: f === promotedFilename,
  }));
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Promote a specific candidate to thumbnail.jpg. Atomic copy.
export async function promoteCandidate(videoId: string, candidateId: string): Promise<boolean> {
  const derivDir = join(DATA_DIR, videoId, "derivatives");
  const candDir = join(derivDir, CANDIDATES_DIR);
  const candidatePath = join(candDir, `${candidateId}.jpg`);

  const file = Bun.file(candidatePath);
  if (!(await file.exists())) return false;

  const thumbnailPath = join(derivDir, "thumbnail.jpg");
  const tmpPath = `${thumbnailPath}.tmp`;
  await copyFile(candidatePath, tmpPath);
  await rename(tmpPath, thumbnailPath);
  return true;
}

// Save a custom-uploaded JPEG as a candidate. Returns the candidate id.
// Resizes to 1280px wide if larger. Max 5 MB, max 3840px wide enforced by caller.
export async function saveCustomThumbnail(
  videoId: string,
  imageData: ArrayBuffer,
): Promise<string> {
  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const derivDir = join(DATA_DIR, videoId, "derivatives");
  const candDir = join(derivDir, CANDIDATES_DIR);
  await mkdir(candDir, { recursive: true });

  // Compact ISO timestamp for filename: 20260423T120000123Z
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, now.getMilliseconds().toString().padStart(3, "0"));
  const candidateId = `custom-${ts}`;
  const outPath = join(candDir, `${candidateId}.jpg`);

  // Write input to a temp file, resize with ffmpeg.
  const tmpInput = join(candDir, `${candidateId}-input.tmp`);
  await Bun.write(tmpInput, imageData);

  try {
    const proc = Bun.spawn(
      [
        ffmpegPath,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        tmpInput,
        "-vf",
        "scale='min(1280,iw)':-2",
        "-qscale:v",
        "5",
        "-f",
        "image2",
        outPath,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg custom thumbnail resize failed: ${stderr.trim()}`);
    }
  } finally {
    await rm(tmpInput, { force: true }).catch(() => {});
  }

  return candidateId;
}
