# LoomClone — Architecture Review (2026-07-28)

This is the write-up of a full-codebase review conducted as an outside look at the system: the macOS app, the server, the admin surfaces, the viewer surface, and the operational layer around them. I read the developer docs and the core source directly, ran five parallel deep-dives (macOS app, server core, routes/views, the frontend sub-projects, and tests/ops/dependencies), and independently re-verified every finding this document leans on. Small concrete items are in the Nitpicks appendix at the end of this document and deliberately excluded from the body; this document is the structural stuff and my opinions on it.

A note on calibration: the review lens was "maintained by Danny plus AI agents, occasionally, over many years, with the video URLs needing to outlive everything else." Where that lens changes a judgement, I say so.

## Overall verdict

This is an unusually well-built system for a personal tool, and I want to say that plainly before spending the rest of the document on problems. The architecture is fundamentally sound at every level I looked at: the four-actor recording pipeline with its capture-PTS clock model, the segment-streaming-plus-healing design, the step-ledger processing pipeline, the four-module server split cut along auth boundaries, the table-gated serving decisions, the CDN layer. I would not rebuild any of it, including the parts you flagged as suspects. The documentation is genuinely exceptional — not "good for a side project" but better than most production systems I've seen, particularly the comments that record *refuted* hypotheses (the ZV-1/CMIO history in the camera code is the best example — that's what stops a future agent from re-introducing bug #30).

The risks are not where you'd intuitively look for them. The code is good. The risks live in the gaps *between* the safety systems: a CI gate that silently doesn't test the media pipeline, documentation that has started to drift from the code it describes, an ops layer with no way to tell you something broke, and a backup that quietly misses two files. None of these are architecture problems. All of them are cheap to fix. And they share a root cause worth naming: every one of them is a place where the system *appears* protected but isn't, which is precisely the failure mode that matters for a system you intend to leave alone for long stretches.

The rest of this document works through the findings in roughly descending order of how much I think you should care.

## 1. Your docs are infrastructure, and they have started to drift

The maintenance model for this codebase is "an AI agent reads AGENTS.md, follows its pointers into `docs/developer/`, and trusts what it finds." That makes the docs load-bearing in a way they aren't in a conventionally-maintained project — they're not a courtesy, they're the runtime for future changes. The quality of these docs is the single biggest asset the project has. Which is why the drift we found is the finding I'd rank first, even though every instance is individually trivial:

- `AGENTS.md` and `admin-editor.md` both direct agents to read `lib/edit-pipeline.ts` before touching edit code. That file was deleted in the pipeline unification. An agent following your own instructions hits a dead end on exactly the code where the stakes are highest.
- `app.ts` and `server-routes-and-api.md` both assert that Hono matches routes by specificity regardless of mount order, so the site/videos mount order is "documentation of intent." I tested this against the real route shapes: it's false. The unconstrained `/:file` catch-all swallows `/feed.xml`, `/robots.txt`, `/sitemap.xml` and friends if the mounts are reordered. This is the dangerous *direction* of drift — a comment that actively tells a future agent a breaking change is safe.
- `backup-and-restore.md` documents three backed-up files; the script backs up five; the documented restore procedure loses two of them (`edits.json`, `words.json`). Someone following the runbook in a disaster recovers less than the backup contains.
- Smaller instances: the routes doc still says the player is CDN-hosted (it's self-hosted as of this week); the streaming doc's "Viewer" section describes the old file-presence serving check, contradicting the correct "table-gated" bullet in the same document; `app/LoomClone/CLAUDE.md` lists three of RecordingActor's nine extensions; the recording-pipeline doc misattributes the pause accumulator to WriterActor.

My opinion: the fix is partly mechanical (all of the above are listed in the nitpicks appendix and fixable in one sitting) but mostly procedural. Right now nothing in your workflow verifies docs against code. Two habits would close the loop cheaply: make "update the affected developer docs" an explicit part of finishing any task that touches documented behaviour (it mostly happens already — the drift is the residue of the times it didn't), and periodically run a docs-audit task where an agent's only job is to verify each claim in `docs/developer/` against the source. That second one is almost perfectly suited to an agent, it's cheap, and this review effectively just did the first iteration of it.

## 2. The deploy gate doesn't test the thing the system exists to protect

CI is the only gate between a push to `main` and production — the deploy job runs on green tests, roughly a minute later. But the GitHub runner has no ffmpeg installed, and every ffmpeg-dependent test is written with `test.skipIf(!ffmpeg)`. The result, verified against the actual run logs: **CI runs 699 tests and silently skips the 45 that cover the entire media pipeline** — source stitching, the audio chain, variants, storyboards, thumbnails, edit rendering, and `isProbablyPlayable`, the validation predicate everything else trusts. Locally the full 744 run and pass; the deploy gate has never once exercised them.

This compounds badly with a specific design property: `cleanupStaleFiles` deletes a video's HLS segments ten days after it reaches `ready`, on the strength of the `source` step being validated. The validation logic is exactly what CI doesn't test. A regression that weakens `isProbablyPlayable` ships on green, and its consequences become unrecoverable ten days later. For a system whose second core principle is "never lose footage," the one place where footage loss is truly permanent sits behind the one test surface CI skips.

The fix is a line or two (`apt-get install -y ffmpeg` in the workflow), plus accepting a slower test job — the full suite is ~28s locally, so this costs little. While in there, two related pins matter more than they look: the Dockerfile installs ffmpeg unpinned from apt (the audio chain and `-fps_mode passthrough` depend on ffmpeg versions; a silent major bump on a VPS rebuild is a real hazard), and the `oven/bun:1` base image floats, meaning a disaster-recovery rebuild gets whatever Bun is current rather than what you've been running. Pin both, record the versions, and CI-versus-production stops being an unknown.

## 3. The system can fail silently for months, and you'd find out from a failed recording

You asked me to weigh "what if I get busy and don't touch this for two years while still making videos." The core loop survives that scenario well — the client-side healing, the convergent segment protocol, and the CDN's serve-stale-if-origin-down setting are genuinely built for unattended operation. What doesn't survive it is everything around the core loop, because **the system currently has no way to tell you anything**:

- The backup script's healthchecks.io ping is documented as an optional step. If it isn't set up (worth checking — I can't see the VPS crontab), a backup that started failing in March is discovered whenever you next read a log file. Backup failure alerting is, in my view, the single highest-value piece of ops configuration this system can have; it shouldn't be optional.
- Nothing watches disk. Video data grows monotonically on a fixed-size volume; there's no threshold warning anywhere. Disk-full on the data volume is also the failure most likely to *cause* the failed recording that finally gets your attention.
- The container has no `HEALTHCHECK`, and `migrate()` runs unconditionally at boot — a bad migration produces a crash-looping container while the deploy that caused it reports green.
- Container logs are unrotated `json-file`, growing forever; `BUNNY_CDN_API_KEY` interpolation failing in compose silently disables all CDN purging; a transient ffmpeg failure parks a video in `processing_failed` with no retry and no notification, waiting for you to happen to open the admin panel; and a video stuck in `healing` (Mac died mid-heal, laptop never came back online) is invisible to every safety net — it's excluded from reconcile, from the stalled-recording sweep, and from the dashboard's "needs attention" filter. It just stays `healing` forever.

My recommendation here is a single, bounded piece of work I'd rank second only to the CI fix: an ops-hardening pass whose goal is "the system reports its own health." Concretely: healthchecks.io pings on the backup cron (and the weekly restic check); a small daily self-check — a script or endpoint that reports disk headroom, videos stuck in non-terminal states past a threshold, failed processing steps, and last-successful-backup age — wired to the same alerting; a Docker `HEALTHCHECK` against `/api/health`; log rotation in the compose file; and a `healing`-timeout sweep alongside the existing `recording` one. None of this is architecture. All of it converts "silent for months" into "you get an email that afternoon."

## 4. The backup is well-designed and slightly wrong at the edges

The restic + Hetzner-snapshots design is right, and the minimal-file-set philosophy (back up only what can't be regenerated) is the correct call. But the edges have drifted from the philosophy:

- `chapters.json` — user-edited chapter titles, living in the video root rather than `derivatives/` — is not backed up and is not regenerable. It's the only user-authored data in the system that would be simply gone after a restore.
- `captions.srt` isn't backed up; it's approximately re-derivable from `words.json` (which is), but by an undocumented path, and the transcript row in the database only holds plain text without timing.
- The restore runbook loses `edits.json` and `words.json` as described in section 1.

Two further opinions. First, a restore has (as far as the repo shows) never been rehearsed end-to-end; the doc's own "Regenerate derivatives" section trails off into "you may need to trigger `scheduleDerivatives` per video," which is exactly where a real 2 a.m. recovery would stall. A one-time restore drill onto a scratch directory, fixing the runbook as you go, would convert the backup from "probably fine" to "known good." Second, the original requirements doc's version of never-lose-footage explicitly included "processed videos backed up to durable object storage." The restic setup honours the spirit, but icebox issue #4 (R2) is, in my view, the one icebox item with a genuinely strong case — not for serving (the current serving path is fine) but because object storage plus the existing CDN is also the skeleton of the far-future "URLs outlive the system" story you described. I wouldn't do it now; I'd keep it warm rather than icy.

On that far-future story: it's worth noticing how close the current design already is to a terminal static export. Everything viewer-facing is slug-addressed flat files plus two small tables (videos, slug_redirects); a script that walks the database and emits static HTML pages, MP4s, and a redirect map could freeze the entire public surface onto any static host. I'm not suggesting building it. I'm suggesting writing a half-page note recording that this is the intended end-of-life path, so no future feature accidentally makes the viewer surface depend on something dynamic that can't be exported. Cheap insurance on the one requirement you called most important.

## 5. The server's centre of gravity needs re-layering — eventually, not urgently

`store.ts` is 1,100 lines and its query half is excellent (the cursor pagination with composite tiebreakers is textbook). But it has become the module everything routes through, and the codebase itself tells you this: there are six `await import()` calls across the lib layer that exist purely to break dependency cycles, and most cycles run through `store.ts`. Two specific observations:

- The root cause is mundane: `DATA_DIR` — a constant — lives in `store.ts`, so every module that touches the filesystem imports the store, and the store imports half of them back. Moving `DATA_DIR` (and the handful of path helpers) into a dependency-free `paths.ts` dissolves most of the cycles for close to zero effort. This is the rare refactor where the payoff-to-risk ratio is so lopsided I'd just do it.
- `duplicateVideo` is 127 lines of cross-layer orchestration — file copying, ledger re-inference, status rollup, feed purging — inside what presents as a data-access module. `permanentlyDeleteVideo` is similar. These belong in a lifecycle/orchestration module that *uses* the store. Worth doing opportunistically, next time either function needs touching.

I want to be measured here: this is not a crisis, and I'm explicitly not recommending a "split store.ts into eight files" project. The module is well-commented and its functions are individually clear. The problem is directional — every new feature has been finding its way into `store.ts`, and the dynamic imports are the early-warning signal. Fix the constant, and adopt a rule that new orchestration goes beside the store rather than in it.

## 6. The processing pipeline: keep the registry, freeze the orchestrator

The step-registry design (`registry.ts`) is the best piece of server architecture in the project and it earns its complexity several times over: the declarative table gives you resumability, the admin readiness checklist, dependency-aware regeneration, backfill, and the `isServable` predicate — the ledger-plus-disk-stat check that means a broken or deleted MP4 falls back to HLS instead of 404ing. That last idea, "the ledger is a receipt, not an inventory," is genuinely good design and it's applied consistently.

The orchestrator (`pipeline.ts`) is a different story. It now handles a mode matrix — build vs edit, forced vs resumable, full vs single-artifact, staged vs in-place — plus an in-flight map, a deferred-rerun queue with downgrade protection, and a run-lock. Each increment was justified (I traced the history; the staged-swap for edits, in particular, is the right design), but the sum is the one place on the server where I'd hesitate to predict behaviour without careful reading, and where edit-specific logic has leaked into generic code (`finalizeEdit` inside the orchestrator; the `edited_output` step mutating `ctx.duration` as a side channel to later steps). Some of the concurrency machinery also defends against races that a single-user system makes nearly impossible — though "nearly" is doing work there, since fire-and-forget pipelines genuinely can overlap admin-triggered reprocesses.

My advice is containment rather than refactoring: treat the orchestrator's mode matrix as closed. If a future feature wants pipeline behaviour that doesn't fit build/edit/force/only, that's the signal to restructure rather than extend. And when you're next in the file anyway, extracting `finalizeEdit` into the edit module would put the edit logic back where an agent will look for it.

## 7. The macOS app: healthy, with one honest caveat and one cheap win

Your instinct that the app is in good shape is broadly correct. Strict concurrency with warnings-as-errors, the actor decomposition, the diagnostics investment (`diagnostics.json`, `os-log.ndjson`), and `CameraCadenceMonitor` (pure, tested, shared between pipeline and preview) are all better than they needed to be. `WriterActor`'s AsyncStream-with-awaited-consumer stop ordering — the thing that guarantees no trailing segment is lost — is the single best design decision in the app.

The caveat: `RecordingActor` is a genuine god object — ~3,900 lines across ten files, 58 stored properties, roughly three times the other three actors combined. I want to be fair about the cause: the recording clock, the freshness gate, pause accounting, and the keep-alive path are *irreducibly* coupled — they share state by nature, and splitting them across actors would introduce hop-latency and consistency problems that are worse than the size. But not everything in there is timing-coupled: app exclusion, source-health tracking, and diagnostics are each cleanly separable, and the extension split is currently file organisation rather than encapsulation (everything can still touch everything). I'd extract those three when convenient and accept the rest.

The cheap win, and my one real recommendation for the app: the highest-risk logic — PTS arithmetic, the freshness gate, keep-alive decisions, pause accounting — currently has no test seam at all; it's woven through actor state. Reshaping those calculations into pure static functions taking `(now, start, pauseAccumulator, lastEmitted, …)` would make the app's most subtle logic testable the way `CameraCadenceMonitor` already is, and it's exactly the kind of code where an agent's future "small fix" can silently break A/V sync. Relatedly, `HealAgent.patchRecordingJSON` — the function that maintains the never-lose-footage audit trail — is trivially testable with a temp directory and has zero tests today.

The systemic pattern to watch in the app is copy-paste divergence, because it has already bitten: the post-stop handoff is duplicated between the normal and terminal stop flows and the two copies have *already* drifted (one restarts the mic preview, the others don't — and nothing records which is intended). The two agents duplicate `markOrphaned` byte-for-byte; the raw-writer handling exists in six near-identical blocks. Each duplication is harmless until the next edit lands on one copy. The nitpicks list enumerates them; consolidating is mechanical work an agent does well.

Also worth stating: the app has no CI at all — `make test` exists and nothing runs it. Even a build-plus-test workflow on app changes (macOS runners are slow, but this isn't a frequent-push project) would catch the class of breakage that currently only surfaces when you next open Xcode.

## 8. The frontend sub-projects: the architecture is fine; the quality gates are missing

You flagged the two Vite sub-projects as possible evidence of accretion, so I had this examined adversarially, including honestly costing the alternatives (single build, no-build ESM, Bun.build, folding the player into the editor tooling). Conclusion, which I endorse after reading the analysis: **the shape is right and a from-scratch rebuild would land in nearly the same place.** The server's no-build property is worth protecting; the two things that need bundling (a React editor with wavesurfer, a web-components player with a lazy-chunk graph) genuinely need it; isolated islands joined by a manifest is the correct join. The only structural improvement worth considering is modest: merge the two packages into one `server/client/` with two Vite configs, keeping the per-output commit policies — it collapses duplicated tooling that has already version-drifted between the two lockfiles. Optional, contained, not urgent.

What actually needs fixing is around the seams:

- **All ~4,900 lines of `editor/` and `player/` sit outside every quality gate** — outside Biome, outside `tsc` (their strict tsconfigs are never executed by anything; `vite build` doesn't typecheck), outside the test suite, and outside CI, which doesn't even build them. An editor type error currently first surfaces as a failed Docker build on the VPS. Extending Biome/typecheck/CI to cover them is the highest value-per-effort change in this whole area.
- **The dev-mode detection fails in both directions.** A missing production editor build silently serves script tags pointing at `localhost:5173` — a blank page with no error — and the same `existsSync` check permanently disables HMR once you've ever run a local build, which nothing documents. An explicit env flag fixes both.
- **The deploy story undermines its own reasoning.** The player bundle is committed so deploys never depend on the npm registry — but the Dockerfile runs `bun install` twice before the player matters, and every deploy runs a Vite build *on the VPS* (the same host whose memory pressure produced issue #39), inside an unconstrained `docker build`, shipping the whole toolchain in a single-stage image. The clean end-state is building the image in CI and pushing to a registry, with the VPS just pulling; the minimum is building the editor in CI and multi-staging the Dockerfile. Either restores the coherence the commit policies are reaching for.
- **`src/cover/` is a second application wearing the editor's clothes** — ~1,000 lines, no shared code with the editor, absent from `admin-editor.md` entirely, with its own code style, hardcoding values that `site-config.ts` owns, and fetching Google Fonts at export time. It's fine for it to exist; it isn't fine for it to be undocumented and ungoverned. Document it, put it under the same gates, and de-hardcode the site config.

One consistency note that spans this and the admin panel: the project self-hosted Vidstack this week specifically so the *viewer* surface doesn't depend on third-party CDNs — a decision I agree with — while the admin panel loads htmx, head-support, and highlight.js from jsDelivr and the cover tool fetches Google Fonts. Admin-only surfaces are lower stakes (a jsDelivr outage breaks your admin, not your viewers' videos), so this may be a deliberate line — but if the durability argument is real, it's cheap to apply it to the four remaining scripts and be done with the category.

## 9. The AI-authorship signature, and what to do about it

You asked whether the codebase shows recognisable AI-architected weaknesses. It shows fewer than I expected — the strong docs, task discipline, and review loop clearly worked. But the residue is visible and consistent, and it's worth naming because it predicts where future defects will come from:

- **Near-duplicate blocks that drift independently.** The emblematic example is `purgeVideo` vs `purgeTag`: `purgeTag` contains a comment explaining precisely why a wildcard purge misses the bare slug path and handles it — and `purgeVideo`, twenty lines above, has exactly that bug (edits to a video's metadata leave the CDN-cached video page stale). The reasoning existed in the codebase; it just wasn't carried to the sibling. The same pattern appears in the app's stop flows and the admin field partials.
- **Dead code labelled "for future use"** and back-compat shims for callers that don't exist — an agent's reluctance to delete. There's a modest pile of it (inventoried in the nitpicks).
- **Decorative rigour**: strict tsconfigs nothing executes, an `eslint-disable` in a project with no ESLint, a `catch { /* DB may be gone in tests */ }` in production code. Things that look like safety but aren't wired to anything.
- **Local consistency, global divergence**: five error-handling idioms across the lib layer, three cached-ffmpeg-path strategies, two VTT formatters, three spellings of the segment-filename regex. Each module is internally consistent; the seams between generations of work are where the variance lives.

None of this is alarming, and the countermeasure plays directly to the maintenance model's strength: agents are unusually good at mechanical consistency sweeps when handed an inventory. the nitpicks appendix is that inventory. I'd also suggest one standing habit: when a task adds reasoning to one site (a comment explaining a hazard, a guard, a validation), have it grep for the siblings. That's the purgeVideo lesson in one sentence.

## 10. Revisiting the founding technical principles

You asked whether the tech-side principles deserve re-examination now the system exists. Briefly, principle by principle:

- **Instant shareability** — fully achieved and the architecture serves it structurally (two-phase start, fire-and-forget everything after `/complete`). No notes.
- **Never lose footage** — excellent client-side; the server side is where the CI gap, the `healing` orphan state, and the backup edges all live. This principle is the through-line of most of my top recommendations, and its original text (durable object storage) is the best argument for eventually thawing the R2 icebox item.
- **Own my URLs / permanent URLs** — well served (slug redirects, the `/v/` compat routes, the reserved-slug discipline). The static-export note from section 4 is the long-horizon completion of this principle.
- **Reliability for viewers** — the CDN layer with serve-stale is right. The one soft spot is cache-purge correctness (the bare-slug purge bug, the unpurged dotted variants) — the kind of thing that makes an edited title invisibly stale for viewers.
- **Simplicity** — holding up well in product scope (genuinely nothing in this system is a feature you don't use) and in the big technology choices. Where it has quietly lost ground is the pipeline orchestrator's mode matrix and the ops surface (three compose files, two sub-builds, a VPS build step). Sections 6 and 8 are the containment plan.
- **The unstated principle — "no build step for the server"** — still true and still worth protecting; the sub-projects are the pressure on it and I think the current line (islands may build; the server doesn't) is exactly right.

On the "mental" end of the spectrum, for completeness: I considered whether I'd recommend rewriting the server in a compiled language (no — the risk profile here is dependency churn and silent ops failure, not throughput or type-safety; Bun+Hono+SQLite on one box is close to optimal for this system's actual load), whether media belongs on object storage today (no — but it's the right eventual move for the permanence story), whether the admin panel should be a SPA (no — HTMX + server JSX is aging better than a React admin would), and whether the repo should split (no — the cross-cutting docs are the glue and they'd suffer). The most honest summary of the "mental options" survey is that this system's fundamentals are good enough that every radical option costs more than it returns.

## If you only do five things

1. **Install ffmpeg in CI** so the deploy gate actually tests the media pipeline, and pin ffmpeg + the Bun base image in the Dockerfile. Smallest change, largest risk retired.
2. **Spend one focused session on ops signal**: healthchecks.io pings on backup + restic check, a daily self-check (disk, stuck videos, failed steps, backup age) that alerts, Docker `HEALTHCHECK`, log rotation, a `healing` timeout. This is what makes the two-year-unattended scenario survivable.
3. **Fix the docs drift** (all in the nitpicks appendix — one sitting) and adopt the docs-verification habit, because the docs are the maintenance runtime for everything else.
4. **Put `editor/` and `player/` under the quality gates** (Biome, typecheck scripts, CI build), and make the dev-mode fallback fail loudly in production.
5. **Close the backup edges** (`chapters.json`, the restore-doc mismatch) and rehearse one restore end-to-end.

Everything else in this review — the store re-layering, the pipeline containment, the app's test seams and de-duplication, the client-package merge, the static-export note — is opportunistic: right to do, wrong to schedule. The system works, and the correct posture for a working single-user system is to fix the things that fail silently first and improve the things that fail loudly at leisure.

## Post-review notes (2026-07-29)

Recorded after discussing the review:

- The admin panel's CDN-loaded scripts (htmx, highlight.js, Google Fonts in the cover tool) are **deliberate policy**, not an oversight: external dependencies are acceptable on admin-only surfaces (an outage only affects Danny, who can fix it) and unacceptable on the public viewer surface (hence the vendored Vidstack player). Section 8's closing question is answered.
- The findings were spun into GitHub issues #57–#66, one per work stream, sequenced so CI hardening (#57) lands first and the post-processing restructure (#63, which absorbed the non-watermark parts of #5) lands before the audiolab audio chain is ported.
- The per-subsystem agent reports in `docs/tasks-todo/temporary/review/` are kept until the closeout issue completes, then deleted.

## Nitpick triage (2026-09-05, #66 phase 1)

Every appendix item below was re-verified against the code after #57–#65 landed. The outcome, in three buckets:

**Already fixed (~95 of ~120).** The docs-drift list went 14/14 (via #58), the macOS app list was almost entirely absorbed by #65, and the frontend/CI lists by #60/#64/#57. A few items were themselves stale — e.g. `project.yml` already documents the Swift 6 deferral, and the review's own extension list for `RecordingActor` was out of date.

**Fixed in the closeout branch.** Run-lock guards on `cleanupStaleFiles` and `permanentlyDeleteVideo`; the two VTT formatters (which had *diverged further* — storyboard's could emit an invalid `:SS.1000` timestamp) merged into `format.ts`; transcript upsert no longer clobbers `createdAt`; `thumbnails.ts` moved onto the shared `spawnFfmpeg` helper (two of its spawns had undrained stdout pipes) and the helper now logs argv on any failure; the api module's error handler uses `apiError` with a real `ErrorCode.CONFLICT`; the three lenient `edits.json` loaders became `readEditsLenient` in `edl.ts`; thumbnail-upload validation deduplicated; `visibilityIcon` single-sourced; the `?t=` deep-link script and EmbedPage's clock/logout SVGs deduplicated; `EDITOR_MIN_DURATION` imported by the registry; `reconcile`'s trashed lookup simplified; `--brand-white` replaced by a new `--color-danger-fg` token and `.thumbnail-candidate__promote` generalised to `.btn-plain`; `admin.css`'s deliberately-unversioned link explained in place; `cdn.ts` gained tests pinning the purge path lists; shellcheck added to CI; the FTS second-migration-path, `recordingHealth` open-string, and test-utils chdir-concurrency constraints documented.

**Rejected, deliberately.** FTS sanitiser strips rather than escapes operators (safe-by-construction beats edge-case recall on `C++`); `setVideoStatus`/`markVideoReady` trashed-handling asymmetry (each matches its callers; no observed defect); maintenance-timer overlap guard (seconds-long sweeps, 24 h interval); unbounded `listEvents` (bounded in practice, single user); JPEG byte-compare for promoted-candidate detection (correct at personal scale; a sidecar adds state to migrate); `completeVideo` in prod code (documented test-only); the VideoFields field-triple refactor (opportunistic, per the review body itself); sort-arrow SVG string literals (constrained by living in an inline client script); the two text-extension lists (roles diverged: preview gate vs highlight map, graceful failure); editor `isDirty` double-stringify, waveColor hand-sync, transcript-span a11y (admin-only, negligible cost/benefit); `migrate()` without a pre-snapshot (HEALTHCHECK + daily self-check + nightly DB backup cover the crash-loop scenario); app CI (real, but a project with real costs — macOS runners — not a nitpick; decide separately).

## Appendix: Nitpicks

Small, concrete items collected during the 2026-07-28 architecture review. Each was found by a reviewing agent or the lead reviewer; a sample of the higher-impact ones were independently re-verified. These are deliberately *not* in the review body above — they're the "fix in an idle half-hour" pile, not the structural stuff. Items are grouped by area, roughly highest-value-first within each group.

Bigger structural findings live in the review body above.

## Docs drift

- `AGENTS.md` + `docs/developer/admin-editor.md` — both reference `lib/edit-pipeline.ts`, deleted in the pipeline unification. AGENTS.md points agents at a nonexistent file *before touching edit code*.
- `docs/developer/server-routes-and-api.md:16` + `server/src/app.ts:85-87` — both claim Hono prefers specific routes regardless of mount order. Verified false for the actual route shapes: the unconstrained `/:file` catch-all swallows `/feed.xml`, `/robots.txt`, `/sitemap.xml` etc. if the mounts are reordered. The ordering is load-bearing; the comment says it's decorative. Fix the comment/doc and add one integration test asserting a static site route resolves through `createApp()`.
- `docs/developer/server-routes-and-api.md:262` — says the video page "Uses Vidstack player (CDN-hosted via jsDelivr)". The player is self-hosted as of task self-host-vidstack.
- `docs/developer/streaming-and-healing.md` "Viewer" section — describes serving as "checks `data/<id>/derivatives/source.mp4` on each request. If present…", contradicting the (correct) "Serving is table-gated" bullet earlier in the same doc.
- `docs/developer/server-routes-and-api.md` — bills itself as complete but is missing ~12 admin routes and `PUT /api/videos/:id/words`, and still documents the old `/settings/keys` path.
- `app/LoomClone/CLAUDE.md:17` — lists 3 of `RecordingActor`'s 9 extensions; omits `+Prepare`, `+Stop`, `+SourceHealth`, `+Diagnostics`, `+FrameDiagnostics`, `+QualityHealth`.
- `docs/developer/recording-pipeline.md:127` — says `WriterActor` owns a `TimestampAdjuster` that applies the pause accumulator; all retiming lives in `RecordingActor` and the writer is a pure sink (its own comment says so).
- `docs/developer/recording-pipeline.md:102` — says the PiP circle composites "in bottom-right corner"; it's a draggable four-quadrant `PipPosition`.
- `docs/developer/admin-editor.md:33-61` — project structure omits `cover/`, `cover.html`, `main-cover.tsx` and the second Vite entry entirely; keyboard table omits `D` (delete cut); two-terminal dev flow doesn't mention that a stale `public/editor/` build silently disables HMR.
- `server/CLAUDE.md:64` — "a deploy must never depend on the npm registry being up" is not true today; `server/Dockerfile:11` and `:18` both run `bun install` at deploy build.
- `server/src/app.ts:29` — module-layout comment still lists `site — … /data/* (open, drops in 6.5)`; `/data/*` routing is long gone and "6.5" is a dead task reference. Same dead phase references: `server/src/lib/file-serve.ts:8-10` ("Phase 6.5"), `server/src/lib/errors.ts:26` ("added in 6.13"), `server/src/index.ts:26-28` ("until task-x3 lands HTTPS termination" — Caddy TLS landed long ago).
- `app/LoomClone/Capture/ScreenCaptureManager.swift:122-123` — doc comment mentions a "4K preset" that doesn't exist.
- `app/LoomClone/Pipeline/RecordingActor+SourceHealth.swift:9-11, :20` — comments say the health check "runs on each metronome tick"; it runs on the separate 2 Hz health task.
- `app/LoomClone/Helpers/HALInputLatency.swift:6-11` — doc says the latency value is subtracted from audio PTS; it's recorded for diagnostics only and never applied.

## Server — small correctness items

- `server/src/lib/cdn.ts:26-30` — `purgeVideo` purges `/${slug}/*` but not the bare `/${slug}` page (the URL people actually share) nor the dotted variants (`/${slug}.json`, `.md`, `.mp4`). `purgeTag` two functions below documents exactly this wildcard hazard and handles it. Metadata edits can stay stale at the CDN until natural expiry. Verified.
- `server/src/lib/store.ts:63-91` — `RESERVED_SLUGS` doesn't include `oembed`, a live top-level route; a video/tag with that slug would be permanently shadowed. Verified.
- `server/src/lib/cleanup.ts:111` — the stalled sweep only covers `status = "recording"`; `healing` has no timeout and no owner (see the review body). Related: `api/videos.ts:265` healing branch of `/complete` lacks the idempotency guard its sibling `markFootageComplete` has; the "needs attention" filter (`store.ts:405-415`) omits `healing`.
- `server/src/lib/cleanup.ts:26-104` — no `hasActiveRun` check before deleting HLS; a concurrent from-HLS rebuild could lose its input mid-run. Same gap in `permanentlyDeleteVideo`.
- `server/src/lib/store.ts:523-535` — title-sort cursor compares `videos.title > ''`; NULL titles yield NULL and untitled videos silently vanish from page 2+ of a title-sorted dashboard.
- `server/src/lib/store.ts:512-521` — `duration-asc` cursor's third OR branch is dead (implied by the second), and the "nulls sort last in asc" comment is backwards for SQLite.
- `server/src/views/viewer/TagPage.tsx:188` — `<img src={poster}>` renders unconditionally; posterless videos show a broken image on tag pages. Verified.
- `server/src/routes/admin/index.tsx:50` — the `no-store` middleware is registered *after* the login routes, so `/admin/login` responses never get it; the comment claims it covers "any admin response". Verified (low risk — CDN bypasses `/admin` — but the comment is wrong).
- `server/src/routes/site/well-known.tsx:59-64` — the root `/` redirect is the only site route with no `Cache-Control`; Bunny's 30-day default applies.
- `server/src/routes/admin/videos.tsx:130, 202, 223, 244` — PATCH handlers skip `requireVideo`, unlike every sibling GET partial.
- `server/src/routes/admin/videos.tsx:292-302` — the file-browser path check is the codebase's only denylist (`includes("..")`) rather than an allowlist; also hardcodes `"data/"` instead of `DATA_DIR` + `join()` (`:295-298, :401`), which `server/CLAUDE.md` explicitly warns against.
- `server/src/routes/site/oembed.ts:13, 24, 27` — error bodies omit `code`; non-numeric `maxwidth`/`maxheight` yields `NaN` in the response.
- `server/src/lib/search.ts:122-129` — `sanitizeFtsQuery` strips rather than escapes FTS5 operators (`C++` → `C`).
- `server/src/lib/store.ts:629` vs `:682` — `setVideoStatus` excludes trashed videos, `markVideoReady` includes them; a trashed video throws in one and succeeds in the other.
- `server/src/index.ts:43-46` — daily maintenance has no overlap guard and no manual trigger; a long `cleanupStaleFiles` could in principle overlap its next tick.
- `server/src/lib/events.ts:43-49` — `listEvents` has no limit; fetches every event ever logged for a video.
- `server/src/lib/vite-manifest.ts:54` — editor manifest is `existsSync` + `readFileSync` + `JSON.parse` on every page request (`playerAssets()` caches; this doesn't). `:76` — an unknown entry name silently falls back to `src/main.tsx` instead of throwing.

## Server — consistency & duplication

- `server/src/lib/processing/pipeline.ts:266, 551, 583` — three `catch { /* DB may be gone in tests */ }` blocks in production code; the test-lifecycle problem they paper over is what `_drainInFlight` exists for.
- ffmpeg invocation is 80% consolidated: `derivatives.ts:343, 430, 585` re-run `Bun.which("ffmpeg")` despite a cached lookup at `:27`; `edit-render.ts:102` keeps a second independent path cache; `thumbnails.ts:152` looks it up per candidate frame; `thumbnails.ts:156-175` and `storyboard.ts:234-248` use raw `Bun.spawn` (unbounded output buffering) instead of the shared bounded-stderr helper. Nothing logs argv on failure — a 3-line fix with outsized debugging value.
- `server/src/routes/admin/editor.ts:14` / `cover.ts:7` — byte-identical `escapeAttr` (neither escapes `>` or `'`); both hand-build full HTML documents as strings, bypassing `RootLayout`, with unversioned `app.css` links (`editor.ts:53`, `cover.ts:43` — the only two in the codebase).
- Three copies of "load edits.json defensively": `routes/videos/media.ts:127-166`, `routes/admin/media.tsx:59-93`, `routes/admin/chapters.ts:28-42`.
- `server/src/routes/videos/metadata.ts:14` — `DOWNSCALE_HEIGHTS` hardcodes `[1080, 720]` while `resolve.ts` imports `VARIANTS`; the comment admits the mirror.
- `server/src/lib/cleanup.ts:86` — a third independent spelling of the segment-filename regex.
- Two identical VTT timestamp formatters: `chapters.ts:167-196` and `storyboard.ts:32-39`. Storyboard threshold is `MIN_DURATION` in `storyboard.ts:9` and a literal `60` in `registry.ts:254`.
- `server/src/lib/search.ts:15-28` — `setupFts()` is a hand-rolled drop-and-recreate migration running on every startup, outside `drizzle/`, unmentioned in `server/CLAUDE.md`.
- `schema.ts:8` / `format.ts:4` — `nowIso` defined twice, no note why. `schema.ts:60` — `recordingHealth` is bare text with no enum, unlike every neighbouring constrained column.
- `tags.ts:57, 120, 128` — bare `Error` for validation failures in a module that uses `ValidationError` elsewhere. `ValidationError`/`ConflictError` live in `store.ts:31-45` while `errors.ts` is where a reader looks.
- `server/src/routes/api/index.ts:30-38` — builds error bodies by hand instead of `apiError()`, contrary to `server/CLAUDE.md`.
- `server/src/routes/admin/videos.tsx:422, :448` — `add-candidate` and `upload` are the same handler twice.
- `thumbnails.ts:284-303` — promoted-candidate detection byte-compares full JPEGs on every admin page load; a sidecar id would be cheaper and unambiguous.
- `registry.ts:195` — `edited_output.run` mutates `ctx.duration` in place as a side channel to later steps' `appliesTo`.
- `reconcile.ts:39` — loads `includeTrashed: true` then immediately returns if trashed.
- `storyboard.ts:223-226` — `StoryboardParams` and `EditorStoryboardParams` are identical type clones.
- `store.ts:1094` — `videoTranscripts.createdAt` is overwritten on every upsert; functionally `updatedAt`.

## Server — dead code / vestiges

- `steps-store.ts:143-145` — `markStepPending` has no callers; its comment describes a removed call site.
- `store.ts:126-132` — `checkSlugAvailable`'s string-or-object "back-compat" signature has exactly two call sites, both in-repo.
- `store.ts:700-712` — `completeVideo` documented as used by "admin tooling"; no admin tooling calls it.
- `url.ts:48-55` — `urlsForSlug` unused outside its own test. `tags.ts:219-222` — `renameTag` aliases for callers that don't exist.
- `server/src/views/viewer/TagPage.tsx:205` — `tagCanonicalUrl` exported, unused.
- `server/src/views/admin/components/Icons.tsx:94, 214` — `IconFilter`, `IconEye` unconsumed.
- `server/public/styles/components.css` — a permanently-empty placeholder in the `app.css` import chain.

## Views & CSS

- `VideoFields.tsx` (378 lines) + `admin/videos.tsx` — four near-identical copies of the display/edit/PATCH field triple; `ApiKeysPane.tsx` shows the parameterised pattern to copy. ~200 lines deletable.
- `EmbedPage.tsx:159-178` vs `VideoPage.tsx:256-275` — the `?t=` deep-link script duplicated verbatim. `EmbedPage.tsx:133-148` — hand-inlined clock SVG duplicating `ClockIcon` from the same directory.
- `Icons.tsx:508` and `DashboardPage.tsx:62` — identical `visibilityIcon` switch twice. `DashboardPage.tsx:278-279` — sort-arrow SVGs as string literals in an inline script, duplicating existing icons. `:263` — `dangerouslySetInnerHTML` where viewer pages use `raw()`.
- `viewer/icons.tsx:2-3` — the "don't pull in the larger admin icon set" rationale is client-bundle reasoning applied to server-rendered SVG; there is no bundle.
- `AdminLayout.tsx:66-85` — logout icon inlined raw instead of an `Icons.tsx` export. `:45-46` — `app.css` via `staticUrl()`, `admin.css` via bare path; correct but unexplained.
- `admin.css:959, 1941` — `var(--brand-white)` in component CSS, against `design.md` rule 1. `ThumbnailPicker.tsx:31` — `.thumbnail-candidate__promote` is the exact one-off BEM class `design.md` lists as an anti-pattern (its `__delete` sibling was already fixed).
- `VideoDetailPage.tsx:328-339` vs `routes/admin/videos.tsx:281-290` — two separately-maintained "which extensions are text" lists.
- `VideoActions.tsx:39` — hand-rolled two-layer escaping to embed HTML in `onclick`; `data-*` + `dataset` is the codebase's own pattern.

## Editor & player sub-projects

- Neither `editor/` nor `player/` is covered by Biome, `tsc`, or CI (see the review body — promoted to a structural finding). Their strict tsconfigs (`noUncheckedIndexedAccess`) are decorative; no `typecheck` script exists in either `package.json`.
- `editor/bun.lock` vs `player/bun.lock` — `vite@6.4.2` vs `6.4.3`; duplicated tooling drifting already.
- `server/src/routes/admin/cover.ts:40-42` — Google Fonts `<link>` on an admin page; `editor/src/cover/export.ts:141` fetches `fonts.googleapis.com` at export time with a remote `@import` fallback — in a project that self-hosts its player precisely to avoid third-party CDN dependence.
- `editor/src/cover/preview/Footer.tsx`, `Avatar.tsx:31`, `QrCode.tsx:72` — author name/avatar hardcoded; `site-config.ts` already owns both.
- `editor/src/App.tsx:75-89` — `useMemo` whose deps are new objects each render; never memoizes, rebinds the keydown listener every render.
- `editor/src/hooks/useEdl.ts:199` — `isDirty` runs two `JSON.stringify` per render (~60×/sec during playback). `:92-101` — `updateEdit` exported, never called. `useChapters.ts:145-154` `loading` and `useVideoPlayback.ts:92-106` `play`/`pause` returned, never consumed.
- `editor/src/components/Waveform.tsx:245` — `eslint-disable` in a project with no ESLint. `:175` — `waveColor: "#ff7369"` hand-syncs `--color-accent`; read the computed property. `:348` — container `onDoubleClick` also fires over existing cut regions.
- `editor/src/components/TranscriptOverlay.tsx:76-91` — clickable `<span>` with no role/tabIndex/key handler (`Timeline.tsx:231` does it correctly with `<button>`); every word span re-renders per rAF tick.
- `editor/src/cover/**` — single-quoted, differently-ordered imports vs the double-quoted rest.
- `server/package.json:16-18` — `npx vite` in a Bun project.
- `server/Dockerfile` — single-stage: `editor/node_modules` ships in the production image; `COPY . .` before the editor build invalidates its install layer on any source change.
- `.github/workflows/deploy.yml` — no editor build check, and nothing verifies committed `public/player/` still matches `player/src/`.

## macOS app — duplication & divergence

- `RecordingCoordinator+Lifecycle.swift:222-259` vs `:391-431` — ~35 lines of duplicated post-stop handoff, *already diverged*: `stopRecording` restarts both previews (`:215-220`); `cancelRecording` and `handleTerminalRecordingError` restart camera but not mic (`:294-296, :387-389`). Nothing records which is intended.
- `RecordingActor.swift:471-520` — `updateExcludedApps()` duplicates `+Prepare.swift:360-406` `resolveExclusions()`; diverged on logging and short-circuiting.
- `+FrameHandling.swift:649-668` — keep-alive `screenAndCamera` branch is a verbatim copy of `compositeScreenAndCamera` (`:280-298`). `:97-114` — the same guard written out twice back-to-back.
- `+SourceHealth.swift:290-331` and `+Stop.swift:189-226` — three copy-pasted 14-line raw-writer blocks in each, differing only by writer/filename.
- `HealAgent` / `TranscribeAgent` — `startupWindow`, `apiClient`, and `markOrphaned` duplicated byte-for-byte (`HealAgent.swift:23, :33-36, :296-302` / `TranscribeAgent.swift:16, :27-30, :630-636`). `HealAgent.swift:333-341` — `SegmentPatch` shadows `RecordingTimeline.SegmentEntry`.
- `TranscribeAgent.swift:444, :590, :611` — three near-identical `uploadSuggested*` methods + `uploadWords`; one `putJSON` helper covers all four.
- `CameraCaptureManager.swift:395-417` vs `MicrophoneCaptureManager.swift:52-72` — verbatim session-observer installation.
- `MenuView.swift:462, :491, :516` — three hand-rolled copies of the orange-banner chrome; `:597-602` and `:686-691` — two near-identical fps-formatting statics in the same file.
- `AppDelegate.swift:138` vs `MenuView.swift:145` vs `KeyboardShortcutManager.swift:59` — three encodings of "can I record now?" that disagree about `.stopped`.
- `WriterActor.swift:309` / `HealAgent.swift:205` — `?? 4.0` hardcodes the segment interval away from `preferredOutputSegmentInterval`.
- `TranscribeAgent.swift:18` vs `TranscriptionModelStatus.swift:27` — WhisperKit model name duplicated with different prefixes.

## macOS app — smaller items

- `UI/RecordingPanelContent.swift:131-153` — `formattedTime` reads `coordinator.elapsedSeconds` in the parent body, re-rendering the whole toolbar 10×/sec; extract a leaf `RecordingTimerLabel` exactly as was done for `ChapterMarkerButton` directly below. Verified.
- `+Stop.swift:160-170` — the no-videoId fallback hands `scheduleTranscription(videoId: "", localDir: "/")` to the agent, which then probes `/audio.m4a`.
- `+Metronome.swift:98` — `continue` without sleeping; would busy-spin if it ever fired while recording.
- `RecordingCoordinator+Lifecycle.swift:508-515` — `startTimer`'s guard makes the loop immortal if the coordinator deallocates (sleeps at 10 Hz forever instead of breaking).
- `RecordingCoordinator.swift:105-111` — `modes.first!` after an `isEmpty` guard; `if let` avoids the force-unwrap.
- `CompositionActor.swift:67-70` — `fatalError("Metal not available")` at init while the identical rebuild-time failure (`:286-292`) is handled gracefully.
- `AppDelegate.swift:181` — logs the full share URL; `+Stop.swift:153-155` explicitly avoids that for privacy.
- String-typed enums compared by literal: `+FrameHandling.swift:178` (`CompositeDecision.branch`), `+Diagnostics.swift:44-61` (`MetronomeTickAction`), `RecordingActor.swift:54` (`rawWriterFailureReported` magic strings), `+Stop.swift:61-77` (task group keyed on strings with `default: break` — a typo silently drops a writer's finish result).
- Raw `print()` instead of `Log.*`: `+Diagnostics.swift:659, :672, :674`; `CameraCaptureManager.swift:176, :181` — invisible to `LogExtractor` and Console.app in release.
- `TranscribeAgent.swift:357, :400, :481` — `guard #available(macOS 26, *)` is unreachable-false given deployment target 26.0.
- Dead code: `UploadActor.swift:33-45` (`isReachable`/`hasPendingUploads`, "future UI"), `:188-194` (no-arg `drainQueue`), `:321` (`CompleteResponse.path`, also `HealAgent:425`); `APIClient.swift:82-84` (`optionalURL`); `Helpers/Logging.swift:27-29` (`LoomLogger.debug`); `+Diagnostics.swift:151-155` (`cameraOnlyRepeatBranch`, permanently-zero, threaded through five structures); `RecordingContextBuilder.swift:63-67` (parameters taken and discarded).
- `RecordingActor.swift:607-611` — `extension WriterActor` declared at the bottom of `RecordingActor.swift`.
- `WriterActor.swift:217-225` — `pause(at:)`/`resume(at:)` ignore their parameter.
- `AppEnvironment.swift:55, :71` — duplicate `// MARK: - Server URL` headers.
- `LoomCloneTests/TimestampAdjusterTests.swift:7` — asserts a constant equals its own literal; no signal.
- `project.yml:12-14` — `argmax-oss-swift` (WhisperKit) pinned `from: "0.9.0"` on a pre-1.0 package — resolves to anything below 1.0.0. The app's only third-party dependency deserves an exact pin.
- `project.yml:23` — `SWIFT_VERSION: "5"` with strict concurrency complete; the Swift 6 language-mode migration is deferred but undocumented (~8 `@unchecked Sendable`/`nonisolated(unsafe)` sites).
- `playable.ts:20-23` — (server, but found late) the ±2s-or-2% tolerance is a tuned constant with no rationale comment in a file otherwise dense with them.

## CI, Docker & ops

(The structural items — the ffmpeg-less CI, the missing alerting, backup gaps — are in the review body. These are the smaller ones.)

- `.github/workflows/deploy.yml:6` — `paths: ['server/**']` excludes the workflow file itself; a broken edit isn't caught until the next server change.
- `.github/workflows/deploy.yml:3-7` — no `pull_request:` trigger, so PRs (CodeRabbit is configured for them) get no test signal.
- `.github/workflows/deploy.yml:15` — `oven-sh/setup-bun@v2` with no `bun-version`; CI tests a different Bun than production runs.
- `.github/workflows/deploy.yml:46` — `docker image prune -f` doesn't touch build cache; add `docker builder prune -f --filter until=168h`.
- `server/Dockerfile:1` — `oven/bun:1` floating tag; the production runtime version is whatever the build cache holds, unrecorded. `:3-5` — unpinned apt `ffmpeg` (the audio chain depends on specific filter syntax). No `USER` (runs as root, root-owned files on the bind mount). No `HEALTHCHECK`, despite `/api/health` existing for exactly this.
- `server/docker-compose.yml` — no `logging:` config; the default `json-file` driver never rotates.
- `server/docker-compose.prod.yml:18` — `BUNNY_CDN_API_KEY=${BUNNY_CDN_API_KEY}` is redundant with `env_file` and silently resolves to empty if interpolation fails — disabling all CDN purging with no signal. `:17` — `PUBLIC_URL` hardcoded here while `deployment.md` also says to set it in `.env` (the `.env` value is inert).
- `docs/developer/backup-and-restore.md` — "What gets backed up" omits `edits.json` and `words.json` (which `backup.sh:99-103` does back up); the restore loop copies only 3 of the 5 backed-up files; "you may need to trigger `scheduleDerivatives` per video" is left unresolved at the exact point a real recovery would stall.
- `docs/developer/deployment.md:56` — "~40 seconds" is now ~55s; no rollback section exists anywhere.
- `server/src/test-utils.ts:23` — `process.chdir`-based isolation breaks under concurrent test execution; the constraint is undocumented.
- `server/src/lib/cdn.ts` — no test file; a malformed purge URL fails soft forever with no signal. `registry.ts` — largest untested lib file; no direct test of the step table's own invariants.
- `package.json` (repo root) — a lone `media-icons: ^0.10.0` with its own lockfile and `node_modules/`; dead weight from the pre-self-hosted-player era.
- `app/project.yml:11-13` — no tracked `Package.resolved` (xcodeproj is gitignored), so the Swift dependency graph is unpinned on a clean checkout.
- `app/` — no CI at all; `make test` exists but nothing invokes it automatically.
- `server/scripts/backup.sh` — no shellcheck in CI and no test; it's the only thing standing between a disk failure and total data loss.
- `server/src/db/client.ts:33` — `migrate()` runs unconditionally at boot with no pre-migration snapshot; a bad migration crash-loops with no alert.
- `server/src/lib/processing/` — no retry anywhere; a transient ffmpeg failure parks a video in `processing_failed` until someone opens `/admin`.
- `server/data/` (local) — several orphaned video dirs containing only an empty `thumbnail-candidates/`; nothing cleans them up.
