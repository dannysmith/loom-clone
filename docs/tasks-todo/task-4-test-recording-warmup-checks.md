# Task 4 (optional): Test Recording & warmup validation

https://github.com/dannysmith/loom-clone/issues/44

Fourth and **optional** task from #44. The first three make failures diagnosable (task 1), visible (task 2), and ideally rarer (task 3). This one is preventative-by-choice: give the user a way to **validate the real pipeline before a long or important recording**, so they don't discover a problem 40 minutes in.

Worth doing only if, after tasks 1–3, the user still wants a pre-flight confidence check. If task 3 makes the meltdown rare enough, this may not be worth building — hence optional, and last.

## The core tension (why this is opt-in, not automatic)

#44 floats two related ideas: extending the existing warmup window to validate, and a dedicated "Test Recording" button. They're the **same mechanism** — run the real capture + composition + writers, watch the same counters task 2 watches, report problems — at different durations and triggers. The design constraint is sharp and pulls against putting it in the default path:

- **Speed is a core product value.** Per `AGENTS.md`, the dominant use case is quick Slack-replacement videos where "speed of recording and sharing is everything." Adding seconds of mandatory validation to *every* start would damage the main use case to protect the rare one. So validation must be **opt-in**, never on the default start path.
- **The failure is intermittent.** The CMIO meltdown (#30) is bursty — a clean 3-second probe **cannot guarantee** a clean 40-minute recording. So this is a *confidence* tool, not a *guarantee*. The UI copy must say so honestly ("looks healthy" not "you're safe"), or it'll breed false confidence.

The user already reached this conclusion in #44 ("not something I'd use before every recording, but… about to record a 40 minute long recording, I'd be happy to do this"). This task encodes that: a deliberate button for the high-stakes case, nothing forced on the quick case.

## Current state (what we build on)

- **Two-phase start.** `prepareRecording()` (slow: hardware bring-up, server session, first-audio wait) then `commitRecording()` (fast: anchor clock, start metronome) — `Pipeline/RecordingActor+Prepare.swift`, driven by the coordinator's countdown (`App/RecordingCoordinator+Lifecycle.swift`). There's already a window where hardware is warm but recording hasn't committed.
- **The probe already exists in pieces.** Task 2's windowed health signal (reject/no-source rate, cadence stability) is exactly what a test recording would evaluate. Task 4 mostly *triggers* that machinery in a throwaway context and presents the result.
- **Local-only writes.** The recordings bundle is already local (`AppEnvironment.recordingsDirectory`); a test recording can write to a temp/throwaway bundle and delete it, never creating a server session.

## Design sketch (pin at implementation time)

### Option A — "Test Recording" button (the main idea)

A button (in the popover, near the source selectors) that runs the **full real pipeline** — selected sources, real composition, real writers (composited HLS + raw) — for ~5 seconds into a **throwaway local bundle**, with **no server session** created and nothing uploaded. Then:

1. Run task 2's windowed health analysis over the probe's counters.
2. Optionally also extract the CMIO log slice (task 1's script) for those 5 seconds and scan for `-12743` floods — the most direct signal of a meltdown in progress.
3. Report a concise verdict: healthy / degraded, with the offending signal (e.g. "Camera delivering 22fps vs 30 expected; CMIO synchronizer errors detected — try reconnecting the camera"). Where the problem is a recognizable config issue (e.g. a framerate mismatch), suggest the fix.
4. Delete the throwaway bundle.

Key correctness point: the probe must use the **exact** capture/composition/writer configuration the real recording will use (same preset, same fps, same raw-writer shapes), or it isn't testing the thing that fails. Reuse the real `prepareRecording` path with a "discard" flag rather than a parallel simplified path.

### Option B — warmup-window validation (lighter, secondary)

Use the **existing** prepare/countdown window: once hardware is warm (during the 3-2-1 countdown), evaluate the first fraction of a second of real frames for an obvious immediate failure (a `-12743` flood the moment the session starts, zero frames, wildly wrong cadence) and surface a pre-commit warning. This is cheaper (no extra time — it overlaps the countdown already shown) but weaker (sub-second sample, can't catch a meltdown that starts later). Could ship as a subset even if Option A doesn't.

The "actually start capture + writers for ~3s and monitor before truly starting" idea from #44 sits between A and B — it requires "jiggery-pokery to ensure that initial test bit isn't part of the streamed recording." Option A's throwaway-bundle framing is the clean way to get that property: it's a *separate* recording that's discarded, not a prefix of the real one.

## Open questions for implementation

- Does Option B (warmup validation) provide enough value on its own to skip Option A? Decide after tasks 1–3 reveal how often/early the meltdown actually starts.
- Where does the verdict surface — popover inline, or a small sheet?
- Should a failed test offer the "rebuild capture session" recovery (same as the preview watchdog) inline? (No device-reset API — same caveat as tasks 1–3.)

## Out of scope

- Any mandatory validation on the default start path (explicitly rejected — speed).
- Guaranteeing a recording won't fail (impossible for an intermittent fault — this is confidence, not a guarantee).

## Files likely touched

| Concern | File |
|---|---|
| Throwaway probe run (reuse real prepare path w/ discard flag) | `Pipeline/RecordingActor+Prepare.swift`, `Pipeline/RecordingActor.swift` |
| Trigger + verdict UI | popover view in `UI/`, `App/RecordingCoordinator.swift` |
| Warmup-window check (Option B) | `App/RecordingCoordinator+Lifecycle.swift`, `Pipeline/RecordingActor+Prepare.swift` |
| Health analysis (shared with task 2) | task 2's windowed-signal helper |
| Doc update | `docs/developer/recording-pipeline.md` |
