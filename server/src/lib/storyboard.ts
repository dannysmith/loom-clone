import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";
import { spawnFfmpeg } from "./ffmpeg";

// Storyboard sprite sheet + WebVTT generation for scrubber thumbnail previews.
// Produces a single JPEG sprite and an accompanying VTT so Vidstack's
// <media-slider-thumbnail> shows preview frames on hover.

const TILE_WIDTH = 240; // Scale each frame to 240px wide.

// The mjpeg encoder only accepts full-range 4:2:0 and errors out on anything
// else ("Non full-range YUV is non-standard"), so the sprite conversion is
// pinned here rather than left to whatever chroma the input happens to carry.
// A storyboard failure aborts the whole staged rebuild, so it must not depend
// on the source's pixel format.
const JPEG_PIX_FMT = "format=yuvj420p";

export type StoryboardParams = {
  interval: number;
  expectedFrames: number;
  cols: number;
  rows: number;
  // The video's length, so the last cue can stop where the video does rather
  // than at the next interval boundary.
  duration: number;
};

// Compute storyboard grid parameters from video duration.
//
// EVERY video gets a storyboard, however short. There used to be a 60-second
// floor to save disk, but the sprite for a minute-long video is ~67 KB against a
// 90 MB master, and the threshold had a sharper cost: it was the only thing in
// the served set whose existence moved when a video was edited, so trimming a
// 66s video to 55s silently orphaned its storyboard describing the uncut
// timeline. Nothing viewer-facing appears or disappears with an edit now.
export function computeStoryboardParams(duration: number): StoryboardParams | null {
  if (duration <= 0) return null;

  // The interval must fit inside the video: ffmpeg's `fps=1/N` emits nothing at
  // all unless the input runs past N/2, so a 2-second video sampled every 5
  // seconds yields an empty sprite and a failed rename. Clamping to the duration
  // guarantees one frame; above 5 seconds this changes nothing.
  const interval = Math.min(Math.max(5, Math.round(duration / 100)), duration);
  // At least one tile: below the interval, `floor` yields zero frames, which
  // would ask ffmpeg for a 0x0 tile and emit a VTT with no cues.
  const expectedFrames = Math.max(1, Math.floor(duration / interval));
  const cols = Math.min(10, expectedFrames);
  const rows = Math.ceil(expectedFrames / cols);

  return { interval, expectedFrames, cols, rows, duration };
}

// Format seconds as HH:MM:SS.mmm for VTT cues.
function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// Generate the VTT content for a storyboard sprite sheet.
// tileWidth/tileHeight are the actual pixel dimensions of each tile in the sprite.
export function generateVtt(
  params: StoryboardParams,
  tileWidth: number,
  tileHeight: number,
): string {
  const lines: string[] = ["WEBVTT", ""];

  for (let i = 0; i < params.expectedFrames; i++) {
    const startTime = i * params.interval;
    // The final tile runs to the end of the video rather than to the next
    // interval boundary. Frames are whole intervals and durations aren't, so
    // stopping at the boundary leaves a slice of the scrubber with no thumbnail
    // at all — up to a whole interval of it, which on a short video is most of
    // the last tenth.
    const endTime = i === params.expectedFrames - 1 ? params.duration : (i + 1) * params.interval;
    const col = i % params.cols;
    const row = Math.floor(i / params.cols);
    const x = col * tileWidth;
    const y = row * tileHeight;

    lines.push(`${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`);
    lines.push(`storyboard.jpg#xywh=${x},${y},${tileWidth},${tileHeight}`);
    lines.push("");
  }

  return lines.join("\n");
}

// Generate the storyboard sprite sheet and VTT file for a video.
// Files are written to the derivatives directory: storyboard.jpg + storyboard.vtt.
export async function generateStoryboard(
  derivDir: string,
  duration: number,
  inputPath?: string,
): Promise<boolean> {
  const params = computeStoryboardParams(duration);
  if (!params) return false;

  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const sourcePath = inputPath ?? join(derivDir, "source.mp4");
  const spriteFile = "storyboard.jpg";
  const spriteTmp = join(derivDir, `${spriteFile}.tmp`);
  const spriteFinal = join(derivDir, spriteFile);
  const vttFile = "storyboard.vtt";
  const vttFinal = join(derivDir, vttFile);

  await mkdir(derivDir, { recursive: true });

  // Generate sprite sheet via ffmpeg tile filter.
  const { exitCode, stderr } = await spawnFfmpeg(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-vf",
    `fps=1/${params.interval},scale=${TILE_WIDTH}:-2,tile=${params.cols}x${params.rows},${JPEG_PIX_FMT}`,
    "-qscale:v",
    "5",
    "-frames:v",
    "1",
    "-f",
    "image2",
    spriteTmp,
  ]);
  if (exitCode !== 0) {
    await rm(spriteTmp, { force: true }).catch(() => {});
    throw new Error(`storyboard generation failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  // Atomic rename for the sprite.
  await rename(spriteTmp, spriteFinal);

  // Read actual tile dimensions from the generated sprite via ffprobe.
  const { tileWidth, tileHeight } = await probeTileDimensions(spriteFinal, params);

  // Generate and write the VTT file.
  const vttContent = generateVtt(params, tileWidth, tileHeight);
  await Bun.write(vttFinal, vttContent);

  return true;
}

// --- Editor storyboard (dense frame extraction for the editing timeline) ---

const EDITOR_TILE_WIDTH = 200;
const EDITOR_MIN_DURATION = 5;

export type EditorStoryboardParams = {
  interval: number;
  expectedFrames: number;
  cols: number;
  rows: number;
  duration: number;
};

// 1 fps up to 10 minutes, 0.5 fps beyond. Keeps its 5-second floor: this one is
// source-derived, so its applicability never moves when a video is edited.
export function computeEditorStoryboardParams(duration: number): EditorStoryboardParams | null {
  if (duration < EDITOR_MIN_DURATION) return null;

  const interval = duration <= 600 ? 1 : 2;
  const expectedFrames = Math.max(1, Math.floor(duration / interval));
  const cols = Math.min(10, expectedFrames);
  const rows = Math.ceil(expectedFrames / cols);

  return { interval, expectedFrames, cols, rows, duration };
}

export function generateEditorVtt(
  params: EditorStoryboardParams,
  tileWidth: number,
  tileHeight: number,
): string {
  const lines: string[] = ["WEBVTT", ""];

  for (let i = 0; i < params.expectedFrames; i++) {
    const startTime = i * params.interval;
    const endTime = i === params.expectedFrames - 1 ? params.duration : (i + 1) * params.interval;
    const col = i % params.cols;
    const row = Math.floor(i / params.cols);
    const x = col * tileWidth;
    const y = row * tileHeight;

    lines.push(`${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`);
    lines.push(`editor-storyboard.jpg#xywh=${x},${y},${tileWidth},${tileHeight}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function generateEditorStoryboard(
  derivDir: string,
  duration: number,
  inputPath?: string,
): Promise<boolean> {
  const params = computeEditorStoryboardParams(duration);
  if (!params) return false;

  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const sourcePath = inputPath ?? join(derivDir, "source.mp4");
  const spriteFile = "editor-storyboard.jpg";
  const spriteTmp = join(derivDir, `${spriteFile}.tmp`);
  const spriteFinal = join(derivDir, spriteFile);
  const vttFile = "editor-storyboard.vtt";
  const vttFinal = join(derivDir, vttFile);

  await mkdir(derivDir, { recursive: true });

  const { exitCode, stderr } = await spawnFfmpeg(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-vf",
    `fps=1/${params.interval},scale=${EDITOR_TILE_WIDTH}:-2,tile=${params.cols}x${params.rows},${JPEG_PIX_FMT}`,
    "-qscale:v",
    "5",
    "-frames:v",
    "1",
    "-f",
    "image2",
    spriteTmp,
  ]);
  if (exitCode !== 0) {
    await rm(spriteTmp, { force: true }).catch(() => {});
    throw new Error(`editor storyboard generation failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  await rename(spriteTmp, spriteFinal);

  const { tileWidth, tileHeight } = await probeTileDimensions(spriteFinal, params);
  const vttContent = generateEditorVtt(params, tileWidth, tileHeight);
  await Bun.write(vttFinal, vttContent);

  return true;
}

// Probe the sprite sheet dimensions and compute per-tile size from the grid.
async function probeTileDimensions(
  spritePath: string,
  params: StoryboardParams,
): Promise<{ tileWidth: number; tileHeight: number }> {
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) {
    // Fallback: estimate from the configured tile width and 16:9 assumption.
    return { tileWidth: TILE_WIDTH, tileHeight: Math.round(TILE_WIDTH * (9 / 16)) };
  }

  try {
    const proc = Bun.spawn(
      [
        ffprobePath,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-select_streams",
        "v:0",
        spritePath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) throw new Error("ffprobe failed");

    const data = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const spriteWidth = data.streams?.[0]?.width;
    const spriteHeight = data.streams?.[0]?.height;

    if (spriteWidth && spriteHeight) {
      return {
        tileWidth: Math.floor(spriteWidth / params.cols),
        tileHeight: Math.floor(spriteHeight / params.rows),
      };
    }
  } catch {
    // Fall through to default.
  }

  return { tileWidth: TILE_WIDTH, tileHeight: Math.round(TILE_WIDTH * (9 / 16)) };
}
