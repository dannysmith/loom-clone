// Single home for the video-status taxonomy — the overlapping sets that several
// modules used to maintain by hand and that drift the moment a status is added.
// Each set is declared here (validated against the schema enum via `satisfies`)
// and imported by reconcile, readiness, store, and the admin helpers — rather
// than those modules importing the sets from one another, which previously ran a
// UI/derivation module (readiness) uphill into the state machine (reconcile).
//
// Relationships (kept here, in one place, instead of scattered in prose):
//   VALID_STATUS          = every status EXCEPT the terminal `deleting`
//   RECONCILE_OWNED       = the post-footage statuses reconcile may transition
//   POST_FOOTAGE_STATUSES = RECONCILE_OWNED − incomplete + reprocessing

import { VIDEO_STATUSES, type VideoStatus } from "../db/schema";

// The post-footage statuses reconcile owns. This is ALSO the set of statuses
// from which a manual reprocess makes sense (readiness.canReprocess), so keeping
// them one constant means a reprocessable status can never lack an owner to
// settle it back to `ready`/`processing_failed`. Excludes: recording/healing
// (owned by /complete), reprocessing (owned by the editor), deleting (terminal).
export const RECONCILE_OWNED: ReadonlySet<string> = new Set([
  "processing",
  "ready",
  "processing_failed",
  "incomplete",
] satisfies VideoStatus[]);

// Statuses where a video is expected to have (or be producing) a validated MP4,
// so a duplicate's status can be derived from the inferred step ledger. This is
// RECONCILE_OWNED minus `incomplete` (an incomplete copy mirrors its partial
// footage, not the derivative ledger — reconcile never relabels incomplete),
// plus `reprocessing` (an edit/reprocess in flight).
export const POST_FOOTAGE_STATUSES: ReadonlySet<string> = new Set([
  "processing",
  "ready",
  "processing_failed",
  "reprocessing",
] satisfies VideoStatus[]);

// Every status a user can filter the dashboard by — all of them except the
// terminal `deleting` (a video on its way out is never browsed).
export const VALID_STATUS: ReadonlySet<string> = new Set<string>(
  VIDEO_STATUSES.filter((s) => s !== "deleting"),
);
