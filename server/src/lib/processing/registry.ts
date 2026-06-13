// The post-processing step registry. Each step declares what it is (kind/tier),
// when it applies (appliesTo), what it depends on (inputs), how to produce it
// (run) and how to validate the result (validate). The pipeline (./pipeline.ts)
// drives these in order; reconcile and the admin readiness UI read the same
// metadata. Keeping it declarative is what makes per-step events, skip-if-ready
// resumability and dependency-aware regeneration fall out naturally.

import { join } from "path";
import type { ProcessingStepKind, Video, VideoProcessingStep } from "../../db/schema";
import {
  derivativesDir,
  extractMetadata,
  generateSourceFromHls,
  generateSourceFromUpload,
  generateVariant,
  type ProbeMetadata,
  probeDuration,
  processAudio,
  refreshFileBytes,
  VARIANTS,
} from "../derivatives";
import { type Edl, renderEditedOutput } from "../edit-render";
import { computeKeptSegments, type Segment } from "../edit-transcript";
import { generatePeaks } from "../peaks";
import { generateStoryboard } from "../storyboard";
import { generateSuggestedEdits, runSilenceDetect, type Silence } from "../suggested-edits";
import { extractAndPromoteThumbnails } from "../thumbnails";
import { activeRawFilename } from "../url";
import { isProbablyPlayable } from "./playable";

export type StepTier = "required" | "expected" | "external";
export type StepRunResult = "ready" | "skipped";

// Per-run context shared by every step. `height` is 0 until the metadata step
// has probed source.mp4; steps gated on resolution must run after metadata.
export type StepContext = {
  videoId: string;
  video: Video;
  source: "recorded" | "uploaded";
  // Run mode. `build` produces/replaces source.mp4 (first build, heal re-stitch,
  // forced from-HLS rebuild). `edit` applies an EDL, producing the edited cut as
  // the active file while leaving source.mp4 untouched. Gates which steps run:
  // source/audio/thumbnail/peaks/suggested_edits are build-only; edited_output is
  // edit-only. Defaults to `build` everywhere except an edit run.
  mode: "build" | "edit";
  dir: string; // derivatives directory
  // Absolute path to the "active" playable file that downstream steps (variants,
  // storyboard, metadata) consume. Defaults to source.mp4; in edit mode it
  // becomes the EDL-cut {height}p.mp4. source.mp4-specific steps (source, audio,
  // silence detection) stay on sourcePath() regardless.
  activeFile: string;
  duration: number; // seconds
  height: number; // probed source height (0 before metadata)
  // Whether the recording captured chapter markers — gates chapter_titles
  // applicability. Only set when the context is built for readiness/backfill (the
  // live pipeline never evaluates the external chapter_titles step).
  hasRecordedChapters?: boolean;
  force: boolean;
  scratch: {
    silences?: Silence[];
    silencesComputed: boolean;
    // source.mp4 probe, seeded by the pipeline's height probe and reused by the
    // metadata step so source.mp4 is probed once per run, not twice.
    sourceMeta?: ProbeMetadata;
    // Set by the edited_output step during an edit run, for the post-swap edit
    // actions (edited captions, durationSeconds).
    keptSegments?: Segment[];
    editedDuration?: number;
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
  // check. Absent for steps that produce no file (metadata) or mutate
  // source.mp4 in place (audio).
  artifact?(ctx: StepContext): string;
};

const sourcePath = (ctx: StepContext): string => join(ctx.dir, "source.mp4");

// One downscaled-variant step (e.g. 720p.mp4), built from the canonical
// VARIANTS entry so the height threshold, filename and kind never drift.
function variantStep(kind: ProcessingStepKind, height: number): ProcessingStep {
  const file = `${height}p.mp4`;
  return {
    kind,
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.height > height,
    run: async (ctx) => {
      await generateVariant(ctx.dir, height, ctx.activeFile);
      return "ready";
    },
    validate: (ctx) => isProbablyPlayable(join(ctx.dir, file)),
    artifact: (ctx) => join(ctx.dir, file),
  };
}

// Expected duration for validating source.mp4 (the ORIGINAL recording).
// durationSeconds describes the *edited* output for edited videos, not the
// (longer) source.mp4 — so duration-check only unedited videos; for edited ones
// a structural check is enough to confirm the original is still playable.
export function sourceExpectedDuration(ctx: StepContext): number | undefined {
  return ctx.video.lastEditedAt ? undefined : ctx.duration;
}

// Silence detection runs once per pipeline, on the RAW source BEFORE loudnorm
// (post-loudnorm the dynamic range is compressed and silence is
// indistinguishable from quiet speech). Both the audio step and suggested_edits
// reuse the result. The audio step calls this first, guaranteeing the silences
// reflect the un-loudnormed source.
async function ensureSilences(ctx: StepContext): Promise<Silence[] | undefined> {
  if (ctx.scratch.silencesComputed) return ctx.scratch.silences;
  ctx.scratch.silencesComputed = true;
  if (ctx.duration >= 5) {
    try {
      ctx.scratch.silences = await runSilenceDetect(sourcePath(ctx), ctx.duration);
    } catch (err) {
      console.error(
        `[pipeline] ${ctx.videoId} pre-loudnorm silence detection failed:`,
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

// Ordered: source → metadata gate the `ready` transition and must run first;
// audio runs before the variants so they're cut from the loudnormed source;
// suggested_edits runs after audio but reuses the pre-loudnorm silences. The
// external (Mac-sent) steps never run here — they exist for UI applicability
// and tier classification only.
export const PROCESSING_STEPS: ProcessingStep[] = [
  {
    kind: "source",
    tier: "required",
    inputs: [],
    // Edit runs don't re-produce source.mp4 — it's the preserved original and a
    // precondition of the EDL apply. (In readiness/backfill, mode is `build`, so
    // source still shows for edited videos — its row stays ready.)
    appliesTo: (ctx) => ctx.mode !== "edit",
    run: async (ctx) => {
      if (ctx.source === "uploaded") await generateSourceFromUpload(ctx.videoId, ctx.dir);
      else await generateSourceFromHls(ctx.videoId, ctx.dir);
      return "ready";
    },
    validate: (ctx) =>
      isProbablyPlayable(sourcePath(ctx), { expectedDuration: sourceExpectedDuration(ctx) }),
    artifact: (ctx) => sourcePath(ctx),
  },
  {
    // The EDL-cut active file for an edited video ({height}p.mp4), produced from
    // the preserved source.mp4. Runs only on an edit; in readiness/backfill
    // (mode `build`) it shows for an already-edited video so the served cut is a
    // first-class, validated checklist item. Not in REQUIRED_KINDS — `lastEditedAt`
    // is set only after a validated swap, so a video that presents as edited
    // already has a valid edited_output.
    kind: "edited_output",
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.mode === "edit" || ctx.video.lastEditedAt != null,
    run: async (ctx) => {
      const realDir = derivativesDir(ctx.videoId);
      const edlFile = Bun.file(join(realDir, "edits.json"));
      if (!(await edlFile.exists())) throw new Error("edited_output: no edits.json to apply");
      const edl = (await edlFile.json()) as Edl;
      const realSource = join(realDir, "source.mp4");
      const sourceDuration = await probeDuration(realSource);
      if (sourceDuration === null) throw new Error("edited_output: cannot probe source.mp4");
      const kept = computeKeptSegments(edl.edits, sourceDuration);
      if (kept.length === 0) throw new Error("edited_output: all content removed by edits");
      await renderEditedOutput(realSource, ctx.activeFile, kept);
      const editedDuration = (await probeDuration(ctx.activeFile)) ?? sourceDuration;
      ctx.duration = editedDuration; // the storyboard threshold reads ctx.duration
      ctx.scratch.keptSegments = kept;
      ctx.scratch.editedDuration = editedDuration;
      return "ready";
    },
    validate: (ctx) =>
      isProbablyPlayable(ctx.activeFile, { expectedDuration: ctx.scratch.editedDuration }),
    artifact: (ctx) => ctx.activeFile,
  },
  {
    kind: "metadata",
    tier: "required",
    inputs: ["source"],
    appliesTo: () => true,
    run: async (ctx) => {
      const ok = await extractMetadata(ctx.videoId, {
        activeFile: ctx.activeFile,
        preProbed: ctx.scratch.sourceMeta,
      });
      if (!ok) throw new Error("ffprobe metadata extraction failed");
      return "ready";
    },
  },
  {
    kind: "audio",
    tier: "expected",
    inputs: ["source"],
    // Uploads aren't mic recordings — loudnorm/denoise shouldn't run on them.
    // Edit runs cut from the already-loudnormed source.mp4, so audio never
    // re-runs (and never touches the preserved source.mp4) in edit mode.
    appliesTo: (ctx) => ctx.source === "recorded" && ctx.mode !== "edit",
    run: async (ctx) => {
      const silences = await ensureSilences(ctx);
      const processed = await processAudio(sourcePath(ctx), silences);
      if (processed) await refreshFileBytes(ctx.videoId);
      return processed ? "ready" : "skipped";
    },
  },
  {
    kind: "thumbnail",
    tier: "expected",
    inputs: ["source"],
    // The thumbnail comes from the original source.mp4 and is not regenerated on
    // edit (the editor works from source; the existing thumbnail stays valid).
    appliesTo: (ctx) => ctx.mode !== "edit",
    run: async (ctx) => {
      await extractAndPromoteThumbnails(ctx.dir, ctx.duration);
      return "ready";
    },
    validate: (ctx) => Bun.file(join(ctx.dir, "thumbnail.jpg")).exists(),
    artifact: (ctx) => join(ctx.dir, "thumbnail.jpg"),
  },
  // Downscaled variants, generated from the canonical VARIANTS list (highest
  // first) so heights/kinds stay in sync with derivatives.ts and resolve.ts.
  ...VARIANTS.map((v) => variantStep(v.kind, v.height)),
  {
    kind: "storyboard",
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.duration >= 60,
    run: async (ctx) =>
      (await generateStoryboard(ctx.dir, ctx.duration, ctx.activeFile)) ? "ready" : "skipped",
    validate: (ctx) => Bun.file(join(ctx.dir, "storyboard.vtt")).exists(),
    artifact: (ctx) => join(ctx.dir, "storyboard.vtt"),
  },
  {
    kind: "peaks",
    tier: "expected",
    inputs: ["source"],
    // Waveform peaks reflect the original source.mp4 (the editor timeline works
    // from source); not regenerated on edit.
    appliesTo: (ctx) => ctx.duration >= 1 && ctx.mode !== "edit",
    run: async (ctx) => ((await generatePeaks(ctx.dir, ctx.duration)) ? "ready" : "skipped"),
    validate: (ctx) => jsonParses(join(ctx.dir, "peaks.json")),
    artifact: (ctx) => join(ctx.dir, "peaks.json"),
  },
  {
    kind: "suggested_edits",
    tier: "expected",
    inputs: ["source"],
    // Once the user has committed an edit we never surface auto-suggestions
    // again. The `mode` guard also covers the in-flight edit run, where
    // lastEditedAt isn't set yet but suggestions still must not regenerate.
    appliesTo: (ctx) => ctx.duration >= 5 && !ctx.video.lastEditedAt && ctx.mode !== "edit",
    run: async (ctx) => {
      const silences = await ensureSilences(ctx);
      const generated = await generateSuggestedEdits(ctx.dir, ctx.duration, { silences });
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

// The mandatory subset that gates `processing → ready`.
export const REQUIRED_KINDS: ProcessingStepKind[] = PROCESSING_STEPS.filter(
  (s) => s.tier === "required",
).map((s) => s.kind);

// Steps that can be regenerated standalone from a valid source.mp4 — they read
// source.mp4 and write their result atomically: a tmp→rename file, or (metadata)
// a single videos-row UPDATE. So a single-artifact regenerate is inherently
// atomic. Deliberately EXCLUDES:
//   - `source`: re-stitching needs the HLS segments (or upload.mp4), so it's a
//     full from-HLS rebuild, not an in-place regenerate.
//   - `audio`: loudnorm replaces source.mp4 in place, so re-running it would
//     double-process; to redo audio you re-stitch source from HLS (full rebuild).
export const REGENERABLE_KINDS = new Set<ProcessingStepKind>([
  "metadata",
  "thumbnail",
  ...VARIANTS.map((v) => v.kind),
  "storyboard",
  "peaks",
  "suggested_edits",
]);

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
// checks outside a live pipeline run (readiness UI, backfill). height/duration
// come from the cached metadata; the run-only fields are inert here.
export function applicabilityContext(
  video: Video,
  opts: { hasRecordedChapters?: boolean } = {},
): StepContext {
  const dir = derivativesDir(video.id);
  return {
    videoId: video.id,
    video,
    source: video.source,
    mode: "build",
    dir,
    hasRecordedChapters: opts.hasRecordedChapters,
    // The active served file: source.mp4 for unedited videos, the {height}p.mp4
    // cut for edited ones — so edited_output's artifact resolves correctly in
    // readiness/backfill.
    activeFile: join(dir, activeRawFilename(video)),
    duration: video.durationSeconds ?? 0,
    height: video.height ?? 0,
    force: false,
    scratch: { silencesComputed: true },
  };
}
