// Derived readiness view (task-4 Part 2). Turns the video_processing_steps
// rows + registry applicability into the admin checklist (per-step ✅/❌/⏳/—)
// and the coarse rollup badge shown next to a `ready` video. Computed on the
// fly — never stored — so it can't drift from the ledger.

import { join } from "path";
import type { ProcessingStepKind, Video } from "../../db/schema";
import { DATA_DIR } from "../store";
import {
  applicabilityContext,
  derivativesDir,
  PROCESSING_STEPS,
  REGENERABLE_KINDS,
  type StepTier,
} from "./registry";
import { getStepStates } from "./steps-store";

// ✅ have it · ❌ don't · ⏳ actively generating · — not applicable
export type ReadinessIcon = "ready" | "missing" | "pending" | "na";

export type ReadinessItem = {
  kind: ProcessingStepKind;
  label: string;
  tier: StepTier;
  icon: ReadinessIcon;
  // Whether a per-artifact "regenerate this" button should be offered: the
  // step is independently regenerable AND its source.mp4 input is valid.
  regenerable: boolean;
};

// What kinds of server-side rebuild a video supports right now.
export type Reprocessability = {
  // Source can be re-stitched: recorded → HLS present; uploaded → upload.mp4 present.
  canRebuildSource: boolean;
  // source.mp4 is validated good and on disk (downstream regen is possible).
  sourceValid: boolean;
  // Neither — the video can't be rebuilt from the server (data-loss territory).
  dataLoss: boolean;
};

export type Readiness = {
  items: ReadinessItem[];
  // Short rollup label shown beside a `ready` status (null otherwise).
  badge: string | null;
  reprocess: Reprocessability;
};

export async function reprocessability(video: Video): Promise<Reprocessability> {
  const dir = derivativesDir(video.id);
  const videoDir = join(DATA_DIR, video.id);

  const [steps, sourcePresent, hlsPresent, uploadPresent] = await Promise.all([
    getStepStates(video.id),
    Bun.file(join(dir, "source.mp4")).exists(),
    Bun.file(join(videoDir, "stream.m3u8")).exists(),
    Bun.file(join(videoDir, "upload.mp4")).exists(),
  ]);

  const sourceValid = steps.get("source")?.state === "ready" && sourcePresent;
  const canRebuildSource = video.source === "uploaded" ? uploadPresent : hlsPresent;
  return { canRebuildSource, sourceValid, dataLoss: !canRebuildSource && !sourceValid };
}

// Statuses where re-running the (resumable) pipeline makes sense. Not while
// recording/healing (footage still arriving), mid-reprocess, or deleting.
const REPROCESSABLE = new Set(["processing", "processing_failed", "ready", "incomplete"]);

export function canReprocess(video: Video): boolean {
  return !video.trashedAt && REPROCESSABLE.has(video.status);
}

const LABELS: Record<ProcessingStepKind, string> = {
  source: "Source video",
  metadata: "Metadata",
  audio: "Audio processed",
  thumbnail: "Thumbnail",
  variant_1080: "1080p variant",
  variant_720: "720p variant",
  storyboard: "Storyboard",
  peaks: "Audio peaks",
  suggested_edits: "Suggested edits",
  transcript: "Transcript",
  words: "Word timings",
  title_suggestion: "Suggested title",
  description_suggestion: "Suggested description",
  chapter_titles: "Chapter titles",
};

// A run is "in progress" (so not-yet-produced server steps show ⏳ rather than
// ❌) while the video is processing/reprocessing, or while a `ready` video is
// still being enriched (the run reaches `ready` the moment source+metadata
// validate, before the slower expected steps finish).
function couldStillProduce(status: Video["status"], tier: StepTier): boolean {
  if (status === "processing" || status === "reprocessing") return true;
  if (status === "ready" && tier === "expected") return true;
  return false;
}

export async function computeReadiness(video: Video): Promise<Readiness> {
  const ctx = applicabilityContext(video);
  const [steps, reprocess] = await Promise.all([getStepStates(video.id), reprocessability(video)]);

  const items: ReadinessItem[] = [];
  for (const step of PROCESSING_STEPS) {
    const label = LABELS[step.kind];
    // A per-artifact regenerate is offered only when the step is independently
    // regenerable AND its source.mp4 input is valid.
    const regenerable = REGENERABLE_KINDS.has(step.kind) && reprocess.sourceValid;

    if (!step.appliesTo(ctx)) {
      items.push({ kind: step.kind, label, tier: step.tier, icon: "na", regenerable: false });
      continue;
    }

    const row = steps.get(step.kind);
    let icon: ReadinessIcon;
    if (row?.state === "skipped") {
      icon = "ready"; // terminal-good: deliberately not produced, nothing missing
    } else if (row?.state === "ready") {
      // Ready in the ledger, but only servable if the file is still on disk.
      const path = step.artifact?.(ctx);
      icon = !path || (await Bun.file(path).exists()) ? "ready" : "missing";
    } else if (row?.state === "failed") {
      icon = "missing";
    } else if (step.tier === "external") {
      icon = "missing"; // Mac-sent — ✅/❌ only, never ⏳ (may never arrive)
    } else {
      icon = couldStillProduce(video.status, step.tier) ? "pending" : "missing";
    }

    items.push({ kind: step.kind, label, tier: step.tier, icon, regenerable });
  }

  return { items, badge: computeBadge(video, items), reprocess };
}

// The rollup badge only means something for a `ready` video — for every other
// status the status badge itself is the headline.
function computeBadge(video: Video, items: ReadinessItem[]): string | null {
  if (video.status !== "ready") return null;

  const optional = items.filter((i) => i.tier !== "required" && i.icon !== "na");
  const enriching = optional.filter((i) => i.tier === "expected" && i.icon !== "ready");
  const externalMissing = optional.filter((i) => i.tier === "external" && i.icon !== "ready");

  if (enriching.length === 0 && externalMissing.length === 0) return "complete ✓";
  if (enriching.length > 0) return `enriching (${enriching.length} left)`;
  if (externalMissing.length === 1) return `awaiting ${externalMissing[0]!.label.toLowerCase()}`;
  return `awaiting extras (${externalMissing.length})`;
}
