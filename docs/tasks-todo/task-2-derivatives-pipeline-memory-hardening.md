# Task 2 — Derivatives Pipeline Memory Hardening

## Background

On 2026-06-01 a ~23-minute recording OOM-killed the `bun` process in `loom-clone-server` mid-post-processing (6.7 GiB RSS on a 7.6 GiB host, no swap, no container limit). Full forensics are in [issue #40](https://github.com/dannysmith/loom-clone/issues/40). Two compounding causes:

1. A delayed heal-triggered second `/complete` started a **second full pipeline** while the first was still in memory (the in-memory `inFlight` dedupe had already cleared).
2. Audio loudnorm **pass 1 captured unbounded `info`-level ffmpeg stderr** into a single JS string for the duration of a multi-minute arnndn run. (Its *actual* byte volume was never measured — #40 lists it as an open question; our estimate is KB-scale, so treat cause 1 as the dominant driver and cause 2 as latent-risk hygiene. See Verification.)

This task lands the **permanent, architecture-independent memory-footprint reductions** — the changes that shrink the pipeline's resource use no matter how it's later orchestrated. They survive the Task 4 refactor unchanged.

### What this task deliberately does *not* fix

The **concurrency / dedupe** cause (cause 1 above) is **not** fixed here. Its proper fix is the `video_processing_steps` table + `reconcile` + skip-if-ready resumable pipeline in **Task 4**, which makes a re-entrant run a near-no-op and makes dedupe durable across restarts. Writing an interim dedupe guard or interim skip-if-output-exists now would be throwaway code that Task 4 replaces.

This is safe because **there is no recurrence window**: this is a single-user tool, no new long recordings will be made before all of Tasks 1–4 ship, so the OOM cannot re-fire in the gap. We optimise for the cleanest end state, not for a stop-gap.

Container/host blast-radius limits are handled separately — the container cgroup limit (`mem_limit`, `pids_limit`) is **Task 1**, and the host hardening (swap, sshd, Caddy `oom_score_adj`) has already shipped in `danny-vps-infra`. Neither has any bearing on this task. Frame-rate correctness is **Task 3**.

## Scope

**In:** per-step memory-footprint reductions in `server/src/lib/derivatives.ts` (bounded pass-1 stderr, the shared `spawnFfmpeg()` capture helper), `peaks.ts` (streamed PCM), and routing `suggested-edits.ts`' `runSilenceDetect` through the helper. Plus the operational logging (fix 5).

**Out:** thumbnail extraction coalescing (descoped — see fix 3: no peak-memory benefit, collides with Task 3); skip-if-output-exists guards, persistent/heal-survivable dedupe (→ Task 4); container limits (→ Task 1) and host limits (shipped in `danny-vps-infra`); frame-rate handling (→ Task 3); the sidecar-worker / job-queue architecture (#40 Tier 3 — separate future decision).

## The fixes

### 1. Bound audio pass-1 stderr — the unbounded-capture risk

`derivatives.ts:484` spawns loudnorm pass 1 with **no** `-nostats` and at the default `-loglevel info`, unlike pass 2 (`:516`) and the generic helper (`:45`), which use `-loglevel error`. ffmpeg's info-level output here is a one-time filter-graph dump plus a **progress line emitted roughly every ~0.5 s of wall time** — and that progress line is the only part that grows with the recording's (multi-minute) arnndn runtime. `new Response(pass1.stderr).text()` accumulates the entire stream into one JS string until the process exits (and rope-grow reallocations can briefly commit above the final size).

**The fix is `-nostats`, NOT a lower log level. Verified empirically (ffmpeg 8.1.1):**

| pass-1 flags | `loudnorm print_format=json` present? |
| --- | --- |
| `-loglevel error` | ❌ suppressed |
| `-loglevel warning` | ❌ suppressed |
| `-loglevel info` (default) | ✅ present |
| `-nostats -loglevel info` | ✅ present |

The loudnorm JSON measurement block is logged at **info** level. Dropping to `error` *or* `warning` deletes it — `parseLoudnormJson` (`:412`) then throws, `processAudio` throws, and the video ships **without loudnorm normalisation** (the error is caught and logged; the pipeline continues). So the original "add `-loglevel error -nostats`, fall back to `warning`" plan was wrong on both counts.

- **Add `-nostats` to the pass-1 spawn and keep `-loglevel info`.** `-nostats` removes the per-second progress line (the only unbounded-growth component); info level preserves the JSON.
- Fix 2's ring buffer then bounds whatever remains, belt-and-braces.
- Regression guard: the `processAudio` end-to-end test asserts output LUFS ∈ (−15, −13), so it *would* catch a vanished JSON — but it's gated on macOS `say` and runs only on the dev Mac, never on the Linux server/CI. Don't rely on CI to catch a log-level slip here; re-confirm `print_format=json` is present after the change.

### 2. Generalise bounded stderr capture for long-running spawns

Even with `-nostats`, a pathological run can emit a lot, and several spawn sites still use `new Response(proc.stderr).text()` directly. Replace unbounded capture with a **rolling last-N-KB ring buffer** (64 KB tail is ample — error messages and the loudnorm JSON both live at the end) for the long-running spawns. Cleanest shape: a shared `spawnFfmpeg()` helper that does bounded capture and is reused everywhere, rather than per-site fixes. Short/cheap spawns can route through the same helper for consistency.

**Hard constraint — the helper must NOT hardcode the log level.** Three callers parse **info-level** stderr and would break if the helper forced `-loglevel error`:

- loudnorm **pass 1** — the `print_format=json` block (see fix 1).
- `profileNoiseFloor` — the `volumedetect` `mean_volume:` line (`derivatives.ts:395`, already `-nostats -loglevel info`).
- `runSilenceDetect` — the silence ranges (`suggested-edits.ts:148`, `-nostats -loglevel info`; its code comment explicitly says keep stderr verbose).

So the helper bounds **capture** (ring buffer) while leaving **log level caller-controlled**. Each call site keeps passing the flags it needs.

**Long-running spawns to route through the helper:** audio pass 1 + pass 2, variant encodes (`:584`), and — not in the original list — **`runSilenceDetect` (`suggested-edits.ts:148`)**, which is a full-decode pass over the whole source at info level with unbounded `new Response().text()`, and runs *before* audio. Its byte volume is bounded by the number of detected silences (small in practice), but it's the same risk class and the same full-decode cost, so it belongs on the same helper. (`storyboard.ts` sprite/probe spawns and `edit-pipeline.ts:304` are lower-priority but can route through too for consistency.)

### 3. Thumbnail spawns — descoped from the memory rationale (optional spawn-count cleanup)

The original framing — "14 ffmpeg processes layered on top of the audio chain" — **does not survive inspection**, so this is no longer a memory fix:

- The 14 spawns run **strictly sequentially**: extraction is a `for`-await loop (`thumbnails.ts:80`), scoring is a sequential `for…of` (`:142`). Each process exits before the next starts.
- They run **after** audio processing has finished (`derivatives.ts` ordering: audio `:684`, thumbnails `:699`). They never coexist with the audio chain or with each other.
- So peak RSS during the thumbnail step is **one ffmpeg + one `Response` at a time** — coalescing buys ≈ **zero peak-memory reduction**. Its only payoff is fewer process spawns (CPU/latency), which isn't this task's goal.

And the obvious coalescing carries real regression risk:

- `select='eq(n,N)'` indexes by **frame number**. Converting a timestamp to a frame number needs the file's fps — which **Task 3 documents as wrong/VFR in exactly these files** → wrong frames selected. A correct version would have to select by **pts/time**, not frame number.
- A single `select` pass **fully decodes** the whole video, replacing today's fast `-ss`-before-`-i` keyframe seeks → likely *higher* wall time on a 20-min source.
- The verification goal "same selected frame" is then hard to honour exactly.

**Decision: drop the extraction-coalescing from this task** (no memory benefit, real regression surface, and it collides with Task 3's fps work). If a low-risk tidy is wanted, the only safe sub-step is collapsing the **scoring** passes — score the already-extracted JPEGs in one `signalstats` pass — but even that is optional and not memory-motivated. Revisit thumbnail spawn-count as its own cleanup if it ever matters, ideally *after* Task 3 lands the fps fix.

### 4. Stream peaks PCM instead of buffering it whole

`peaks.ts:63` does `rawFile.arrayBuffer()`, loading the entire 8 kHz mono `s16le` PCM (~22 MB for a 23-min video) into one buffer late in the pipeline. Switch to streaming — `for await (const chunk of file.stream())` — and fold peaks incrementally over `Int16` windows. Modest in absolute terms (~22 MB transient, and it runs at the tail well after the audio chain — it does not stack *with* audio), but it's the cheapest of the buffer-the-whole-file patterns to remove.

- To keep output **byte-identical**, derive `samplesPerPeak` from the raw file **size** (`rawFile.size / 2`), which is available without reading the bytes — don't depend on the in-memory array length the way the current code does.
- Mind chunk-boundary alignment: a 2-byte `s16le` sample (and a peak window) can straddle two `file.stream()` chunks. Carry a 1-byte remainder between chunks and bucket samples by a running index.

### 5. Structured operational logging

The OOM diagnosis was *inferential* precisely because there was no per-step log to read. Add lightweight stdout logging (visible in `docker logs`) at:

- pipeline entry/exit, including `inFlight` insert/delete,
- per-step start/end (which step, which video, elapsed ms).

This is the cheap operational console layer. Task 4 adds **durable per-step event-log rows** on top (replacing the single terminal `derivatives_ready` event); this console logging is useful independently and stays.

## Verification

**Set expectations correctly on the RSS number.** Issue #40's 6.7 GiB was dominated by the **concurrent double pipeline** (cause 1, deferred to Task 4) plus ~700 MiB of ffmpeg working set — and the pass-1 stderr volume is an explicitly *unmeasured* open question in #40. Back-of-envelope, the unbounded pass-1 string is tens-to-low-hundreds of **KB** over a multi-minute run, not GB. So **do not expect a dramatic single-run peak-RSS drop from this task** — fixes 1/2/4 remove a latent unbounded-growth risk and trim the baseline; the large RSS win comes from Task 4 (concurrency), and the floor that prevents host death is Task 1's cgroup limit (already shipped). A modest before/after delta is success here, not failure.

- First, **measure the actual pass-1 stderr volume** on a long source (run the pass-1 chain with stderr → a file, `wc -c`) — this settles #40's open question and tells us how much fix 1 actually saves.
- Process a long (~20-min) recording and compare **peak bun RSS** before/after. Expect a measurable-but-modest drop (see above), not a step change.
- **Golden / smoke test: `loudnorm print_format=json` is still present in pass-1 output after adding `-nostats` at info level**, and `parseLoudnormJson` extracts a valid measurement. (We verified the level dependence above; this guards against accidental regression.)
- Peaks output **byte-identical** to before; existing derivative tests green. (Thumbnails are untouched by this task per fix 3.)
