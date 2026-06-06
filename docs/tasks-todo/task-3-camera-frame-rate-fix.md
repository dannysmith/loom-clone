# Task 3: Camera frame-rate handling — fix the UVC CMIO meltdown without regressing other cameras

https://github.com/dannysmith/loom-clone/issues/30 (primary)
https://github.com/dannysmith/loom-clone/issues/44 (parent)

Third of four tasks from #44. Originally framed as an *investigation* (which of #30's hypotheses is true). **That investigation is now resolved** — task 1's forensics (#44) gave a definitive diagnosis on 2026-06-06. This doc is now the **fix**: make the failure stop happening, robustly, across every camera/mode/rate combination — taking the best of the historical work rather than blindly reverting any of it.

## The diagnosis (resolved — full writeup on #30)

Five test recordings (4 debug/Xcode + 1 detached **Release** build), ZV-1 over USB streaming, analysed via `os-log.ndjson` + the `NSUnderlyingError` walk:

- **It is hypothesis 2, not hypothesis 1.** Not H.264 engine contention. The discriminator is the **camera**: the ZV-1 at 720p melts down; the FaceTime camera at *higher* load (1080p) is pristine (0 `-12743`, perfect sync). Encoder contention would predict the opposite.
- **It reproduces in production**, not just Xcode — same `-12743` flood rate (~178/s) run detached as a signed Release build. The old #3 "debug-only / production clean" conclusion is overturned (corrected on #3).
- **The chain** (captured verbatim in the os-log):
  1. The ZV-1 advertises 30fps; we **lock the rate** (`activeVideoMin`+`MaxFrameDuration = 1/30`, `lockedRate=yes`).
  2. The hardware can't sustain it — CoreMedia: *"observing getting frames too slowly by a lot"* (~21–24fps actual).
  3. The locked **max** duration (a *floor* on frame rate) makes CMIO try to fabricate the missing frames, then choke: *"we are supposed to be repeating a frame, but we got source data"* → the `-12743` flood (tens of thousands).
  4. The camera PTS timeline goes corrupt (`monotonicity.rejected` with ~2s backward jumps) → A/V desync.
  5. The raw camera writer chokes and dies — top-level `-11800`, underlying `NSOSStatusErrorDomain -16364` (downstream symptom, not the cause).

So this is **not** a raw-writer problem and not an encoder problem — it's our **frame-rate lock forcing a UVC camera to fabricate frames it can't deliver**. The raw-writer death and the desync are both symptoms.

## How we got here — the regression (verified against git history)

The ZV-1 used to work. The capability got locked away by a later, well-intentioned change. Timeline:

| Date | Work | Effect on camera-rate handling |
|---|---|---|
| 2026-04-16 | `11a3b31` — original A/V-sync fix (`task-2026-04-16-1-av-sync`) | Locked min+max **only** when a conservative CMTime-*duration* check passed. The ZV-1 **didn't match** → left **unlocked at native rate → clean** (verified 349 frames in → 349 out). |
| 2026-05-10 | `b4cbb21` — 60fps (#20 / PR #25) | Parameterised by target FPS; added peek-with-repeat **upsampling** to hold fixed 60fps output with a 30fps camera. |
| 2026-05-11 | `82c1159` — cadence rework (#21 / task-21) | **Removed upsampling.** Output now tracks the active source's *real* delivery rate; `targetFrameRate` becomes "a budget, not a contract." Made the metronome **tolerant of under-delivering cameras** (honest VFR + keep-alive). |
| 2026-05-14 | `790d97b` — **#34** "Fix … discrete-rate UVC formats" | Replaced the conservative duration check with a **permissive rate-tolerance match** (`targetRateFits`, ±0.5fps). The ZV-1 now **matches** → gets locked to 30 → **meltdown returns.** |

The precise regression is the **match condition** in `#34`, not a min-vs-max change (both old and new code set min *and* max). The original lock was *accidentally protective*: its strict check failed to match the ZV-1, leaving it alone. `#34` treated "doesn't lock" as a bug (*"a user who sets 30fps expects 30fps"*) and made matching permissive — explicitly to lock more UVC cameras, including a real Cam Link discrete-format case. That is exactly what now pins the ZV-1 and fabricates frames.

**The irony:** `#21` had *already* made the lock unnecessary three days before `#34` re-hardened it. The lock's original job (#20) was fixed-rate output via upsampling — but `#21` abandoned fixed-rate output for "each mode's primary source drives cadence." The camera rate **never needs to be locked** for the composite case to work (below). `#34` re-added aggression to a now-vestigial mechanism, and it backfires on the one camera class that *advertises* a rate it can't *sustain*.

## Why the lock is (mostly) vestigial — the cadence model

Post-`#21`, **camera capture rate and output cadence are decoupled.** The output rate is set by the metronome from the active mode's *primary* source, not by what the camera hardware is pinned to:

- **screenAndCamera / screenOnly** → **screen** drives cadence. Pick 60fps and you get 60fps *screen* output; the camera is a *peeked* PiP overlay whose under-delivery is irrelevant — it was never going to hit 60 and doesn't need to.
- **cameraOnly** → the **camera** drives; output is honest VFR at whatever it actually delivers (~24fps for the ZV-1 is fine and stays A/V-synced *as long as the PTS timeline isn't corrupted by forced fabrication*).
- A mode-hopping recording is legitimately VFR per section — which is why the frame-rate-metadata task (#42) concluded the writer is *correctly* VFR and fixed it server-side (`-fps_mode passthrough`). See [[project_vfr_rframerate_truth]].

So forcing the camera to a minimum frame rate buys us nothing the cadence model needs, and costs us the meltdown.

## The constraint: do NOT regress what works

This is the whole point of the task — the robust solution, not a revert. Every one of these must still hold afterwards:

- **ZV-1 over USB streaming** (advertises 30, delivers ~24): no lock-induced fabrication → no `-12743` flood → honest ~24fps VFR, A/V synced. *(the fix)*
- **Cam Link 4K / HDMI sources** (#34's case — discrete-rate formats, source ~25fps): must still produce usable, synced output. Note `#34`'s "force to 30" likely *also* fabricates on a 25fps HDMI source — so "honest 25fps VFR" may actually be **better** here than the forced-30 it currently does. Verify on the real device; don't assume the forced path was correct.
- **Clean cameras (FaceTime, and cameras that genuinely sustain their advertised rate)**: unaffected — they deliver their rate naturally with or without the lock.
- **60fps composite (camera + display both selected, 60fps target)**: still 60fps screen output; camera PiP at its native rate. Already handled by the cadence model — must stay handled.
- **cameraOnly with *only* a camera selected**: record at the camera's native rate.
- **The common real-world case** (per the user): even when recording in cameraOnly *mode*, **both** camera and display sources are usually selected so the user can hop between them mid-recording. So "cameraOnly mode" ≠ "camera is the only capture source" — the format-selection change must be correct regardless of which sources are *selected*, keyed off mode/use, not source presence.

## Recommended direction (settle specifics at implementation, on real devices)

The core move: **stop forcing a minimum frame rate on the camera** — i.e. stop setting `activeVideoMaxFrameDuration` (the floor that triggers fabrication). Let the camera run at whatever it sustains; the metronome (`#21`) already produces the correct output cadence from there.

- **Drop the frame-rate floor** (`activeVideoMaxFrameDuration`). This is the surgical change that removes the meltdown trigger while leaving the cadence model intact.
- **Keep `activeVideoMinFrameDuration` as an optional *ceiling*** only where it's useful (e.g. stop a 60fps-capable camera burning bandwidth when the target is 30) — a ceiling never forces fabrication, so it's safe. Decide whether it's even worth keeping.
- **Preserve `#34`'s discrete-format *matching*** (the rate-tolerance + discrete-range logic) for deciding *what format/rate to request* — just don't translate a match into a hard floor. The bug `#34` fixed was real; the harm was coupling "the format supports 30" to "force the camera to never drop below 30."
- **Policy on advertised-but-unsustainable rates:** don't force them. Surface reality instead — the preview badge (task-1 Part 3) already shows measured-vs-target fps before recording, and task 2 will warn if delivery degrades mid-recording. Honest VFR + visibility beats forced fabrication.
- **Open question for impl:** is a brief capability probe (measure actual delivered rate during warmup, back off any lock if the camera under-delivers) worth the complexity, or is "never set the floor" sufficient on its own? Lean toward the simpler option unless device testing shows a camera that genuinely needs nudging up.

Also fold in the now-stale docs: `app/LoomClone/CLAUDE.md`'s "Camera format selection" paragraph still describes the *original* min-only-when-in-range behaviour, which `#34` overrode — update it to match whatever this task lands on.

## Test matrix (verify with task-1 forensics)

For each row, run a 2–3 min recording (production build, detached) and check `os-log.ndjson` `-12743` count, `recording.json` `effectiveCameraFps` / `monoRejects` / `raw.writer.failed`, and watch-back A/V sync:

| Camera | Mode(s) | Target | Expected after fix |
|---|---|---|---|
| ZV-1 (USB streaming, 720p) | cameraOnly | 30 | ~0 `-12743`, effCamFps ~24, no raw-writer death, synced |
| ZV-1 | camera+display, mode hops | 30 | screen sections ~30fps, camera sections ~24fps, synced |
| ZV-1 | camera+display | 60 | screen sections ~60fps, camera PiP native, synced |
| Cam Link / HDMI source | cameraOnly + composite | 30 | no regression vs today; synced (likely honest ~25fps VFR) |
| FaceTime (built-in) | cameraOnly + composite | 30 / 60 | unchanged — clean |

The clean FaceTime baseline + the ZV-1 before/after are the regression guards. Keep the pre-fix recordings (the five from 2026-06-06) as the "before" reference.

## Definition of done

- ZV-1-over-USB recording produces **no `-12743` flood**, no `raw.writer.failed`, and is **A/V-synced** — confirmed against an `os-log.ndjson` from a production-build recording.
- Every row of the test matrix passes (no regression for Cam Link / 60fps-composite / clean cameras).
- `app/LoomClone/CLAUDE.md` "Camera format selection" and `docs/developer/recording-pipeline.md` updated to the new behaviour.
- A short note appended to #30 (and the issue closed if this resolves it).

## Out of scope

- Live degradation warnings (**task 2** — complementary; this task should make them rarely needed for the ZV-1, but task 2 still guards against *other* mid-recording degradation).
- Mid-recording source switching / device re-attach (#18).
- The H.264-contention remediations from #30's original hypothesis 1 (raw camera → ProRes, bitrate/resolution caps) — **not pursued**: the diagnosis ruled contention out as the cause. Keep them noted in #30 only as a fallback if a *different*, contention-shaped failure ever appears.

## Files likely touched

| Concern | File |
|---|---|
| Frame-rate lock (drop the floor; keep matching) | `Capture/CameraCaptureManager.swift` (`lockFrameRateIfSupported`, `bestFormat`, `configureDeviceFormat`) |
| Possibly: warmup capability probe | `Pipeline/RecordingActor+Prepare.swift` |
| Doc: camera format selection | `app/LoomClone/CLAUDE.md` |
| Doc: pipeline / frame flow | `docs/developer/recording-pipeline.md` |
| Reference: incident/decision record | `docs/archive/m2-pro-video-pipeline-failures.md` (note the diagnosis + decision) |
