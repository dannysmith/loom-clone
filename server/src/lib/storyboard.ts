import { mkdir, rename, rm } from "fs/promises";
import { join } from "path";

// Storyboard sprite sheet + WebVTT generation for scrubber thumbnail previews.
// Produces a single JPEG sprite and an accompanying VTT so Vidstack's
// <media-slider-thumbnail> shows preview frames on hover.

const MIN_DURATION = 60; // Skip for videos shorter than 60 seconds.
const TILE_WIDTH = 240; // Scale each frame to 240px wide.

export type StoryboardParams = {
  interval: number;
  expectedFrames: number;
  cols: number;
  rows: number;
};

// Compute storyboard grid parameters from video duration.
export function computeStoryboardParams(duration: number): StoryboardParams | null {
  if (duration < MIN_DURATION) return null;

  const interval = Math.max(5, Math.round(duration / 100));
  const expectedFrames = Math.floor(duration / interval);
  const cols = Math.min(10, expectedFrames);
  const rows = Math.ceil(expectedFrames / cols);

  return { interval, expectedFrames, cols, rows };
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
    const endTime = (i + 1) * params.interval;
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
export async function generateStoryboard(derivDir: string, duration: number): Promise<boolean> {
  const params = computeStoryboardParams(duration);
  if (!params) return false;

  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const sourcePath = join(derivDir, "source.mp4");
  const spriteFile = "storyboard.jpg";
  const spriteTmp = join(derivDir, `${spriteFile}.tmp`);
  const spriteFinal = join(derivDir, spriteFile);
  const vttFile = "storyboard.vtt";
  const vttFinal = join(derivDir, vttFile);

  await mkdir(derivDir, { recursive: true });

  // Generate sprite sheet via ffmpeg tile filter.
  const proc = Bun.spawn(
    [
      ffmpegPath,
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      `fps=1/${params.interval},scale=${TILE_WIDTH}:-2,tile=${params.cols}x${params.rows}`,
      "-qscale:v",
      "5",
      "-f",
      "image2",
      spriteTmp,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
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
