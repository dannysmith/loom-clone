# Pipeline-Unification Cleanup (Phase 4)

## Lineage

This is **Phase 4** of the [post-processing pipeline unification](../tasks-done/task-2026-06-11-1-post-processing-pipeline-unification.md). It is **pure cleanup fallout from [Phase 3](../tasks-done/task-2026-06-12-1-pipeline-unification-phase-3.md)** — no behaviour change, *except* [P4.7], which is a small feature folded in from [#46](https://github.com/dannysmith/loom-clone/issues/46) item 2.

**Depends on Phase 3.** Do not start until the pipelines are unified — most of these items only become possible (or only make sense) once "edit" is a pipeline mode with a context `activeFile`. Unprioritised (`task-x`) because it's dependent cleanup; promote it once Phase 3 lands.

---

## Items

- **[P4.1] Delete `generateVariants` / `variantsForHeight`** (`derivatives.ts`) — a parallel "which variants apply" computation to the registry's `appliesTo`, used only by the edit-pipeline; redundant once the edit drives the unified pipeline.

- **[P4.2] One `isServable(step, ctx)` predicate** — the "row `ready` AND file present" rule is currently inlined ~5 times (`inputsSatisfied` + `isAlreadyDone` in `pipeline.ts`, `computeReadiness` in `readiness.ts`, `resolve.ts`, `cleanup.ts`). This is the central invariant of the "ledger is a receipt, not an inventory" design; each inline copy is a place to forget the disk check and reintroduce the phantom-file bug. Extract one helper.

- **[P4.4] `resolve.ts` hand-copies `reconcile`'s mandatory-set bar** — it checks `source` + `metadata` ready with a "same bar reconcile uses" comment. Check `REQUIRED_KINDS.every(...)` so a future third required kind can't drift. (Pairs naturally with P4.2.)

- **[P4.8] Gate the edited active file on `edited_output` (deferred from Phase 3).** Phase 3 added a validated `edited_output` step but deliberately left `resolve.ts`'s serving gate unchanged (source+metadata + active-file-present), so legacy edited videos with no `edited_output` row still serve. Once the `isServable(step, ctx)` predicate (P4.2) exists, gate the active file on *its producing step* (`source` for unedited, `edited_output` for edited) so the edited cut gets the same validated-serving guarantee as recorded videos. Needs a one-time `inferStepsFromDisk` pass (or accept that legacy edited videos backfill on next reprocess) so existing edited videos gain the row before the gate tightens.

- **[P4.5] Inconsistent dynamic `import("fs/promises")` mid-function** in `routes/api/videos.ts` and `routes/admin/editor.ts`, where static imports are available elsewhere in the same files. Make them static.

- **[P4.6] A cross-reference comment** between `couldStillProduce`/`computeBadge` (readiness UI) and reconcile's "a `ready` video can still be enriching expected steps" status nuance — the same concept is expressed in two places; link them.

- **[P4.7] Edit-aware single-artifact regeneration — (#46 item 2).** Today the per-artifact "↻" regenerate is **hidden on edited videos** (a source-derived single-artifact regen would mismatch the edited active file); the only reprocess offered on an edited video is the global "Re-run post-processing", which resets the edit first. Once Phase 3 makes "edit" a pipeline mode with a context `activeFile`, a single-artifact regen can run *from the edited output* instead of the full source. Build that edit-aware regen path and surface "↻" on edited videos. (If Phase 3 slips, this stays hidden — the hide-on-edited behaviour is a complete interim solution.)

> P4.3 (remove thumbnail-candidates cleanup) already shipped in [#45](https://github.com/dannysmith/loom-clone/issues/45) (commit `fa21a36`). Not listed as work.

## References

- [Phase 3 doc](../tasks-done/task-2026-06-12-1-pipeline-unification-phase-3.md) (prerequisite).
- [Parent doc + full review](../tasks-done/task-2026-06-11-1-post-processing-pipeline-unification.md), [#48](https://github.com/dannysmith/loom-clone/issues/48), [#46](https://github.com/dannysmith/loom-clone/issues/46) item 2.
