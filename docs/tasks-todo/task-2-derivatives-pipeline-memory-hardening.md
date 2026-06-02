# Task 2 — Derivatives Pipeline Memory Hardening

## Background

On 2026-06-01 a ~23-minute recording OOM-killed the `bun` process in `loom-clone-server` mid-post-processing (6.7 GiB RSS on a 7.6 GiB host, no swap, no container limit). Full forensics are in [issue #40](https://github.com/dannysmith/loom-clone/issues/40). Two compounding causes:

1. A delayed heal-triggered second `/complete` started a **second full pipeline** while the first was still in memory (the in-memory `inFlight` dedupe had already cleared).
2. Audio loudnorm **pass 1 captured unbounded `info`-level ffmpeg stderr** into a single JS string for the duration of a multi-minute arnndn run.

This task lands the **permanent, architecture-independent memory-footprint reductions** — the changes that shrink the pipeline's resource use no matter how it's later orchestrated. They survive the Task 4 refactor unchanged.

### What this task deliberately does *not* fix

The **concurrency / dedupe** cause (cause 1 above) is **not** fixed here. Its proper fix is the `video_processing_steps` table + `reconcile` + skip-if-ready resumable pipeline in **Task 4**, which makes a re-entrant run a near-no-op and makes dedupe durable across restarts. Writing an interim dedupe guard or interim skip-if-output-exists now would be throwaway code that Task 4 replaces.

This is safe because **there is no recurrence window**: this is a single-user tool, no new long recordings will be made before all of Tasks 1–4 ship, so the OOM cannot re-fire in the gap. We optimise for the cleanest end state, not for a stop-gap.

Container/host blast-radius limits are handled separately — the container cgroup limit (`mem_limit`, `pids_limit`) is **Task 1**, and the host hardening (swap, sshd, Caddy `oom_score_adj`) has already shipped in `danny-vps-infra`. Neither has any bearing on this task. Frame-rate correctness is **Task 3**.

## Scope

**In:** per-step memory-footprint reductions in `server/src/lib/derivatives.ts`, `thumbnails.ts`, `peaks.ts`.

**Out:** skip-if-output-exists guards, persistent/heal-survivable dedupe (→ Task 4); container limits (→ Task 1) and host limits (shipped in `danny-vps-infra`); frame-rate handling (→ Task 3); the sidecar-worker / job-queue architecture (#40 Tier 3 — separate future decision).

## The fixes

### 1. Bound audio pass-1 stderr — the proximate leak

`derivatives.ts:484` spawns loudnorm pass 1 with **no** `-loglevel error`/`-nostats`, unlike pass 2 (`:516`) and the generic helper (`:45`). ffmpeg defaults to `-loglevel info`: filter-graph dump, per-filter init spew, and a progress line roughly every second of wall time. `new Response(pass1.stderr).text()` accumulates the entire stream into one JS string for the whole multi-minute arnndn run (and rope-grow reallocations can briefly commit well above the final size).

- Add `-loglevel error -nostats` to the pass-1 spawn.
- **Verify `parseLoudnormJson` (`:412`) still finds the measurement block at `error` level** — it scans for the last `{…}`, so it should survive, but loudnorm's `print_format=json` output is itself a log line and may be suppressed below `info`. Confirm empirically; if the JSON disappears at `error`, fall back to `-loglevel warning` (still bounded — no per-second progress lines).

### 2. Generalise bounded stderr capture for long-running spawns

Even at `error`/`warning` a pathological run can emit a lot, and several spawn sites still use `new Response(proc.stderr).text()` directly. Replace unbounded capture with a **rolling last-N-KB ring buffer** (64 KB tail is ample — error messages and the loudnorm JSON both live at the end) for the long-running spawns (audio passes, variant encodes). Cleanest shape: a shared `spawnFfmpeg()` helper that does bounded capture and is reused everywhere, rather than per-site fixes. Short/cheap spawns can route through the same helper for consistency.

### 3. Coalesce thumbnail extraction (14 ffmpegs → ~2)

`thumbnails.ts` extracts each candidate frame in a loop — one ffmpeg per timestamp (`:80`/`:100`) — then runs `signalstats` per candidate (`:156`): **14 ffmpeg processes for one video**. Each reserves pipe buffers and a `ReadableStream`-backed `Response`, layered on top of the audio chain.

- Collapse extraction into a **single** ffmpeg `select='eq(n,N1)+eq(n,N2)+…'` decode that emits all candidate frames in one pass.
- Reduce the per-candidate `signalstats` scoring to as few passes as practical (one `signalstats,metadata=print` pass over the selected frames, or score the already-extracted JPEGs).

### 4. Stream peaks PCM instead of buffering it whole

`peaks.ts:63` does `rawFile.arrayBuffer()`, loading the entire 8 kHz mono `s16le` PCM (~22 MB for a 23-min video) into one buffer late in the pipeline. Switch to streaming — `for await (const chunk of file.stream())` — and fold peaks incrementally over `Int16` windows. Modest in absolute terms, but it stacks at the pipeline tail where pressure is already highest.

### 5. Structured operational logging

The OOM diagnosis was *inferential* precisely because there was no per-step log to read. Add lightweight stdout logging (visible in `docker logs`) at:

- pipeline entry/exit, including `inFlight` insert/delete,
- per-step start/end (which step, which video, elapsed ms).

This is the cheap operational console layer. Task 4 adds **durable per-step event-log rows** on top (replacing the single terminal `derivatives_ready` event); this console logging is useful independently and stays.

## Verification

- Process a long (~20-min) recording and compare **peak bun RSS** before/after. Expect a clear drop, driven mostly by fix 1.
- Golden test: `parseLoudnormJson` still extracts a valid measurement from real ffmpeg output at the chosen log level.
- Thumbnail and peaks outputs unchanged (same selected frame / equivalent peaks array); existing derivative tests green.
