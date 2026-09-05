// Applying an EDL (edit decision list) to source.mp4: the trimmed/concatenated
// video render. Used by the pipeline's `presentation` step when the EDL keeps
// less than the whole source. Pure ffmpeg — no DB or status concerns here, and
// no audio processing: the chain runs over this render's output, so loudness is
// measured on the final cut rather than on material that gets discarded.

import { rename } from "fs/promises";
import type { Segment } from "./edit-transcript";
import { requireFfmpeg, spawnFfmpeg } from "./ffmpeg";

export type Edl = {
  version: number;
  source: string;
  edits: { type: "trim" | "cut"; startTime: number; endTime: number }[];
};

// ffmpeg args to produce the edited output from `sourcePath` into `outputPath`,
// keeping only `kept` segments. A single kept segment is a simple trim; multiple
// segments are concatenated with a short audio fade at each join to avoid clicks.
export function buildEditArgs(sourcePath: string, outputPath: string, kept: Segment[]): string[] {
  if (kept.length === 0) {
    throw new Error("buildEditArgs: kept must contain at least one segment");
  }
  if (kept.length === 1) {
    const seg = kept[0]!;
    return [
      "-i",
      sourcePath,
      "-ss",
      String(seg.start),
      "-to",
      String(seg.end),
      // Honour the source PTS verbatim — source.mp4 is genuinely VFR with an
      // unreliable declared r_frame_rate; without passthrough, libx264 re-times
      // frames onto the bogus constant grid and silently drops the surplus.
      "-fps_mode",
      "passthrough",
      // Pin the output format the way the variant encode does. Without it x264
      // inherits the source's chroma, and a 4:4:4 source yields a High 4:4:4
      // Predictive master — a profile Safari and iOS refuse to decode, and which
      // the mjpeg encoder behind the storyboard can't read either.
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-profile:v",
      "high",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outputPath,
    ];
  }

  const CROSSFADE_MS = 0.03; // 30ms audio fade-in to prevent clicks at joins.
  const vSelects: string[] = [];
  const aSelects: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const seg = kept[i]!;
    vSelects.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    aSelects.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
  }
  const vInputs = kept.map((_, i) => `[v${i}]`).join("");
  const aInputs = kept.map((_, i) => `[a${i}]`).join("");
  const filterComplex = [
    ...vSelects,
    ...aSelects,
    `${vInputs}concat=n=${kept.length}:v=1:a=0[vout]`,
    `${aInputs}concat=n=${kept.length}:v=0:a=1[apre]`,
    `[apre]afade=t=in:d=${CROSSFADE_MS}[aout]`,
  ].join(";");

  return [
    "-i",
    sourcePath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}

// Render the edited output, writing atomically via a temp file.
export async function renderEditedOutput(
  sourcePath: string,
  outputPath: string,
  kept: Segment[],
): Promise<void> {
  const tmpPath = `${outputPath}.tmp`;
  const { exitCode, stderr } = await spawnFfmpeg(requireFfmpeg(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...buildEditArgs(sourcePath, tmpPath, kept),
  ]);
  if (exitCode !== 0) throw new Error(`ffmpeg edit render exited ${exitCode}: ${stderr.trim()}`);
  await rename(tmpPath, outputPath);
}
