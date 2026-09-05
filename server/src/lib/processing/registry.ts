// The post-processing step registry. Each step declares what it is (kind/tier),
// when it applies (appliesTo), what it depends on (inputs), how to produce it
// (run) and how to validate the result (validate). The pipeline (./pipeline.ts)
// drives these in order; reconcile and the admin readiness UI read the same
// metadata. Keeping it declarative is what makes per-step events, skip-if-ready
// resumability and dependency-aware regeneration fall out naturally.
//
// Every step belongs to one of two artifact groups, and `inputs` is where that
// shows up:
//
//   SOURCE group       — derives from the pristine source.mp4 (`inputs: ["source"]`).
//                        The editor's material: thumbnail, peaks, editor
//                        storyboard, suggested edits. Changes only when the
//                        source itself is re-stitched.
//   PRESENTATION group — derives from the <H>p.mp4 presentation master
//                        (`inputs: ["presentation"]`). What viewers get:
//                        variants, storyboard, captions. Regenerated as a set
//                        whenever the presentation changes.
//
// There is no "edit mode". An EDL is an input to the presentation master, so
// committing an edit and reprocessing are the same run.

import { join } from "path";
import type { ProcessingStepKind, Video, VideoProcessingStep } from "../../db/schema";
import { buildServedCaptions } from "../captions";
import {
  applyAudioChain,
  extractMetadata,
  generateSourceFromHls,
  generateSourceFromUpload,
  generateVariant,
  type ProbeMetadata,
  probeMetadata,
  profileNoiseFloorFor,
  remuxCopy,
  setPresentationMetadata,
  setSourcePristine,
  VARIANTS,
} from "../derivatives";
import { renderEditedOutput } from "../edit-render";
import type { Segment } from "../edit-transcript";
import { derivativesDir } from "../paths";
import { generatePeaks } from "../peaks";
import { upsertTranscript } from "../store";
import { EDITOR_MIN_DURATION, generateEditorStoryboard, generateStoryboard } from "../storyboard";
import { generateSuggestedEdits, runSilenceDetect, type Silence } from "../suggested-edits";
import { extractAndPromoteThumbnails } from "../thumbnails";
import { keptDuration, keptSegmentsFor } from "./edl";
import { isProbablyPlayable } from "./playable";

export type StepTier = "required" | "expected" | "external";
export type StepRunResult = "ready" | "skipped";

// Per-run context shared by every step. `height` is 0 until source.mp4 has been
// probed; steps gated on resolution (and the presentation master, which is named
// after it) must run after that probe.
export type StepContext = {
  videoId: string;
  video: Video;
  source: "recorded" | "uploaded";
  // Where this run WRITES: the real derivatives dir, or a staging dir during a
  // staged rebuild.
  dir: string;
  // Where persistent INPUTS live — always the real derivatives dir. edits.json,
  // words.json and captions.original.* are read from here even mid-staging,
  // because a staged run only ever writes the set it's replacing.
  inputDir: string;
  // The source.mp4 to read from. Resolved once per run: a staged intake reads the
  // source it just stitched into staging, everything else reads the preserved
  // original. Steps never join their own source path — that's what let a staged
  // run silently read the wrong file.
  sourceFile: string;
  // Measured length of the PRISTINE source: the segment-duration sum, refined by
  // a probe of source.mp4 once it exists. Drives every source-group step and the
  // EDL computation.
  sourceDuration: number;
  // INDEPENDENT expectation of how long source.mp4 should be, used to validate
  // the stitch. The segment-duration sum for a recording, the intake probe of
  // upload.mp4 for an upload, undefined when neither is available. Deliberately
  // not derived from source.mp4 — validating a file against a probe of itself
  // checks nothing.
  expectedSourceDuration?: number;
  // Duration of the presentation master — shorter than sourceDuration when the
  // EDL cuts. Seeded from the video's cached duration and rewritten by the
  // presentation step from a probe of what it produced; the storyboard threshold
  // and the DB's durationSeconds both read it. This is deliberately a second
  // named field rather than a mutated shared one — the old single `duration`
  // being rewritten mid-run was a side channel between steps.
  presentationDuration: number;
  height: number; // probed source height (0 before the source probe)
  // Whether the recording captured chapter markers — gates chapter_titles
  // applicability. Only set when the context is built for readiness/backfill (the
  // live pipeline never evaluates the external chapter_titles step).
  hasRecordedChapters?: boolean;
  scratch: {
    silences?: Silence[];
    silencesComputed: boolean;
    // source.mp4 probe, seeded by the pipeline's source probe and reused by the
    // metadata step so the source is probed once per run, not twice.
    sourceMeta?: ProbeMetadata;
    // Kept segments from the EDL, computed once by the presentation step and
    // reused by captions so both describe the same cut.
    kept?: Segment[];
    fullSpan?: boolean;
    // How long the master should be, from the EDL's kept segments. The check on
    // the produced file compares against this rather than against itself.
    expectedPresentationDuration?: number;
    // Set when the audio chain failed and the master was built without it, so
    // the run can surface that on the activity feed rather than leaving a
    // silently-unenhanced video looking identical to a processed one.
    audioChainError?: string;
  };
};

export type ProcessingStep = {
  kind: ProcessingStepKind;
  tier: StepTier;
  // Step kinds that must be `ready` (and present on disk) before this can run.
  inputs: ProcessingStepKind[];
  // Whether this step applies to this video at all. False ⇒ shown as "—" in
  // the UI and never run; it is not a failure.
  appliesTo(ctx: StepContext): boolean;
  // Server-produced steps implement run/validate/artifact. External steps
  // (Mac-sent) omit them — their rows are written by the API route handlers.
  run?(ctx: StepContext): Promise<StepRunResult>;
  // Post-run structural check; false ⇒ the step is marked `failed`.
  validate?(ctx: StepContext): Promise<boolean>;
  // Primary artifact path, for the "is it still present on disk?" servable
  // check. Absent for steps that produce no file (metadata).
  artifact?(ctx: StepContext): string;
};

// Where the `source` step WRITES. Everything that reads the source uses
// ctx.sourceFile instead, which may point at the real dir during a staged run.
export const sourceOutputPath = (ctx: StepContext): string => join(ctx.dir, "source.mp4");

// The presentation master, named for the source's own height (1440p.mp4 for a
// 1440p recording). Undefined before the source has been probed, which is why
// every presentation-group step is gated on `height > 0`.
export const presentationPath = (ctx: StepContext): string => join(ctx.dir, `${ctx.height}p.mp4`);

// One downscaled-variant step (e.g. 720p.mp4), built from the canonical
// VARIANTS entry so the height threshold, filename and kind never drift.
function variantStep(kind: ProcessingStepKind, height: number): ProcessingStep {
  const file = `${height}p.mp4`;
  return {
    kind,
    tier: "expected",
    inputs: ["presentation"],
    appliesTo: (ctx) => ctx.height > height,
    run: async (ctx) => {
      await generateVariant(ctx.dir, height, presentationPath(ctx));
      return "ready";
    },
    validate: (ctx) => isProbablyPlayable(join(ctx.dir, file)),
    artifact: (ctx) => join(ctx.dir, file),
  };
}

// Silence detection runs once per pipeline, on the pristine source. Two
// consumers: suggested_edits, and the afftdn noise-floor profile in the
// presentation step. Because source.mp4 is never loudnormed any more, there's no
// longer an ordering hazard here — pre/post-processing is a property of the file,
// not of when we look at it. (A legacy non-pristine source is already
// loudnormed, so its silences are less distinct; that's inherent and only
// affects videos recorded before the restructure.)
async function ensureSilences(ctx: StepContext): Promise<Silence[] | undefined> {
  if (ctx.scratch.silencesComputed) return ctx.scratch.silences;
  ctx.scratch.silencesComputed = true;
  if (ctx.sourceDuration >= 5) {
    try {
      ctx.scratch.silences = await runSilenceDetect(ctx.sourceFile, ctx.sourceDuration);
    } catch (err) {
      console.error(
        `[pipeline] ${ctx.videoId} silence detection failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return ctx.scratch.silences;
}

async function jsonParses(path: string): Promise<boolean> {
  try {
    await Bun.file(path).json();
    return true;
  } catch {
    return false;
  }
}

// Produce the presentation master: the EDL applied to the pristine source, with
// the audio chain over the result. Returns the probe of what it produced.
//
// The two operations compose in this order deliberately. Cutting first means the
// video is encoded exactly once and loudnorm measures the audio a viewer will
// actually hear; the audio pass copies the video track, so it costs nothing
// extra. The noise floor is still profiled from the SOURCE, because silence
// timestamps are in source coordinates.
async function buildPresentation(ctx: StepContext): Promise<void> {
  const source = ctx.sourceFile;
  const out = presentationPath(ctx);
  const { kept, fullSpan } = await keptSegmentsFor(ctx.inputDir, ctx.sourceDuration);
  if (kept.length === 0) throw new Error("presentation: all content removed by edits");
  ctx.scratch.kept = kept;
  ctx.scratch.fullSpan = fullSpan;
  // What the render SHOULD come out at, computed from the EDL rather than from
  // the file itself — see the validate below.
  ctx.scratch.expectedPresentationDuration = keptDuration(kept);

  // Uploads aren't mic recordings, and a legacy source already carries the chain
  // — re-running it would process the audio twice.
  const wantsAudioChain = ctx.source === "recorded" && ctx.video.sourcePristine;

  const cutTmp = `${out}.cut`;
  try {
    let chainInput = source;
    if (!fullSpan) {
      await renderEditedOutput(source, cutTmp, kept);
      chainInput = cutTmp;
    }

    let produced = false;
    if (wantsAudioChain) {
      const noiseFloorDb = await profileNoiseFloorFor(source, await ensureSilences(ctx));
      try {
        produced = await applyAudioChain(chainInput, out, { noiseFloorDb });
      } catch (err) {
        // The audio chain is an ENHANCEMENT. A video with un-enhanced audio is
        // worth far more than no video at all, so a failure here degrades to an
        // unprocessed master rather than failing the step and leaving nothing to
        // serve. Loud, because it should be looked at: ffmpeg's arnndn can emit
        // a frame of NaNs at end-of-stream, non-deterministically, which the AAC
        // encoder then refuses. A later reprocess retries the chain.
        console.error(
          `[pipeline] ${ctx.videoId} audio chain failed — building an unprocessed master:`,
          err instanceof Error ? err.message : err,
        );
        ctx.scratch.audioChainError = err instanceof Error ? err.message : String(err);
      }
    }
    // No chain, or it declined (no audio stream / missing model): the master is
    // the cut — or the source itself — remuxed with a faststart header.
    if (!produced) await remuxCopy(chainInput, out);
  } finally {
    await Bun.file(cutTmp)
      .delete()
      .catch(() => {});
  }
}

// Ordered: source → metadata gate the `ready` transition and must run first;
// presentation produces the file everything viewer-facing is cut from, so it
// precedes the variants, storyboard and captions. The source-group steps
// (thumbnail, peaks, editor storyboard, suggested edits) are independent of it
// and run last. The external (Mac-sent) steps never run here — they exist for UI
// applicability and tier classification only.
export const PROCESSING_STEPS: ProcessingStep[] = [
  {
    kind: "source",
    tier: "required",
    inputs: [],
    appliesTo: () => true,
    run: async (ctx) => {
      if (ctx.source === "uploaded") await generateSourceFromUpload(ctx.videoId, ctx.dir);
      else await generateSourceFromHls(ctx.videoId, ctx.dir);
      // A freshly stitched source IS pristine, by definition — the segments the
      // Mac uploaded have never been through the audio chain. This is what makes
      // "Rebuild from HLS" the recovery path for a video migrated from before the
      // restructure: re-stitching restores a true original, and the presentation
      // step then applies the chain to the master instead of finding it already
      // baked in.
      await setSourcePristine(ctx.videoId, true);
      ctx.video = { ...ctx.video, sourcePristine: true };
      return "ready";
    },
    validate: (ctx) =>
      isProbablyPlayable(sourceOutputPath(ctx), { expectedDuration: ctx.expectedSourceDuration }),
    artifact: (ctx) => sourceOutputPath(ctx),
  },
  {
    kind: "metadata",
    tier: "required",
    inputs: ["source"],
    appliesTo: () => true,
    run: async (ctx) => {
      const ok = await extractMetadata(ctx.videoId, {
        sourceFile: ctx.sourceFile,
        preProbed: ctx.scratch.sourceMeta,
      });
      if (!ok) throw new Error("ffprobe metadata extraction failed");
      return "ready";
    },
  },
  {
    // The served file. Always produced, for every video — that uniformity is what
    // lets source.mp4 stay pristine, makes "reprocess with a better audio chain"
    // possible years later, and gives watermarking somewhere to live.
    kind: "presentation",
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.height > 0,
    run: async (ctx) => {
      await buildPresentation(ctx);
      const probe = await probeMetadata(presentationPath(ctx));
      if (!probe) throw new Error("presentation: cannot probe the produced master");
      ctx.presentationDuration = probe.duration;
      await setPresentationMetadata(ctx.videoId, probe);
      return "ready";
    },
    // Validated against the EDL's kept-segment sum, NOT against a probe of the
    // file just written. Comparing a file to a measurement of itself can only
    // ever pass, which meant a truncated render — ten seconds where the EDL said
    // fifty — would validate, land, and serve.
    validate: (ctx) =>
      isProbablyPlayable(presentationPath(ctx), {
        expectedDuration: ctx.scratch.expectedPresentationDuration,
      }),
    artifact: (ctx) => presentationPath(ctx),
  },
  // Downscaled variants, generated from the canonical VARIANTS list (highest
  // first) so heights/kinds stay in sync with derivatives.ts and resolve.ts.
  ...VARIANTS.map((v) => variantStep(v.kind, v.height)),
  {
    kind: "storyboard",
    tier: "expected",
    inputs: ["presentation"],
    // Every video gets one — see computeStoryboardParams. The height gate is
    // just "the master exists to cut it from".
    appliesTo: (ctx) => ctx.height > 0,
    run: async (ctx) =>
      (await generateStoryboard(ctx.dir, ctx.presentationDuration, presentationPath(ctx)))
        ? "ready"
        : "skipped",
    validate: (ctx) => Bun.file(join(ctx.dir, "storyboard.vtt")).exists(),
    artifact: (ctx) => join(ctx.dir, "storyboard.vtt"),
  },
  {
    // The Mac's transcript mapped onto the presentation timeline — a verbatim
    // copy when nothing is cut, re-derived from words.json when something is.
    kind: "captions",
    tier: "expected",
    inputs: ["presentation", "transcript"],
    // Only recordings get a transcript (the Mac sends it), so an upload has
    // nothing to map onto its timeline and shows "—" rather than a permanent ❌.
    appliesTo: (ctx) => ctx.source === "recorded",
    run: async (ctx) => {
      const { kept, fullSpan } = await keptSegmentsFor(ctx.inputDir, ctx.sourceDuration);
      const result = await buildServedCaptions({
        inputDir: ctx.inputDir,
        outDir: ctx.dir,
        kept: ctx.scratch.kept ?? kept,
        fullSpan: ctx.scratch.fullSpan ?? fullSpan,
      });
      if (result.state === "skipped") return "skipped";
      await upsertTranscript(ctx.videoId, result.format, result.plainText);
      return "ready";
    },
    validate: async (ctx) =>
      (await Bun.file(join(ctx.dir, "captions.srt")).exists()) ||
      Bun.file(join(ctx.dir, "captions.vtt")).exists(),
    artifact: (ctx) => join(ctx.dir, "captions.srt"),
  },
  {
    // Source group: the thumbnail is a frame of the original, and deliberately
    // does NOT re-run when the presentation is rebuilt. Regenerating it wipes
    // thumbnail-candidates/ — including custom covers — so tying it to routine
    // reprocessing would destroy curation the first time the library is
    // reprocessed in bulk.
    kind: "thumbnail",
    tier: "expected",
    inputs: ["source"],
    appliesTo: () => true,
    run: async (ctx) => {
      await extractAndPromoteThumbnails(ctx.dir, ctx.sourceDuration, ctx.sourceFile);
      return "ready";
    },
    validate: (ctx) => Bun.file(join(ctx.dir, "thumbnail.jpg")).exists(),
    artifact: (ctx) => join(ctx.dir, "thumbnail.jpg"),
  },
  {
    kind: "peaks",
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.sourceDuration >= 1,
    run: async (ctx) =>
      (await generatePeaks(ctx.dir, ctx.sourceDuration, ctx.sourceFile)) ? "ready" : "skipped",
    validate: (ctx) => jsonParses(join(ctx.dir, "peaks.json")),
    artifact: (ctx) => join(ctx.dir, "peaks.json"),
  },
  {
    // Dense frames for the editor's timeline. Source-group, like everything else
    // the editor reads.
    kind: "editor_storyboard",
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.sourceDuration >= EDITOR_MIN_DURATION,
    run: async (ctx) =>
      (await generateEditorStoryboard(ctx.dir, ctx.sourceDuration, ctx.sourceFile))
        ? "ready"
        : "skipped",
    validate: (ctx) => Bun.file(join(ctx.dir, "editor-storyboard.vtt")).exists(),
    artifact: (ctx) => join(ctx.dir, "editor-storyboard.vtt"),
  },
  {
    kind: "suggested_edits",
    tier: "expected",
    inputs: ["source"],
    // Once the user has committed an edit we never surface auto-suggestions again.
    appliesTo: (ctx) => ctx.sourceDuration >= 5 && !ctx.video.lastEditedAt,
    run: async (ctx) => {
      const silences = await ensureSilences(ctx);
      const generated = await generateSuggestedEdits(ctx.dir, ctx.sourceDuration, {
        silences,
        inputPath: ctx.sourceFile,
      });
      return generated ? "ready" : "skipped";
    },
    validate: (ctx) => jsonParses(join(ctx.dir, "suggested-edits.json")),
    artifact: (ctx) => join(ctx.dir, "suggested-edits.json"),
  },
  // External / Mac-sent steps. Never run by the pipeline; rows are written by
  // the API route handlers that receive them. They apply only to recorded
  // videos — uploads never produce them, so they show as "—".
  externalStep("transcript"),
  externalStep("words"),
  externalStep("title_suggestion"),
  externalStep("description_suggestion"),
  {
    // Only expect Mac-sent suggested chapter titles when the recording actually
    // captured chapter markers — those are what trigger the Mac's suggestion
    // pass. Chapters a user adds later in the editor (createdDuringRecording =
    // false) don't count, so a marker-less recording shows "—", not ❌.
    kind: "chapter_titles",
    tier: "external",
    inputs: [],
    appliesTo: (ctx) => ctx.source === "recorded" && ctx.hasRecordedChapters === true,
  },
];

function externalStep(kind: ProcessingStepKind): ProcessingStep {
  return {
    kind,
    tier: "external",
    inputs: [],
    appliesTo: (ctx) => ctx.source === "recorded",
  };
}

// Steps the server pipeline actually runs, in order.
export const RUNNABLE_STEPS = PROCESSING_STEPS.filter((s) => s.run);

// The mandatory subset that gates `processing → ready`. Deliberately NOT
// including `presentation`: a video is `ready` once its footage is whole and
// probed, so it publishes immediately and serves HLS while the master is still
// being produced. MP4 serving is gated separately, on the presentation step.
export const REQUIRED_KINDS: ProcessingStepKind[] = PROCESSING_STEPS.filter(
  (s) => s.tier === "required",
).map((s) => s.kind);

// The presentation group: everything cut from the master, plus the master. This
// is the force set for a `present` run, and the closure that a change to the
// audio chain, the EDL or (later) the watermark invalidates.
export const PRESENTATION_KINDS: ProcessingStepKind[] = [
  "presentation",
  ...VARIANTS.map((v) => v.kind),
  "storyboard",
  "captions",
];

// Steps that can be regenerated standalone — they read an existing input and
// write their result atomically (a tmp→rename file, or a single videos-row
// UPDATE), so a single-artifact regenerate is inherently atomic. Deliberately
// EXCLUDES the two steps that have dependents:
//   - `source`: re-stitching needs the HLS segments (or upload.mp4), and
//     everything else derives from it — that's a full `intake` run.
//   - `presentation`: the variants, storyboard and captions are cut from it, so
//     regenerating it alone would leave them describing the previous master.
//     Rebuilding the presentation is the `present` intent, which redoes the set.
export const REGENERABLE_KINDS = new Set<ProcessingStepKind>(
  RUNNABLE_STEPS.filter((s) => s.kind !== "source" && s.kind !== "presentation").map((s) => s.kind),
);

export function stepByKind(kind: ProcessingStepKind): ProcessingStep | undefined {
  return PROCESSING_STEPS.find((s) => s.kind === kind);
}

// The central "is this step's output servable right now?" predicate: its ledger
// row is `ready` AND (for file-producing steps) the artifact is still present on
// disk. This is the load-bearing invariant of the "ledger is a receipt, not an
// inventory" design — a `ready` row alone never authorises serving; the disk
// stat is what catches a hand-deleted, never-swapped-in, or cleaned-up file so
// the viewer falls back gracefully instead of serving a phantom. It was inlined
// in ~5 places (pipeline input/skip checks, the readiness UI, viewer serving,
// stale-file cleanup); each copy was a place to forget the disk check and
// reintroduce the phantom-file bug, so it lives here once. `row` is passed in
// (rather than fetched) so callers with a preloaded step map don't re-scan.
export async function isServable(
  step: ProcessingStep,
  ctx: StepContext,
  row: VideoProcessingStep | undefined,
): Promise<boolean> {
  if (row?.state !== "ready") return false;
  const path = step.artifact?.(ctx);
  if (path && !(await Bun.file(path).exists())) return false;
  return true;
}

// Builds a StepContext from a stored video row, for applicability/artifact
// checks outside a live pipeline run (readiness UI, backfill, serving, cleanup).
// height/duration come from the cached metadata; the run-only fields are inert.
export function applicabilityContext(
  video: Video,
  opts: { hasRecordedChapters?: boolean; expectedSourceDuration?: number } = {},
): StepContext {
  const dir = derivativesDir(video.id);
  // durationSeconds describes the presentation master. Outside a run there's no
  // separate record of the source's own length, and nothing that consults this
  // context needs one — applicability for the source-group steps is stable once
  // they've been produced.
  const duration = video.durationSeconds ?? 0;
  return {
    videoId: video.id,
    video,
    source: video.source,
    dir,
    inputDir: dir,
    sourceFile: join(dir, "source.mp4"),
    sourceDuration: duration,
    expectedSourceDuration: opts.expectedSourceDuration,
    presentationDuration: duration,
    height: video.height ?? 0,
    hasRecordedChapters: opts.hasRecordedChapters,
    scratch: { silencesComputed: true },
  };
}
