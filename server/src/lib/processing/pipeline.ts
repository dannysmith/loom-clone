// The post-processing pipeline orchestrator. Drives the step registry in order,
// writing a video_processing_steps row + an event per step and calling
// reconcile() after each so `ready` is reached the moment the mandatory steps
// (source + metadata) validate — independent of the slow, fragile audio/variant
// steps that follow.
//
// Re-entrant by construction: each step is a no-op when its row is already
// `ready`/`skipped` and (for file-producing steps) the artifact is still on
// disk — unless `force` is set. So re-running the pipeline IS "resume from where
// it failed", which is what the manual reprocess button relies on.

import { eq } from "drizzle-orm";
import { mkdir, readdir, rename, rm } from "fs/promises";
import { basename, join } from "path";
import { getDb } from "../../db/client";
import { type ProcessingStepKind, videos } from "../../db/schema";
import { purgeVideo } from "../cdn";
import { derivativesDir, probeMetadata } from "../derivatives";
import { deriveEditedCaptions } from "../edit-render";
import { logEvent } from "../events";
import { nowIso } from "../format";
import { DATA_DIR, getVideo, setVideoStatus, upsertTranscript } from "../store";
import { generateEditorStoryboard } from "../storyboard";
import { reconcile } from "./reconcile";
import {
  type ProcessingStep,
  REQUIRED_KINDS,
  RUNNABLE_STEPS,
  type StepContext,
  type StepRunResult,
  stepByKind,
} from "./registry";
import { clearRunActive, markRunActive } from "./run-lock";
import {
  fileSizeBytes,
  getStep,
  markStepFailed,
  markStepReady,
  markStepSkipped,
} from "./steps-store";

// Collapses repeated schedule calls while a generation is in flight to the same
// promise, preventing two pipelines from racing on one video. The durable
// dedupe is the step table itself (skip-if-ready); this map just avoids
// redundant concurrent work within a single process lifetime.
const inFlight = new Map<string, Promise<void>>();

// A force/only run requested while one is in flight is DEFERRED here (not
// dropped) and fired once the current run settles. A forced run does work the
// in-flight resumable run won't (re-stitch source, regenerate variants), so
// silently dropping it would, e.g., lose a heal's required re-stitch. Last
// meaningful request wins, but a queued full rebuild is never downgraded to a
// single-artifact regenerate.
const pendingRerun = new Map<string, RunOpts>();

export type ScheduleOutcome = "started" | "queued" | "skipped";

export function scheduleDerivatives(videoId: string): void {
  schedule(videoId, { source: "recorded" });
}

export function scheduleUploadDerivatives(videoId: string): void {
  schedule(videoId, { source: "uploaded" });
}

// Fire-and-forget an edit commit: applies the saved EDL as an `edit`-mode run.
// The editor route gates this on `ready` + no in-flight run, so it never races.
export function scheduleEdit(videoId: string, source: "recorded" | "uploaded"): ScheduleOutcome {
  return schedule(videoId, { source, mode: "edit" });
}

// Fire-and-forget a manual reprocess: a forced full rebuild (force, no `only`)
// or a single-artifact regenerate (`only`). Returns whether the run started now
// or was queued behind an in-flight run, so the admin route can tell the user.
export function scheduleReprocess(
  videoId: string,
  opts: { source: "recorded" | "uploaded"; force?: boolean; only?: ProcessingStepKind },
): ScheduleOutcome {
  return schedule(videoId, opts);
}

function schedule(videoId: string, opts: RunOpts): ScheduleOutcome {
  if (inFlight.has(videoId)) {
    // A plain resumable re-schedule is already covered by the in-flight run. A
    // forced rebuild, single-artifact regen, or edit does work the resumable run
    // won't, so it's deferred (below) rather than dropped.
    if (!opts.force && !opts.only && opts.mode !== "edit") {
      console.log(
        `[pipeline] ${videoId} schedule skipped — already in flight (n=${inFlight.size})`,
      );
      return "skipped";
    }
    // Defer the forced/only run; don't downgrade a queued full rebuild to a
    // single-artifact regenerate.
    const existing = pendingRerun.get(videoId);
    const downgrade = existing?.force && !existing.only && !!opts.only && !opts.force;
    if (!downgrade) pendingRerun.set(videoId, opts);
    console.log(
      `[pipeline] ${videoId} run queued behind in-flight run (force=${opts.force ?? false}, only=${opts.only ?? "—"})`,
    );
    return "queued";
  }
  const p = runPipeline(videoId, opts).finally(() => {
    inFlight.delete(videoId);
    clearRunActive(videoId);
    // Fire the deferred run, if any, now the slot is free. It re-marks the lock
    // synchronously (no await between here and there), so a queued rerun never
    // leaves an observable gap in which the editor gate could open.
    const next = pendingRerun.get(videoId);
    if (next) {
      pendingRerun.delete(videoId);
      schedule(videoId, next);
    }
  });
  inFlight.set(videoId, p);
  markRunActive(videoId);
  console.log(
    `[pipeline] ${videoId} scheduled (source=${opts.source}, force=${opts.force ?? false}, only=${opts.only ?? "—"}, n=${inFlight.size})`,
  );
  p.catch((err) => console.error(`[pipeline] ${videoId} unexpected failure:`, err));
  return "started";
}

// Test-only: await the in-flight pipeline for a video.
export function _inFlightPromise(videoId: string): Promise<void> | undefined {
  return inFlight.get(videoId);
}

// Test-only: await every in-flight pipeline (looping so a coalesced rerun that
// starts as the current run settles is also awaited). Called from
// teardownTestEnv so a fire-and-forget run scheduled by a test (e.g. via
// /complete) can't outlive the test and race its DB/temp-dir teardown.
export async function _drainInFlight(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight.values()]);
  }
}

// `only` restricts the run to a single step (a per-artifact regenerate);
// `force` re-runs steps even when already ready (manual reprocess); `mode`
// `edit` applies the saved EDL instead of (re)producing source.mp4.
type RunOpts = {
  source: "recorded" | "uploaded";
  force?: boolean;
  only?: ProcessingStepKind;
  mode?: "build" | "edit";
};

export async function runPipeline(videoId: string, opts: RunOpts): Promise<void> {
  let video = await getVideo(videoId, { includeTrashed: true });
  if (!video) return;

  const mode: "build" | "edit" = opts.mode ?? "build";

  // Reprocess chokepoint: a BUILD reprocess of an edited video washes the edit
  // away first and rebuilds a consistent UNEDITED video from source.mp4 (the
  // build steps consume source.mp4, not the edited cut). An edit run skips this —
  // it re-applies the new EDL to the preserved source.mp4. Per-artifact `only`
  // regens are rejected for edited videos at the route. (Dynamic import avoids an
  // import cycle: edit-reset pulls in store, which pulls in this module.)
  if (!opts.only && mode !== "edit" && video.lastEditedAt) {
    const { resetAllEdits } = await import("../edit-reset");
    await resetAllEdits(videoId);
    const reloaded = await getVideo(videoId, { includeTrashed: true });
    if (reloaded) video = reloaded;
  }

  if (mode === "edit" && !video.height) {
    console.error(`[pipeline] ${videoId} edit run aborted — no cached height`);
    return;
  }

  const dir = derivativesDir(videoId);
  await mkdir(dir, { recursive: true });

  const ctx: StepContext = {
    videoId,
    video,
    source: opts.source,
    mode,
    dir,
    // The active served file: source.mp4 for a build, the resolution-named EDL
    // cut for an edit (source.mp4 is preserved as the original).
    activeFile: mode === "edit" ? join(dir, `${video.height}p.mp4`) : join(dir, "source.mp4"),
    duration: video.durationSeconds ?? 0,
    height: video.height ?? 0,
    force: opts.force ?? false,
    scratch: { silencesComputed: false },
  };

  // An edit run publishes `reprocessing` while it works — source.mp4 is preserved
  // and the pre-edit set keeps serving (lastEditedAt is still unset, so serving
  // resolves to source.mp4). It restores `ready` on failure.
  if (mode === "edit") await setVideoStatus(videoId, "reprocessing");

  const started = Date.now();
  const produced: string[] = [];

  // Stage→validate→swap for runs that replace an already-served set: every edit,
  // and a forced rebuild of a `ready` video. The previous outputs keep serving
  // until the swap, and a failed run leaves them (and the ledger) untouched.
  // Everything else writes in place: the first build, a heal re-stitch (status
  // `healing`, still serving HLS — a failed stitch should surface as a failed
  // `source`), a resumable run, and single-artifact `only` regenerates are
  // additive or non-destructive (each step is atomic tmp→rename).
  const staged =
    !opts.only && (mode === "edit" || ((opts.force ?? false) && video.status === "ready"));
  if (staged) {
    try {
      await runStepsStaged(videoId, ctx, produced);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] ${videoId} staged ${mode} failed (previous outputs kept):`, msg);
      await logStep(videoId, "source", "failed", `staged ${mode}: ${msg}`);
      // An edit set `reprocessing` up front; restore the pre-edit `ready` (its
      // outputs are untouched). A forced rebuild was already `ready`.
      if (mode === "edit") await setVideoStatus(videoId, "ready");
      return;
    }
  } else {
    await runStepsInPlace(videoId, ctx, opts, produced);
  }

  if (mode === "edit") {
    // Edit-specific finalisation — only after a validated swap.
    await finalizeEdit(videoId, ctx);
  } else if (!opts.only) {
    // Editor storyboard: dense frames for the editing timeline. Not part of the
    // public checklist (no step row), regenerated only from the original source.
    if (ctx.duration >= 5) {
      try {
        await generateEditorStoryboard(dir, ctx.duration);
      } catch (err) {
        console.error(
          `[pipeline] ${videoId} editor storyboard failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // For uploads, upload.mp4 produced source.mp4 — drop it once source +
    // metadata are confirmed so we never keep two copies (and never delete the
    // only copy of a still-unprocessed upload).
    if (opts.source === "uploaded") await maybeDeleteUpload(videoId);
  }

  await reconcile(videoId, { running: false });

  const totalMs = Date.now() - started;
  console.log(`[pipeline] ${videoId} done (${totalMs}ms, produced=[${produced.join(", ")}])`);
  // Final summary event for the activity feed (additive — per-step events above
  // are the durable record). Tolerate a missing DB in tests.
  try {
    await logEvent(videoId, "processing_complete", { produced, durationMs: totalMs });
  } catch {
    // DB may be gone in tests — don't let event logging crash the pipeline.
  }
}

// In-place run: first build / heal / resumable / single-artifact regenerate.
// Each step writes atomically (tmp→rename) into the real derivatives dir, and we
// reconcile after each mandatory step so the video reaches `ready` the moment
// source + metadata validate — independent of the slower expected steps.
async function runStepsInPlace(
  videoId: string,
  ctx: StepContext,
  opts: RunOpts,
  produced: string[],
): Promise<void> {
  const heightState = { probed: false };

  for (const step of RUNNABLE_STEPS) {
    if (opts.only && step.kind !== opts.only) continue;

    // Probe the active file's height once it exists, so resolution-gated steps
    // (variants) see the real value even on a fresh run where video.height was
    // still null.
    if (!heightState.probed && ctx.height === 0) {
      if (await Bun.file(ctx.activeFile).exists()) {
        heightState.probed = true;
        const meta = await probeMetadata(ctx.activeFile);
        if (meta) {
          ctx.height = meta.height;
          // Reused by the metadata step (extractMetadata) so the active file is
          // probed once per run, not twice.
          ctx.scratch.sourceMeta = meta;
        }
      }
    }

    if (!step.appliesTo(ctx)) continue;
    if (!(await inputsSatisfied(videoId, step, ctx))) continue;

    // reconcile only reads the mandatory (source/metadata) step states, so a
    // reconcile after a non-mandatory step can't change the status — run it only
    // after the mandatory ones (reaching `ready` the moment they validate) plus
    // the final settle.
    const reconcileNow = REQUIRED_KINDS.includes(step.kind);

    // Skip-if-ready resumability.
    if (!ctx.force && (await isAlreadyDone(videoId, step, ctx))) {
      produced.push(`${step.kind}*`);
      if (reconcileNow) await reconcile(videoId, { running: true });
      continue;
    }

    await runStep(videoId, step, ctx, produced);
    if (reconcileNow) await reconcile(videoId, { running: true });
  }
}

// Staged run: regenerate the served set atomically. Every applicable step
// produces + validates into a staging dir; ANY failure throws and aborts the
// whole run (leaving the previous outputs, ledger, and status untouched — a
// failed rebuild can't demote a working video). Only once the full set is built
// do we swap it into place and mark the ledger — so there's never a window where
// a freshly-regenerated file sits beside a stale one. Status is withheld until
// the caller's final reconcile.
async function runStepsStaged(
  videoId: string,
  ctx: StepContext,
  produced: string[],
): Promise<void> {
  const realDir = ctx.dir;
  const stagingDir = join(realDir, ".staging");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  // Outputs go to staging; the active file lives there too. Inputs are read from
  // their real locations (a precondition like source.mp4, or — for a from-HLS
  // rebuild — the freshly staged source, which is still present in realDir as
  // the old copy until the swap), so input checks use the real-dir `ctx`.
  const stagedCtx: StepContext = {
    ...ctx,
    dir: stagingDir,
    activeFile: join(stagingDir, basename(ctx.activeFile)),
  };
  const heightState = { probed: false };
  const outcomes: Array<{ step: ProcessingStep; result: StepRunResult }> = [];

  try {
    for (const step of RUNNABLE_STEPS) {
      if (!heightState.probed && stagedCtx.height === 0) {
        if (await Bun.file(stagedCtx.activeFile).exists()) {
          heightState.probed = true;
          const meta = await probeMetadata(stagedCtx.activeFile);
          if (meta) {
            stagedCtx.height = meta.height;
            stagedCtx.scratch.sourceMeta = meta;
          }
        }
      }

      if (!step.appliesTo(stagedCtx)) continue;
      if (!(await inputsSatisfied(videoId, step, ctx))) continue;

      const result = await step.run!(stagedCtx);
      if (result !== "skipped") {
        const valid = step.validate ? await step.validate(stagedCtx) : true;
        if (!valid) throw new Error(`staged ${step.kind} produced an invalid artifact`);
      }
      outcomes.push({ step, result });
    }

    // Swap the validated set into place. Per-file renames within the same
    // filesystem (staging is a subdir of the derivatives dir) are atomic. Files
    // the run didn't regenerate (e.g. an edit leaves the thumbnail/peaks) stay
    // in realDir untouched.
    const stagedFiles = (await readdir(stagingDir)).filter((f) => !f.endsWith(".tmp"));
    for (const f of stagedFiles) await rename(join(stagingDir, f), join(realDir, f));
    console.log(`[pipeline] ${videoId} swapped ${stagedFiles.length} staged output(s)`);

    // Mark the ledger now the files are in their real home (artifact paths
    // resolve against the real-dir `ctx`).
    for (const { step, result } of outcomes) {
      await markStagedStep(videoId, step, ctx, result, produced);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Ledger marking for a staged step, post-swap. Mirrors finishReady/runStep's
// "skipped but artifact present is really ready" rule.
async function markStagedStep(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
  result: StepRunResult,
  produced: string[],
): Promise<void> {
  const path = step.artifact?.(ctx);
  if (result === "skipped" && !(path && (await Bun.file(path).exists()))) {
    await markStepSkipped(videoId, step.kind);
    await logStep(videoId, step.kind, "skipped");
    return;
  }
  await markStepReady(videoId, step.kind, { sizeBytes: path ? fileSizeBytes(path) : null });
  await logStep(videoId, step.kind, "ready");
  produced.push(step.kind);
}

async function runStep(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
  produced: string[],
): Promise<void> {
  const stepStarted = Date.now();
  try {
    const result = await step.run!(ctx);

    if (result === "skipped") {
      // A "skipped" step whose artifact nonetheless exists is really ready
      // (e.g. suggested-edits found on disk from a prior run).
      const path = step.artifact?.(ctx);
      if (path && (await Bun.file(path).exists())) {
        await finishReady(videoId, step, ctx, produced);
      } else {
        await markStepSkipped(videoId, step.kind);
        await logStep(videoId, step.kind, "skipped");
      }
      return;
    }

    const valid = step.validate ? await step.validate(ctx) : true;
    if (!valid) {
      await markStepFailed(videoId, step.kind, "validation failed");
      await logStep(videoId, step.kind, "failed", "validation failed");
      console.error(`[pipeline] ${videoId}/${step.kind} produced an invalid artifact`);
      return;
    }

    await finishReady(videoId, step, ctx, produced);
    console.log(`[pipeline] ${videoId}/${step.kind} (${Date.now() - stepStarted}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markStepFailed(videoId, step.kind, msg);
    await logStep(videoId, step.kind, "failed", msg);
    console.error(`[pipeline] ${videoId}/${step.kind} failed:`, msg);
  }
}

async function finishReady(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
  produced: string[],
): Promise<void> {
  const path = step.artifact?.(ctx);
  const sizeBytes = path ? fileSizeBytes(path) : null;
  await markStepReady(videoId, step.kind, { sizeBytes });
  await logStep(videoId, step.kind, "ready");
  produced.push(step.kind);
}

// All declared inputs must be `ready` AND (for file-producing inputs) present
// on disk before a step can run. A missing input leaves this step untouched.
async function inputsSatisfied(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
): Promise<boolean> {
  for (const inputKind of step.inputs) {
    const row = await getStep(videoId, inputKind);
    if (row?.state !== "ready") return false;
    const path = stepByKind(inputKind)?.artifact?.(ctx);
    if (path && !(await Bun.file(path).exists())) return false;
  }
  return true;
}

// A step is "already done" when its row is ready/skipped and (for ready
// file-producing steps) the artifact is still on disk. Drives resumability.
async function isAlreadyDone(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
): Promise<boolean> {
  const row = await getStep(videoId, step.kind);
  if (!row) return false;
  if (row.state === "skipped") return true;
  if (row.state !== "ready") return false;
  const path = step.artifact?.(ctx);
  if (path && !(await Bun.file(path).exists())) return false;
  return true;
}

// Edit-specific finalisation, run after the validated staged swap: derive the
// edited captions, drop the now-stale viewer storyboard if the cut fell below
// the threshold, remove suggested-edits.json, and flip the video to edited
// (lastEditedAt + edited durationSeconds). Setting lastEditedAt last means
// serving only resolves to the {height}p.mp4 cut once it's in place and valid.
async function finalizeEdit(videoId: string, ctx: StepContext): Promise<void> {
  const dir = ctx.dir;
  const kept = ctx.scratch.keptSegments ?? [];
  const editedDuration = ctx.scratch.editedDuration ?? ctx.video.durationSeconds ?? 0;

  // Edited captions from the unchanged words.json + the kept segments.
  try {
    const editedPlainText = await deriveEditedCaptions(dir, dir, kept);
    if (editedPlainText) await upsertTranscript(videoId, "srt", editedPlainText);
  } catch (err) {
    console.error(
      `[pipeline] ${videoId} edited captions failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  // If the edited cut dropped below the storyboard threshold, the storyboard step
  // didn't run (so nothing was staged/swapped) — remove the old, longer one so
  // scrubbing doesn't reflect the un-edited timeline.
  if (editedDuration < 60) {
    await rm(join(dir, "storyboard.vtt"), { force: true }).catch(() => {});
    await markStepSkipped(videoId, "storyboard");
  }

  // Suggestions are a one-shot pre-first-edit helper; never re-surface post-edit.
  // Drop the file and settle its ledger row so it isn't a phantom `ready` (it's
  // masked as "—" for edited videos, but keep the ledger honest).
  await rm(join(dir, "suggested-edits.json"), { force: true }).catch(() => {});
  await markStepSkipped(videoId, "suggested_edits");

  try {
    await getDb()
      .update(videos)
      .set({ lastEditedAt: nowIso(), durationSeconds: editedDuration, updatedAt: nowIso() })
      .where(eq(videos.id, videoId));
  } catch (err) {
    // The staged swap already landed the edited {height}p.mp4, so a failure here
    // leaves the filesystem edited but the DB unedited (activeRawFilename still
    // resolves to source.mp4). Surface the mismatch loudly rather than swallow it.
    console.error(
      `[pipeline] ${videoId} edit flip FAILED after swap — files edited but lastEditedAt unset:`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }

  const video = await getVideo(videoId);
  if (video) purgeVideo(video.slug);
  try {
    await logEvent(videoId, "edits_committed", { editedDuration });
  } catch {
    // DB may be gone in tests.
  }
}

async function maybeDeleteUpload(videoId: string): Promise<void> {
  const [source, metadata] = await Promise.all([
    getStep(videoId, "source"),
    getStep(videoId, "metadata"),
  ]);
  if (source?.state !== "ready" || metadata?.state !== "ready") return;
  const uploadPath = join(DATA_DIR, videoId, "upload.mp4");
  if (!(await Bun.file(uploadPath).exists())) return;
  try {
    await rm(uploadPath, { force: true });
    console.log(`[pipeline] ${videoId} upload.mp4 deleted (source.mp4 confirmed)`);
  } catch (err) {
    console.error(
      `[pipeline] ${videoId} failed to delete upload.mp4:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function logStep(
  videoId: string,
  kind: string,
  state: string,
  error?: string,
): Promise<void> {
  try {
    await logEvent(videoId, "processing_step", error ? { kind, state, error } : { kind, state });
  } catch {
    // DB may be gone in tests.
  }
}
