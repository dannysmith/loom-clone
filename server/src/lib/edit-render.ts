// Rendering helpers for applying an EDL (edit decision list) to source.mp4:
// building the trimmed/concatenated output and deriving the edited captions.
// Shared by the post-processing pipeline's `edited_output` step. Pure ffmpeg +
// data transforms — no DB or status concerns live here.

import { join } from "path";
import { deriveEditedTranscript, type Segment, type Word } from "./edit-transcript";
import { spawnFfmpeg } from "./ffmpeg";

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
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
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
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
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

let ffmpegPath: string | null | undefined;

// Render the edited output, writing atomically via a temp file.
export async function renderEditedOutput(
  sourcePath: string,
  outputPath: string,
  kept: Segment[],
): Promise<void> {
  if (ffmpegPath === undefined) ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const tmpPath = `${outputPath}.tmp`;
  const { exitCode, stderr } = await spawnFfmpeg(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...buildEditArgs(sourcePath, tmpPath, kept),
  ]);
  if (exitCode !== 0) throw new Error(`ffmpeg edit render exited ${exitCode}: ${stderr.trim()}`);
  const { rename } = await import("fs/promises");
  await rename(tmpPath, outputPath);
}

// Derive edited captions from the unchanged words.json + the kept segments,
// writing captions.srt into `outDir`. Returns the edited plain text for the
// caller to upsert into the transcript, or null when there's no words.json.
export async function deriveEditedCaptions(
  derivDir: string,
  outDir: string,
  keptSegments: Segment[],
): Promise<string | null> {
  const wordsFile = Bun.file(join(derivDir, "words.json"));
  if (!(await wordsFile.exists())) return null;

  const originalWords = (await wordsFile.json()) as Word[];
  const result = deriveEditedTranscript(originalWords, keptSegments);
  if (result.srt) await Bun.write(join(outDir, "captions.srt"), result.srt);
  return result.plainText || null;
}
