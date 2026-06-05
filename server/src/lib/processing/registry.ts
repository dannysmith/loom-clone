// The post-processing step registry. Each step declares what it is (kind/tier),
// when it applies (appliesTo), what it depends on (inputs), how to produce it
// (run) and how to validate the result (validate). The pipeline (./pipeline.ts)
// drives these in order; reconcile and the admin readiness UI read the same
// metadata. Keeping it declarative is what makes per-step events, skip-if-ready
// resumability and dependency-aware regeneration fall out naturally.

import { join } from "path";
import type { ProcessingStepKind, Video } from "../../db/schema";
import {
  derivativesDir,
  extractMetadata,
  generateSourceFromHls,
  generateSourceFromUpload,
  generateVariant,
  processAudio,
  refreshFileBytes,
  VARIANTS,
} from "../derivatives";
import { generatePeaks } from "../peaks";
import { generateStoryboard } from "../storyboard";
import { generateSuggestedEdits, runSilenceDetect, type Silence } from "../suggested-edits";
import { extractAndPromoteThumbnails } from "../thumbnails";
import { isProbablyPlayable } from "./playable";

export type StepTier = "required" | "expected" | "external";
export type StepRunResult = "ready" | "skipped";

// Per-run context shared by every step. `height` is 0 until the metadata step
// has probed source.mp4; steps gated on resolution must run after metadata.
export type StepContext = {
  videoId: string;
  video: Video;
  source: "recorded" | "uploaded";
  dir: string; // derivatives directory
  duration: number; // seconds
  height: number; // probed source height (0 before metadata)
  force: boolean;
  scratch: { silences?: Silence[]; silencesComputed: boolean };
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
      await generateVariant(ctx.dir, height, sourcePath(ctx));
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
    appliesTo: () => true,
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
    kind: "metadata",
    tier: "required",
    inputs: ["source"],
    appliesTo: () => true,
    run: async (ctx) => {
      const ok = await extractMetadata(ctx.videoId);
      if (!ok) throw new Error("ffprobe metadata extraction failed");
      return "ready";
    },
  },
  {
    kind: "audio",
    tier: "expected",
    inputs: ["source"],
    // Uploads aren't mic recordings — loudnorm/denoise shouldn't run on them.
    appliesTo: (ctx) => ctx.source === "recorded",
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
    appliesTo: () => true,
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
    run: async (ctx) => ((await generateStoryboard(ctx.dir, ctx.duration)) ? "ready" : "skipped"),
    validate: (ctx) => Bun.file(join(ctx.dir, "storyboard.vtt")).exists(),
    artifact: (ctx) => join(ctx.dir, "storyboard.vtt"),
  },
  {
    kind: "peaks",
    tier: "expected",
    inputs: ["source"],
    appliesTo: (ctx) => ctx.duration >= 1,
    run: async (ctx) => ((await generatePeaks(ctx.dir, ctx.duration)) ? "ready" : "skipped"),
    validate: (ctx) => jsonParses(join(ctx.dir, "peaks.json")),
    artifact: (ctx) => join(ctx.dir, "peaks.json"),
  },
  {
    kind: "suggested_edits",
    tier: "expected",
    inputs: ["source"],
    // Once the user has committed an edit we never surface auto-suggestions again.
    appliesTo: (ctx) => ctx.duration >= 5 && !ctx.video.lastEditedAt,
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
  externalStep("chapter_titles"),
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
  "variant_1080",
  "variant_720",
  "storyboard",
  "peaks",
  "suggested_edits",
]);

export function stepByKind(kind: ProcessingStepKind): ProcessingStep | undefined {
  return PROCESSING_STEPS.find((s) => s.kind === kind);
}

// Builds a StepContext from a stored video row, for applicability/artifact
// checks outside a live pipeline run (readiness UI, backfill). height/duration
// come from the cached metadata; the run-only fields are inert here.
export function applicabilityContext(video: Video): StepContext {
  return {
    videoId: video.id,
    video,
    source: video.source,
    dir: derivativesDir(video.id),
    duration: video.durationSeconds ?? 0,
    height: video.height ?? 0,
    force: false,
    scratch: { silencesComputed: true },
  };
}
