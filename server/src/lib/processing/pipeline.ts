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

import { mkdir, rm } from "fs/promises";
import { join } from "path";
import type { ProcessingStepKind } from "../../db/schema";
import { derivativesDir, probeMetadata } from "../derivatives";
import { logEvent } from "../events";
import { DATA_DIR, getVideo } from "../store";
import { generateEditorStoryboard } from "../storyboard";
import { reconcile } from "./reconcile";
import { type ProcessingStep, RUNNABLE_STEPS, type StepContext, stepByKind } from "./registry";
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

export function scheduleDerivatives(videoId: string): void {
  schedule(videoId, { source: "recorded" });
}

export function scheduleUploadDerivatives(videoId: string): void {
  schedule(videoId, { source: "uploaded" });
}

// Fire-and-forget a manual reprocess: a forced full rebuild (force, no `only`)
// or a single-artifact regenerate (`only`). Collapses with any in-flight run.
export function scheduleReprocess(
  videoId: string,
  opts: { source: "recorded" | "uploaded"; force?: boolean; only?: ProcessingStepKind },
): void {
  schedule(videoId, opts);
}

function schedule(videoId: string, opts: RunOpts): void {
  if (inFlight.has(videoId)) {
    console.log(`[pipeline] ${videoId} schedule skipped — already in flight (n=${inFlight.size})`);
    return;
  }
  const p = runPipeline(videoId, opts).finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, p);
  console.log(
    `[pipeline] ${videoId} scheduled (source=${opts.source}, force=${opts.force ?? false}, only=${opts.only ?? "—"}, n=${inFlight.size})`,
  );
  p.catch((err) => console.error(`[pipeline] ${videoId} unexpected failure:`, err));
}

// Test-only: await the in-flight pipeline for a video.
export function _inFlightPromise(videoId: string): Promise<void> | undefined {
  return inFlight.get(videoId);
}

// Test-only: await every in-flight pipeline. Called from teardownTestEnv so a
// fire-and-forget run scheduled by a test (e.g. via /complete) can't outlive
// the test and race its DB/temp-dir teardown.
export async function _drainInFlight(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}

// `only` restricts the run to a single step (a per-artifact regenerate);
// `force` re-runs steps even when already ready (manual reprocess).
type RunOpts = {
  source: "recorded" | "uploaded";
  force?: boolean;
  only?: ProcessingStepKind;
};

export async function runPipeline(videoId: string, opts: RunOpts): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video) return;

  const dir = derivativesDir(videoId);
  await mkdir(dir, { recursive: true });

  const ctx: StepContext = {
    videoId,
    video,
    source: opts.source,
    dir,
    duration: video.durationSeconds ?? 0,
    height: video.height ?? 0,
    force: opts.force ?? false,
    scratch: { silencesComputed: false },
  };

  const started = Date.now();
  const produced: string[] = [];
  const heightState = { probed: false };

  for (const step of RUNNABLE_STEPS) {
    if (opts.only && step.kind !== opts.only) continue;

    // Probe source height once it exists, so resolution-gated steps (variants)
    // see the real value even on a fresh run where video.height was still null.
    if (!heightState.probed && ctx.height === 0) {
      if (await Bun.file(join(dir, "source.mp4")).exists()) {
        heightState.probed = true;
        const meta = await probeMetadata(join(dir, "source.mp4"));
        if (meta) ctx.height = meta.height;
      }
    }

    if (!step.appliesTo(ctx)) continue;
    if (!(await inputsSatisfied(videoId, step, ctx))) continue;

    // Skip-if-ready resumability.
    if (!ctx.force && (await isAlreadyDone(videoId, step, ctx))) {
      produced.push(`${step.kind}*`);
      await reconcile(videoId, { running: true });
      continue;
    }

    await runStep(videoId, step, ctx, produced);
    await reconcile(videoId, { running: true });
  }

  // Single-artifact regenerate (`only`) touches just that step — skip the
  // whole-run side effects (editor storyboard, upload cleanup).
  if (!opts.only) {
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
