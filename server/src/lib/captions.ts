// Captions live either side of the source/presentation split, so they get their
// own module.
//
// `captions.original.srt` (or `.vtt`) is a SOURCE-group artifact: the transcript
// exactly as the Mac produced it, written by the transcript endpoint and never
// modified afterwards. The served `captions.srt` / `captions.vtt` is a
// PRESENTATION-group artifact: the original mapped onto the presentation
// timeline. With no edits that mapping is the identity, so the file is a verbatim
// copy and the Mac's own cue segmentation survives intact; with edits it's
// re-derived from `words.json`, which is the only way to drop cut words and shift
// what follows.

import { copyFile, rename, rm } from "fs/promises";
import { join } from "path";
import { deriveEditedTranscript, type Segment, type Word } from "./edit-transcript";
import { parseSrtToPlainText } from "./srt";

export type CaptionFormat = "srt" | "vtt";

export const ORIGINAL_BASENAME = "captions.original";
export const SERVED_BASENAME = "captions";

export function originalCaptionsPath(derivDir: string, format: CaptionFormat): string {
  return join(derivDir, `${ORIGINAL_BASENAME}.${format}`);
}

export function servedCaptionsPath(derivDir: string, format: CaptionFormat): string {
  return join(derivDir, `${SERVED_BASENAME}.${format}`);
}

// Store an incoming transcript as the pristine original (atomic tmp→rename).
// Producing the served captions from it is a separate concern — the `captions`
// pipeline step — because it depends on the EDL.
//
// A transcript in the other format is dropped, because there is only ever ONE
// original: findOriginalCaptions prefers SRT, so an SRT left behind by an
// earlier upload would shadow a VTT sent later and the video would keep serving
// captions from a transcript that has been replaced.
export async function writeOriginalCaptions(
  derivDir: string,
  format: CaptionFormat,
  body: string,
): Promise<void> {
  const final = originalCaptionsPath(derivDir, format);
  const tmp = `${final}.tmp`;
  await Bun.write(tmp, body);
  await rename(tmp, final);
  const superseded: CaptionFormat = format === "srt" ? "vtt" : "srt";
  await rm(originalCaptionsPath(derivDir, superseded), { force: true }).catch(() => {});
}

// The stored original, if there is one. SRT wins when both exist — it's what the
// Mac sends, so a stray VTT would be a manual upload.
export async function findOriginalCaptions(
  derivDir: string,
): Promise<{ format: CaptionFormat; body: string } | null> {
  for (const format of ["srt", "vtt"] as const) {
    const file = Bun.file(originalCaptionsPath(derivDir, format));
    if (await file.exists()) return { format, body: await file.text() };
  }
  return null;
}

export type CaptionsResult =
  | { state: "written"; format: CaptionFormat; plainText: string }
  | { state: "skipped" };

// Build the served captions for the current presentation timeline. `kept` is the
// EDL's kept-segment set; `fullSpan` says whether that set is the whole source
// (no edits, or every edit removed).
//
// `inputDir` and `outDir` differ during a staged rebuild: the stored original and
// words.json are always read from the real derivatives dir, while the output goes
// wherever the run is staging its replacement set.
//
// Returns "skipped" when there's nothing to build from — no stored original, or
// an edited video with no `words.json` to remap. The caller (the `captions` step)
// treats that as an invalidation and drops whatever was being served.
export async function buildServedCaptions(opts: {
  inputDir: string;
  outDir: string;
  kept: Segment[];
  fullSpan: boolean;
}): Promise<CaptionsResult> {
  const { inputDir, outDir } = opts;
  const original = await findOriginalCaptions(inputDir);
  if (!original) return { state: "skipped" };

  if (opts.fullSpan) {
    await copyFile(
      originalCaptionsPath(inputDir, original.format),
      servedCaptionsPath(outDir, original.format),
    );
    await removeServedExcept(outDir, original.format);
    return {
      state: "written",
      format: original.format,
      plainText: parseSrtToPlainText(original.body),
    };
  }

  // No word timings means the cut can't be remapped. Returning "skipped" makes
  // the pipeline drop the previously-served captions, which describe the uncut
  // timeline — desynced subtitles are worse for a viewer than none.
  const wordsFile = Bun.file(join(inputDir, "words.json"));
  if (!(await wordsFile.exists())) return { state: "skipped" };

  const words = (await wordsFile.json()) as Word[];
  const derived = deriveEditedTranscript(words, opts.kept);
  if (!derived.srt) return { state: "skipped" };

  // Remapping only ever produces SRT (deriveEditedTranscript builds cues from
  // word timings), so a previously-served VTT would be the uncut timeline.
  const final = servedCaptionsPath(outDir, "srt");
  const tmp = `${final}.tmp`;
  await Bun.write(tmp, derived.srt);
  await rename(tmp, final);
  await removeServedExcept(outDir, "srt");
  return { state: "written", format: "srt", plainText: derived.plainText };
}

// Drop every served caption file except the one just written, so the viewer's
// SRT/VTT preference can't land on a stale file from a previous timeline.
async function removeServedExcept(derivDir: string, keep: CaptionFormat | null): Promise<void> {
  for (const format of ["srt", "vtt"] as const) {
    if (format === keep) continue;
    await rm(servedCaptionsPath(derivDir, format), { force: true }).catch(() => {});
  }
}
