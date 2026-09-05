// The post-processing pipeline orchestrator. Drives the step registry in order,
// writing a video_processing_steps row + an event per step and calling
// reconcile() after each mandatory one so `ready` is reached the moment source +
// metadata validate — independent of the slower steps that follow.
//
// A run is described by two sets rather than a mode matrix:
//
//   runSet   — which steps this run considers at all
//   forceSet — which of them are redone even though they're already `ready`
//
// Four named intents build those sets (see INTENTS). Everything else follows:
// skip-if-ready consults the force set, and staging is decided by one rule —
// stage when the run would replace artifacts the video is currently serving.
// There is no build/edit distinction, because an EDL is an input to the
// presentation master rather than a mode.
//
// Re-entrant by construction: each step is a no-op when its row is already
// `ready`/`skipped` and (for file-producing steps) the artifact is still on
// disk — unless the force set says otherwise. So re-running the pipeline IS
// "resume from where it failed", which is what the manual reprocess relies on.

import { eq } from "drizzle-orm";
import { mkdir, readdir, rename, rm, stat } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { type ProcessingStepKind, videos } from "../../db/schema";
import { purgeVideo } from "../cdn";
import { probeMetadata } from "../derivatives";
import { logEvent } from "../events";
import { nowIso } from "../format";
import { DATA_DIR, derivativesDir } from "../paths";
import { getVideo, setVideoStatus, sumSegmentDuration } from "../store";
import { reconcile } from "./reconcile";
import {
  isServable,
  PRESENTATION_KINDS,
  type ProcessingStep,
  presentationPath,
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

// What a run is for. The intent picks the sets; nothing downstream branches on
// it again.
//
//   intake  — (re)produce source.mp4 and everything from it. First `/complete`,
//             a heal re-`/complete` (the segments changed, so the stitch is
//             stale), and the admin's "Rebuild from HLS".
//   present — rebuild the presentation set from the existing source. Committing
//             an edit, "Re-run post-processing", and a future bulk reprocess
//             after the audio chain or watermark changes.
//   resume  — fill in whatever is missing, redo nothing. A redundant
//             `/complete`, or picking up after a failed step.
//   only    — one artifact (the admin's per-row ↻).
export type RunIntent = "intake" | "present" | "resume" | "only";

// Higher wins when a run is deferred behind one already in flight, so a queued
// full rebuild is never downgraded to something narrower.
const INTENT_PRECEDENCE: Record<RunIntent, number> = {
  intake: 3,
  present: 2,
  only: 1,
  resume: 0,
};

export type RunOpts = {
  source: "recorded" | "uploaded";
  intent: RunIntent;
  // Required for `only`, ignored otherwise.
  kind?: ProcessingStepKind;
};

function forceSetFor(opts: RunOpts): Set<ProcessingStepKind> {
  switch (opts.intent) {
    case "intake":
      return new Set(RUNNABLE_STEPS.map((s) => s.kind));
    case "present":
      return new Set(PRESENTATION_KINDS);
    case "only":
      return new Set(opts.kind ? [opts.kind] : []);
    case "resume":
      return new Set();
  }
}

function runSetFor(opts: RunOpts): Set<ProcessingStepKind> {
  if (opts.intent === "only") return new Set(opts.kind ? [opts.kind] : []);
  return new Set(RUNNABLE_STEPS.map((s) => s.kind));
}

// Collapses repeated schedule calls while a generation is in flight to the same
// promise, preventing two pipelines from racing on one video. The durable
// dedupe is the step table itself (skip-if-ready); this map just avoids
// redundant concurrent work within a single process lifetime.
const inFlight = new Map<string, Promise<void>>();

// A run requested while one is in flight is DEFERRED here (not dropped) and
// fired once the current run settles. The highest-precedence request wins, so a
// queued rebuild is never downgraded by a later, narrower one.
const pendingRerun = new Map<string, RunOpts>();

export type ScheduleOutcome = "started" | "queued" | "skipped";

export function scheduleDerivatives(videoId: string): void {
  schedule(videoId, { source: "recorded", intent: "resume" });
}

export function scheduleUploadDerivatives(videoId: string): void {
  schedule(videoId, { source: "uploaded", intent: "resume" });
}

// Fire-and-forget an edit commit. Under the presentation-master model this is
// exactly a `present` run — the EDL on disk is what makes the master a cut — so
// committing an edit and reprocessing share one code path.
export function scheduleEdit(videoId: string, source: "recorded" | "uploaded"): ScheduleOutcome {
  return schedule(videoId, { source, intent: "present" });
}

// Fire-and-forget a manual reprocess. Returns whether the run started now or was
// queued behind an in-flight one, so the admin route can tell the user.
export function scheduleReprocess(
  videoId: string,
  opts: { source: "recorded" | "uploaded"; intent: RunIntent; kind?: ProcessingStepKind },
): ScheduleOutcome {
  return schedule(videoId, opts);
}

function schedule(videoId: string, opts: RunOpts): ScheduleOutcome {
  if (inFlight.has(videoId)) {
    // A `resume` is already covered by whatever is in flight. Everything else
    // does work the current run won't, so it's deferred rather than dropped.
    if (opts.intent === "resume") {
      console.log(
        `[pipeline] ${videoId} schedule skipped — already in flight (n=${inFlight.size})`,
      );
      return "skipped";
    }
    const existing = pendingRerun.get(videoId);
    if (!existing || INTENT_PRECEDENCE[opts.intent] >= INTENT_PRECEDENCE[existing.intent]) {
      pendingRerun.set(videoId, opts);
    }
    console.log(`[pipeline] ${videoId} run queued behind in-flight run (intent=${opts.intent})`);
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
    `[pipeline] ${videoId} scheduled (source=${opts.source}, intent=${opts.intent}${
      opts.kind ? `:${opts.kind}` : ""
    }, n=${inFlight.size})`,
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

export async function runPipeline(videoId: string, opts: RunOpts): Promise<void> {
  const video = await getVideo(videoId, { includeTrashed: true });
  if (!video) return;

  const dir = derivativesDir(videoId);
  await mkdir(dir, { recursive: true });

  const runSet = runSetFor(opts);
  const forceSet = forceSetFor(opts);

  const ctx: StepContext = {
    videoId,
    video,
    source: opts.source,
    dir,
    inputDir: dir,
    sourceFile: join(dir, "source.mp4"),
    sourceDuration: 0, // refined below, then again by the source probe
    expectedSourceDuration: await expectedSourceDuration(videoId, opts.source),
    presentationDuration: video.durationSeconds ?? 0,
    height: video.height ?? 0,
    scratch: { silencesComputed: false },
  };

  // Stage→validate→swap when the run would replace artifacts the video is
  // currently serving: the previous outputs keep serving until the swap, and a
  // failed run leaves them (and the ledger) untouched. Everything else writes in
  // place, because it's additive or non-destructive — the first build, a heal
  // re-stitch (still serving HLS, so a failed stitch should surface as a failed
  // `source`), a resume, and single-artifact regenerates (each atomic already).
  const staged =
    video.status === "ready" && (opts.intent === "present" || opts.intent === "intake");

  // A staged run publishes `reprocessing` while it works. The previous set keeps
  // serving throughout; `ready` is restored on failure.
  if (staged) await setVideoStatus(videoId, "reprocessing");

  const started = Date.now();
  const produced: string[] = [];

  const stageKinds = staged
    ? new Set(PRESENTATION_KINDS.filter((k) => runSet.has(k)))
    : new Set<ProcessingStepKind>();

  try {
    await runSteps(videoId, ctx, { runSet, forceSet, stageKinds }, produced);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const what = staged ? `staged ${opts.intent} (outputs kept)` : opts.intent;
    console.error(`[pipeline] ${videoId} ${what} failed:`, msg);
    await logStep(videoId, "presentation", "failed", `${what}: ${msg}`);
    if (staged) {
      // A staged run publishes `reprocessing` up front and owns restoring the
      // status it interrupted; the previous set is still on disk and serving.
      await setVideoStatus(videoId, "ready");
    } else {
      // An in-place run never claimed `ready`, and forcing it here would publish
      // a video whose mandatory steps may never have validated. Let reconcile
      // read the ledger and settle it honestly.
      await reconcile(videoId, { running: false });
    }
    return;
  }

  // A master built without its audio chain is still served, and looks identical
  // to a processed one — so say so where the video's history is recorded.
  if (ctx.scratch.audioChainError) {
    await logStep(videoId, "audio_chain", "failed", ctx.scratch.audioChainError);
  }

  if (opts.intent !== "only") {
    await settleEditState(videoId, ctx);
    // For uploads, upload.mp4 produced source.mp4 — drop it once source +
    // metadata are confirmed so we never keep two copies (and never delete the
    // only copy of a still-unprocessed upload).
    if (opts.source === "uploaded") await maybeDeleteUpload(videoId);
  }

  await reconcile(videoId, { running: false });

  const totalMs = Date.now() - started;
  console.log(`[pipeline] ${videoId} done (${totalMs}ms, produced=[${produced.join(", ")}])`);
  // Final summary event for the activity feed (additive — per-step events above
  // are the durable record).
  await recordEvent(videoId, "processing_complete", { produced, durationMs: totalMs });
}

// How long source.mp4 SHOULD be, measured independently of the file itself so
// the stitch can be validated against it. For a recording that's the
// segment-duration sum — those rows outlive the HLS cleanup, so it stays correct
// even for an edited video whose cached durationSeconds describes the shorter
// master. For an upload it's a probe of upload.mp4, which only exists until the
// first successful run. Undefined when neither is available, in which case the
// source gets a structural check only.
async function expectedSourceDuration(
  videoId: string,
  source: "recorded" | "uploaded",
): Promise<number | undefined> {
  if (source === "recorded") {
    const total = await sumSegmentDuration(videoId);
    return total > 0 ? total : undefined;
  }
  const upload = join(DATA_DIR, videoId, "upload.mp4");
  if (!(await Bun.file(upload).exists())) return undefined;
  // Video-derived, because that's what the check measures.
  return (await probeMetadata(upload))?.videoDuration;
}

// One runner for every intent. Each step writes either into the real
// derivatives dir or into a staging dir, decided per step by `stageKinds`.
//
// Only the PRESENTATION group is ever staged, and that's the whole point of
// staging: it's the set a viewer is currently being served, so it has to be
// replaced all at once. Source-group artifacts are additive and already atomic
// (tmp→rename), and staging them would mean moving a directory —
// thumbnail-candidates/ — during the swap, which `rename` refuses to do onto a
// non-empty target.
//
// In-place steps mark the ledger as they go, and we reconcile after each
// mandatory one so the video reaches `ready` the moment source + metadata
// validate. Staged steps defer their ledger rows until the swap: any failure
// throws, aborting the run with the previous outputs, ledger and status
// untouched, so a failed rebuild can never demote a working video.
async function runSteps(
  videoId: string,
  ctx: StepContext,
  sets: {
    runSet: Set<ProcessingStepKind>;
    forceSet: Set<ProcessingStepKind>;
    stageKinds: Set<ProcessingStepKind>;
  },
  produced: string[],
): Promise<void> {
  const { runSet, forceSet, stageKinds } = sets;
  const realDir = ctx.dir;
  const stagingDir = join(realDir, ".staging");
  if (stageKinds.size > 0) {
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
  }

  const deferred: Array<{ step: ProcessingStep; result: StepRunResult }> = [];
  // Kinds produced into staging by this run. Their ledger rows don't exist until
  // the swap, so without this every step downstream of the presentation master
  // would find its input unsatisfied and silently never run.
  const stagedKinds = new Set<ProcessingStepKind>();
  // Steps whose existing artifact this run has invalidated. Applied after the
  // swap, so an aborted staged run leaves the live directory as it found it.
  const staleAfterSwap: ProcessingStep[] = [];

  await refreshSourceProbe(ctx, [join(realDir, "source.mp4")]);

  try {
    for (const step of RUNNABLE_STEPS) {
      if (!runSet.has(step.kind)) continue;
      const toStaging = stageKinds.has(step.kind);

      // `dir` is where a step WRITES, so it moves for the duration of a staged
      // step and is restored afterwards — artifact paths for the ledger and the
      // servable checks always resolve against the real dir.
      if (toStaging) ctx.dir = stagingDir;
      try {
        if (!step.appliesTo(ctx)) {
          // This run was responsible for producing the step (it's in the force
          // set) and the step no longer applies — so anything already on disk
          // describes a presentation that no longer exists. The case that bites:
          // an edit takes a 66s video down to 55s, the storyboard's >=60s
          // threshold stops applying, and the old sprite sheet is left behind
          // describing the uncut timeline.
          if (forceSet.has(step.kind) && !pathBelongsToAnotherStep(step, ctx, runSet)) {
            // A staged run promises the previous outputs survive a failure, and
            // this deletes from the LIVE directory — so hold it until the swap
            // has committed. In-place runs make no such promise and apply it now.
            if (stageKinds.size > 0) staleAfterSwap.push(step);
            else await dropStaleArtifact(videoId, step, ctx, { onlyIfPresent: true });
          }
          continue;
        }
        if (!(await inputsSatisfied(videoId, step, withRealDir(ctx, realDir), stagedKinds))) {
          continue;
        }
        if (
          !forceSet.has(step.kind) &&
          (await isAlreadyDone(videoId, step, withRealDir(ctx, realDir)))
        ) {
          produced.push(`${step.kind}*`);
          if (REQUIRED_KINDS.includes(step.kind)) await reconcile(videoId, { running: true });
          continue;
        }

        if (toStaging) {
          const result = await step.run!(ctx);
          if (result !== "skipped") {
            const valid = step.validate ? await step.validate(ctx) : true;
            if (!valid) throw new Error(`staged ${step.kind} produced an invalid artifact`);
            stagedKinds.add(step.kind);
          }
          deferred.push({ step, result });
        } else {
          await runStep(videoId, step, ctx, produced);
          // A staged run publishes `reprocessing` and owns putting the status
          // back. In-place failures are normally absorbed by runStep, but a
          // mandatory one means nothing downstream can run — and reconcile
          // never demotes `reprocessing`, so the video would sit there
          // permanently, in a state `canReprocess` refuses to retry. Throw so it
          // reaches the recovery path with the previous outputs intact.
          if (stageKinds.size > 0 && REQUIRED_KINDS.includes(step.kind)) {
            const row = await getStep(videoId, step.kind);
            if (row?.state === "failed") {
              throw new Error(`${step.kind} failed: ${row.error ?? "unknown"}`);
            }
          }
        }
      } finally {
        ctx.dir = realDir;
      }

      // A fresh source means a fresh height — and the height names the
      // presentation master, so it has to be right before that step runs.
      if (step.kind === "source") await refreshSourceProbe(ctx, [join(realDir, "source.mp4")]);
      if (REQUIRED_KINDS.includes(step.kind)) await reconcile(videoId, { running: true });
    }

    if (stageKinds.size > 0) {
      await swapStagedFiles(videoId, stagingDir, realDir);
      for (const step of staleAfterSwap) {
        await dropStaleArtifact(videoId, step, ctx, { onlyIfPresent: true });
      }
      for (const { step, result } of deferred) {
        await markStagedStep(videoId, step, ctx, result, produced);
      }
    }
  } finally {
    if (stageKinds.size > 0) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Move a validated staged set into place. Per-file renames within the same
// filesystem (staging is a subdir of the derivatives dir) are atomic, and files
// the run didn't regenerate stay in realDir untouched.
//
// Files only. `rename` onto an existing non-empty DIRECTORY fails with
// ENOTEMPTY, which would abort the swap halfway — after some files had already
// moved, and despite the caller reporting that the previous outputs were kept.
// Only the presentation group is staged and none of it produces a directory, so
// one here means a step has changed group without the swap being reconsidered:
// fail loudly rather than half-swap.
async function swapStagedFiles(
  videoId: string,
  stagingDir: string,
  realDir: string,
): Promise<void> {
  const entries = (await readdir(stagingDir)).filter((f) => !f.endsWith(".tmp"));
  for (const name of entries) {
    if ((await stat(join(stagingDir, name))).isDirectory()) {
      throw new Error(`staged output ${name} is a directory — staged runs produce files only`);
    }
  }
  for (const name of entries) await rename(join(stagingDir, name), join(realDir, name));
  console.log(`[pipeline] ${videoId} swapped ${entries.length} staged output(s)`);
}

// Probe source.mp4, seeding the height that names the presentation master and
// the dimensions the metadata step writes, plus the path every reader uses.
// Called once before the loop and again after the source step, so a re-stitch is
// measured rather than assumed.
async function refreshSourceProbe(ctx: StepContext, candidates: string[]): Promise<void> {
  for (const path of candidates) {
    if (!(await Bun.file(path).exists())) continue;
    ctx.sourceFile = path;
    const meta = await probeMetadata(path);
    if (!meta) return;
    ctx.height = meta.height;
    ctx.sourceDuration = meta.duration;
    ctx.scratch.sourceMeta = meta;
    return;
  }
  // No source on disk yet (a first build). The segment sum is the best estimate
  // available until the stitch lands and this runs again.
  ctx.sourceDuration = ctx.expectedSourceDuration ?? 0;
}

// Whether another step in this run legitimately owns the file this one would
// invalidate.
//
// A step that doesn't apply has no artifact — but `artifact()` still returns a
// path, and the paths overlap: for a 1080p source `variant_1080` never applies
// (it needs height > 1080) yet names `1080p.mp4`, which is exactly where the
// presentation master lives. Invalidating on that basis deletes the master the
// run just produced.
function pathBelongsToAnotherStep(
  step: ProcessingStep,
  ctx: StepContext,
  runSet: Set<ProcessingStepKind>,
): boolean {
  const path = step.artifact?.(ctx);
  if (!path) return false;
  return RUNNABLE_STEPS.some(
    (other) =>
      other.kind !== step.kind &&
      runSet.has(other.kind) &&
      other.appliesTo(ctx) &&
      other.artifact?.(ctx) === path,
  );
}

// A context view whose `dir` is the real derivatives dir, for the checks that
// ask about what's already on disk rather than about where this step writes.
function withRealDir(ctx: StepContext, realDir: string): StepContext {
  return ctx.dir === realDir ? ctx : { ...ctx, dir: realDir };
}

// Ledger marking for a staged step, post-swap.
async function markStagedStep(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
  result: StepRunResult,
  produced: string[],
): Promise<void> {
  if (result === "skipped") {
    await dropStaleArtifact(videoId, step, ctx);
    return;
  }
  const path = step.artifact?.(ctx);
  await markStepReady(videoId, step.kind, { sizeBytes: path ? fileSizeBytes(path) : null });
  await logStep(videoId, step.kind, "ready");
  produced.push(step.kind);
}

// A step that this run was responsible for producing but didn't leaves whatever
// was there describing the PREVIOUS presentation — a storyboard for a timeline
// the edit just shortened, captions for words that were cut. Those are worse
// than nothing (a viewer gets silently desynced scrubbing or subtitles), so the
// old artifact goes with the step's own output.
//
// Two ways a step produces nothing: it ran and returned "skipped", or it stopped
// applying at all. `onlyIfPresent` is for the second — a step can be permanently
// inapplicable (no 1080p variant for a 720p source), and that shouldn't write a
// ledger row for an artifact that never existed.
//
// This is the general form of a rule the edit path used to hand-code for the one
// case it had noticed: "if the edited cut fell below the storyboard threshold,
// delete the storyboard".
async function dropStaleArtifact(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
  opts: { onlyIfPresent?: boolean } = {},
): Promise<void> {
  const path = step.artifact?.(ctx);
  const present = path ? await Bun.file(path).exists() : false;
  if (opts.onlyIfPresent && !present) return;
  // Deliberately unguarded: `force` already makes "not there" a no-op, so a
  // throw here is a real failure to delete. Marking the step skipped anyway
  // would record that the stale artifact is gone when it isn't — and the
  // storyboard route serves its file on bare presence, with no ledger gate, so
  // the thing we just declared stale would carry on being served.
  if (path && present) await rm(path, { force: true });
  await markStepSkipped(videoId, step.kind);
  await logStep(videoId, step.kind, "skipped");
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
      // A presentation-group skip invalidates whatever was there (see
      // dropStaleArtifact). Elsewhere a "skipped" step whose artifact
      // nonetheless exists is really ready — suggested-edits declines to
      // overwrite a file from a prior run, and that file is still correct.
      if (PRESENTATION_KINDS.includes(step.kind)) {
        await dropStaleArtifact(videoId, step, ctx);
        return;
      }
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

// All declared inputs must be servable (`ready` AND, for file-producing inputs,
// present on disk) before a step can run. A missing input leaves this step
// untouched. `producedThisRun` covers the staged case, where an input has been
// built into the staging dir but won't reach the ledger until the swap.
async function inputsSatisfied(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
  producedThisRun?: ReadonlySet<ProcessingStepKind>,
): Promise<boolean> {
  for (const inputKind of step.inputs) {
    if (producedThisRun?.has(inputKind)) continue;
    const inputStep = stepByKind(inputKind);
    if (!inputStep) return false;
    if (!(await isServable(inputStep, ctx, await getStep(videoId, inputKind)))) return false;
  }
  return true;
}

// A step is "already done" when its row is skipped, or it's servable (`ready`
// and, for file-producing steps, still on disk). Drives resumability.
async function isAlreadyDone(
  videoId: string,
  step: ProcessingStep,
  ctx: StepContext,
): Promise<boolean> {
  const row = await getStep(videoId, step.kind);
  if (row?.state === "skipped") return true;
  return isServable(step, ctx, row);
}

// Bring `lastEditedAt` in line with the EDL that was just applied. It's a
// display/audit timestamp now, not a behaviour switch — the EDL on disk decides
// what the master contains — so this only records whether the presentation
// currently reflects any edits, and stamps a fresh time when it starts to.
// Clearing it when the EDL is empty is what makes "remove every edit and commit"
// a full revert.
async function settleEditState(videoId: string, ctx: StepContext): Promise<void> {
  // Only the presentation step knows what the master it just built contains, so
  // there's nothing to settle unless it ran. Re-reading the EDL here would also
  // rethrow a malformed one past the end of the run.
  if (ctx.scratch.fullSpan === undefined) return;
  if (!(await Bun.file(presentationPath(ctx)).exists())) return;

  const wasEdited = ctx.video.lastEditedAt != null;
  const isEdited = !ctx.scratch.fullSpan;
  if (wasEdited === isEdited) return;

  await getDb()
    .update(videos)
    .set({ lastEditedAt: isEdited ? nowIso() : null, updatedAt: nowIso() })
    .where(eq(videos.id, videoId));

  const video = await getVideo(videoId);
  if (video) purgeVideo(video.slug);
  await recordEvent(videoId, isEdited ? "edits_committed" : "edits_reset", {
    presentationDuration: ctx.presentationDuration,
  });
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

// Per-step entries on the video's activity feed. This is TELEMETRY, unlike the
// ledger rows beside it, which are state — so a failure to write one must never
// take down the run that produced it. The swap has already moved files by the
// time the post-swap entries are written; letting a full disk or a locked
// database throw here would abandon the remaining ledger marks and leave a
// perfectly good master unservable until someone re-ran the backfill.
async function logStep(
  videoId: string,
  kind: string,
  state: string,
  error?: string,
): Promise<void> {
  await recordEvent(videoId, "processing_step", error ? { kind, state, error } : { kind, state });
}

async function recordEvent(
  videoId: string,
  type: Parameters<typeof logEvent>[1],
  data: Parameters<typeof logEvent>[2],
): Promise<void> {
  try {
    await logEvent(videoId, type, data);
  } catch (err) {
    console.error(
      `[pipeline] ${videoId} could not record ${type} on the activity feed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
