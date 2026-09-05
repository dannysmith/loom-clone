import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";
import { requireFfmpeg, spawnFfmpeg } from "./ffmpeg";
import { probeJson } from "./ffprobe";

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

// Generate the VTT content for a storyboard sprite sheet. `tileWidth`/
// `tileHeight` are the actual pixel dimensions of each tile in the sprite, and
// `spriteFile` is what the cues point at.
export function generateVtt(
  params: StoryboardParams,
  tileWidth: number,
  tileHeight: number,
  spriteFile = "storyboard.jpg",
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

    lines.push(`${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`);
    lines.push(
      `${spriteFile}#xywh=${col * tileWidth},${row * tileHeight},${tileWidth},${tileHeight}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// Generate the storyboard sprite sheet and VTT file for a video.
// Files are written to the derivatives directory: storyboard.jpg + storyboard.vtt.
// --- Editor storyboard (dense frames for the editing timeline) ---

const EDITOR_TILE_WIDTH = 200;
const EDITOR_MIN_DURATION = 5;

// 1 fps up to 10 minutes, 0.5 fps beyond. Keeps its 5-second floor: this one is
// source-derived, so its applicability never moves when a video is edited.
export function computeEditorStoryboardParams(duration: number): StoryboardParams | null {
  if (duration < EDITOR_MIN_DURATION) return null;

  const interval = duration <= 600 ? 1 : 2;
  const expectedFrames = Math.max(1, Math.floor(duration / interval));
  const cols = Math.min(10, expectedFrames);
  const rows = Math.ceil(expectedFrames / cols);

  return { interval, expectedFrames, cols, rows, duration };
}

// Render a sprite sheet and its VTT. Both storyboards are the same operation
// with different sampling and a different name, and keeping them as two
// near-identical copies meant fixing the same bug twice — the last-cue overrun
// and the JPEG pixel format both had to be corrected in each.
async function renderStoryboard(opts: {
  derivDir: string;
  inputPath: string;
  params: StoryboardParams;
  basename: string;
  tileWidth: number;
}): Promise<boolean> {
  const { derivDir, inputPath, params, basename, tileWidth } = opts;
  const ffmpeg = requireFfmpeg();

  const spriteFile = `${basename}.jpg`;
  const spriteTmp = join(derivDir, `${spriteFile}.tmp`);
  const spriteFinal = join(derivDir, spriteFile);

  await mkdir(derivDir, { recursive: true });

  const { exitCode, stderr } = await spawnFfmpeg(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vf",
    `fps=1/${params.interval},scale=${tileWidth}:-2,tile=${params.cols}x${params.rows},${JPEG_PIX_FMT}`,
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
    throw new Error(`${basename} generation failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  await rename(spriteTmp, spriteFinal);

  // Read the actual tile size back off the sprite rather than assuming it: the
  // scale filter picks the height from the source's aspect ratio.
  const tile = await probeTileDimensions(spriteFinal, params, tileWidth);
  await Bun.write(
    join(derivDir, `${basename}.vtt`),
    generateVtt(params, tile.tileWidth, tile.tileHeight, spriteFile),
  );

  return true;
}

// Viewer-facing storyboard: sparse frames for scrubber hover previews, cut from
// the presentation master.
export async function generateStoryboard(
  derivDir: string,
  duration: number,
  inputPath?: string,
): Promise<boolean> {
  const params = computeStoryboardParams(duration);
  if (!params) return false;
  return renderStoryboard({
    derivDir,
    inputPath: inputPath ?? join(derivDir, "source.mp4"),
    params,
    basename: "storyboard",
    tileWidth: TILE_WIDTH,
  });
}

// Editor storyboard: dense frames for the editing timeline, cut from the
// pristine source because that's what the editor plays.
export async function generateEditorStoryboard(
  derivDir: string,
  duration: number,
  inputPath?: string,
): Promise<boolean> {
  const params = computeEditorStoryboardParams(duration);
  if (!params) return false;
  return renderStoryboard({
    derivDir,
    inputPath: inputPath ?? join(derivDir, "source.mp4"),
    params,
    basename: "editor-storyboard",
    tileWidth: EDITOR_TILE_WIDTH,
  });
}

// Probe the sprite sheet dimensions and compute per-tile size from the grid.
async function probeTileDimensions(
  spritePath: string,
  params: StoryboardParams,
  tileWidth: number,
): Promise<{ tileWidth: number; tileHeight: number }> {
  // Fallback assumes 16:9 at the width we asked the scale filter for. It takes
  // the caller's width rather than a constant, because the editor sprite's tiles
  // are narrower than the viewer's.
  const fallback = { tileWidth, tileHeight: Math.round(tileWidth * (9 / 16)) };

  const data = (await probeJson([
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "v:0",
    spritePath,
  ])) as { streams?: Array<{ width?: number; height?: number }> } | null;

  const spriteWidth = data?.streams?.[0]?.width;
  const spriteHeight = data?.streams?.[0]?.height;
  if (!spriteWidth || !spriteHeight) return fallback;

  return {
    tileWidth: Math.floor(spriteWidth / params.cols),
    tileHeight: Math.floor(spriteHeight / params.rows),
  };
}
