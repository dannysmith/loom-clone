// Generates suggested-edits.json from source.mp4 by running ffmpeg's
// silencedetect filter and converting the detected silences into
// EDL-shaped suggestions (one suggested trim covering leading/trailing
// silence, plus any number of suggested interior cuts).
//
// The file is written once at post-processing for new videos (when
// lastEditedAt is null and no suggestions file exists yet) and deleted
// when the user commits their first edit, so suggestions only appear
// the first time the editor is opened. Healing reruns derivatives
// idempotently — see the skip conditions below.
//
// On disk shape mirrors edits.json so the editor can merge accepted
// suggestions into the live EDL with no transformation.

import { rename } from "fs/promises";
import { join } from "path";

// Silences shorter than this don't pre-populate the editor.
const SILENCE_MIN_SECONDS = 3;

// dB below 0 dBFS that qualifies as "silent." Speech recordings post-
// loudnorm sit around -14 LUFS with peaks at -1.5 dBTP; room ambience
// post-denoise is ~-50 dB. -30 dB catches silence without clipping
// quiet speech.
const SILENCE_NOISE_DB = -30;

// Padding subtracted from each end of a detected silence so the
// suggested cut leaves a tiny breath of audio rather than slicing into
// adjacent words.
const CUT_PADDING_SECONDS = 0.1;

// A silence that starts within this many seconds of the file start (or
// ends within this many seconds of the file end) is treated as
// leading/trailing silence and contributes to the suggested trim
// instead of becoming a cut.
const EDGE_TOLERANCE_SECONDS = 0.5;

// Suggested trim leaves this much pre-roll before the first speech (and
// post-roll after the last speech) so the speaker's first/last word
// isn't clipped.
const TRIM_PADDING_SECONDS = 0.1;

export type SuggestedEdit =
  | { type: "trim"; startTime: number; endTime: number }
  | { type: "cut"; startTime: number; endTime: number };

export type SuggestedEdits = {
  version: 1;
  source: string;
  edits: SuggestedEdit[];
};

type Silence = { start: number; end: number };

// Parse silence_start / silence_end lines from ffmpeg stderr. Tolerates
// either ordering and treats an unmatched silence_start at the end as a
// silence that runs to the end of the file.
export function parseSilenceDetectOutput(stderr: string, duration: number): Silence[] {
  const silences: Silence[] = [];
  let pendingStart: number | null = null;

  // Match e.g. "[silencedetect @ 0x...] silence_start: 4.12345"
  // or       "[silencedetect @ 0x...] silence_end: 8.901 | silence_duration: 4.778"
  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
  const endRe = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;

  // Walk the stderr line by line so start/end ordering is preserved.
  for (const line of stderr.split("\n")) {
    startRe.lastIndex = 0;
    endRe.lastIndex = 0;
    const startMatch = startRe.exec(line);
    if (startMatch?.[1] !== undefined) {
      pendingStart = Math.max(0, Number.parseFloat(startMatch[1]));
      continue;
    }
    const endMatch = endRe.exec(line);
    if (endMatch?.[1] !== undefined && pendingStart !== null) {
      const end = Math.min(duration, Number.parseFloat(endMatch[1]));
      if (end > pendingStart) silences.push({ start: pendingStart, end });
      pendingStart = null;
    }
  }

  // ffmpeg sometimes omits a final silence_end if the file ends in
  // silence. Treat that as silence running to the file end.
  if (pendingStart !== null && duration > pendingStart) {
    silences.push({ start: pendingStart, end: duration });
  }

  return silences;
}

// Convert raw silences into EDL-shaped suggestions. Edge silences become
// a single suggested trim; interior silences become suggested cuts.
export function suggestionsFromSilences(silences: Silence[], duration: number): SuggestedEdit[] {
  const edits: SuggestedEdit[] = [];

  let trimStart = 0;
  let trimEnd = duration;
  let trimChanged = false;

  // Filter out silences too close to the edges — they roll up into the
  // suggested trim. Whatever's left is interior cuts.
  const interior: Silence[] = [];
  for (const s of silences) {
    const isLeading = s.start <= EDGE_TOLERANCE_SECONDS;
    const isTrailing = s.end >= duration - EDGE_TOLERANCE_SECONDS;

    if (isLeading) {
      trimStart = Math.max(trimStart, s.end - TRIM_PADDING_SECONDS);
      trimChanged = true;
    } else if (isTrailing) {
      trimEnd = Math.min(trimEnd, s.start + TRIM_PADDING_SECONDS);
      trimChanged = true;
    } else {
      interior.push(s);
    }
  }

  if (trimChanged && trimEnd > trimStart) {
    // Clamp into bounds before writing.
    edits.push({
      type: "trim",
      startTime: Math.max(0, trimStart),
      endTime: Math.min(duration, trimEnd),
    });
  }

  for (const s of interior) {
    const startTime = s.start + CUT_PADDING_SECONDS;
    const endTime = s.end - CUT_PADDING_SECONDS;
    // Detected silences are already at least SILENCE_MIN_SECONDS long, so
    // after symmetric padding the cut is always positive — but guard
    // anyway to keep zero-/negative-length entries out of the EDL.
    if (endTime > startTime) {
      edits.push({ type: "cut", startTime, endTime });
    }
  }

  return edits;
}

// Run ffmpeg silencedetect against a source file. Returns the silence
// ranges parsed from stderr.
async function runSilenceDetect(sourcePath: string, duration: number): Promise<Silence[]> {
  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("ffmpeg not found on PATH");

  const proc = Bun.spawn(
    [
      ffmpegPath,
      "-y",
      "-hide_banner",
      "-nostats",
      // silencedetect logs at "info" — keep stderr verbose enough to capture it.
      "-loglevel",
      "info",
      "-i",
      sourcePath,
      "-af",
      `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
      "-vn",
      "-f",
      "null",
      "-",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`silencedetect failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return parseSilenceDetectOutput(stderr, duration);
}

// Generate suggested-edits.json. Returns true if a file was written,
// false if there were no suggestions worth surfacing (or generation was
// skipped because the file already exists).
export async function generateSuggestedEdits(
  derivDir: string,
  duration: number,
  inputPath?: string,
): Promise<boolean> {
  if (duration < SILENCE_MIN_SECONDS) return false;

  const finalPath = join(derivDir, "suggested-edits.json");
  if (await Bun.file(finalPath).exists()) {
    // Idempotent: don't overwrite an existing file (e.g. healing rerun
    // before any edits were made).
    return false;
  }

  const sourcePath = inputPath ?? join(derivDir, "source.mp4");

  const silences = await runSilenceDetect(sourcePath, duration);
  const edits = suggestionsFromSilences(silences, duration);
  if (edits.length === 0) return false;

  const tmpPath = join(derivDir, "suggested-edits.json.tmp");
  const payload: SuggestedEdits = { version: 1, source: "source.mp4", edits };
  await Bun.write(tmpPath, JSON.stringify(payload, null, 2));
  await rename(tmpPath, finalPath);
  return true;
}

// Test-only exports.
export {
  CUT_PADDING_SECONDS as _CUT_PADDING_SECONDS,
  EDGE_TOLERANCE_SECONDS as _EDGE_TOLERANCE_SECONDS,
  SILENCE_MIN_SECONDS as _SILENCE_MIN_SECONDS,
  TRIM_PADDING_SECONDS as _TRIM_PADDING_SECONDS,
};
