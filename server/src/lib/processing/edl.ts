// Reading the edit decision list and turning it into kept segments.
//
// The EDL stopped being a mode trigger with the presentation-master restructure:
// it's just an input, and "no edits" is the identity case rather than a separate
// code path. Both the presentation step (what to render) and the captions step
// (what to remap) go through here, so they can never disagree about the cut.

import { join } from "path";
import { computeKeptSegments, type Edit, type Segment } from "../edit-transcript";

export type Edl = {
  version: number;
  source: string;
  edits: Edit[];
};

export type KeptResult = {
  kept: Segment[];
  // True when the kept set is the whole source: no EDL, an empty one, or one
  // whose edits have all been removed. Callers use it to take the cheap path —
  // no video re-encode, and captions copied verbatim rather than re-derived.
  fullSpan: boolean;
};

// Tolerance for "does this segment reach the ends of the source?". Kept
// generous: an EDL's trim boundaries come from a UI dragging against a probed
// duration, and re-encoding a whole video to shave 40ms off its head is not a
// trade worth making.
const FULL_SPAN_TOLERANCE = 0.05;

// Null means there is genuinely no EDL. A malformed one THROWS rather than
// degrading to "unedited", because degrading is the more damaging outcome: the
// run would succeed, the staged swap would replace an edited master with an
// uncut one, and whatever the user had trimmed out would quietly go back on the
// public page. Throwing fails the step, keeps the previous master serving, and
// puts the problem on the readiness checklist where it can be seen.
export async function readEdl(derivDir: string): Promise<Edl | null> {
  const file = Bun.file(join(derivDir, "edits.json"));
  if (!(await file.exists())) return null;
  const parsed = (await file.json()) as Edl;
  if (!Array.isArray(parsed?.edits)) {
    throw new Error("edits.json is present but has no edits array");
  }
  return parsed;
}

// Kept segments for a source of `sourceDuration` seconds. An absent, empty or
// fully-cleared EDL yields one full-span segment — which is what makes "delete
// every edit and commit" the revert path.
export async function keptSegmentsFor(
  derivDir: string,
  sourceDuration: number,
): Promise<KeptResult> {
  const edl = await readEdl(derivDir);
  const edits = edl?.edits ?? [];
  const kept = computeKeptSegments(edits, sourceDuration);
  return { kept, fullSpan: isFullSpan(kept, sourceDuration) };
}

// How long a render of `kept` should come out. Independent of the rendered file,
// which is the point: it's what the presentation master gets validated against.
export function keptDuration(kept: Segment[]): number {
  return kept.reduce((total, seg) => total + (seg.end - seg.start), 0);
}

export function isFullSpan(kept: Segment[], sourceDuration: number): boolean {
  if (kept.length !== 1) return false;
  const only = kept[0]!;
  return only.start <= FULL_SPAN_TOLERANCE && only.end >= sourceDuration - FULL_SPAN_TOLERANCE;
}
