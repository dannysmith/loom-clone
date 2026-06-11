# Task 3: Camera frame-rate handling — fix the UVC CMIO meltdown without regressing other cameras

https://github.com/dannysmith/loom-clone/issues/30 (primary)
https://github.com/dannysmith/loom-clone/issues/44 (parent)

Third of four tasks from #44. Originally framed as an *investigation* (which of #30's hypotheses is true). **That investigation is now resolved** — task 1's forensics (#44) gave a definitive diagnosis on 2026-06-06. This doc is now the **fix**: make the failure stop happening, robustly, across every camera/mode/rate combination — taking the best of the historical work rather than blindly reverting any of it.

---

## ⚠️ REVISED DIAGNOSIS & OUTCOME (2026-06-10) — read this first

> Implementing the fix and validating against **real device recordings** corrected the diagnosis below. The original "frame-rate **lock** regression (#34)" framing is **wrong** — it was refuted by the data. Everything from "## The diagnosis" down is kept as historical context but is **superseded by this section.**

### What we shipped (landed, builds/tests/lint green; validated on-device)

1. **Ceiling, not floor.** `lockFrameRateIfSupported` → `capFrameRateIfSupported`: set at most `activeVideoMinFrameDuration` (a *ceiling* — "don't run faster than target"), **never** `activeVideoMaxFrameDuration` (a *floor*). Plus `shouldCapRate`: only apply the ceiling when the format has rate **headroom** (can run faster *or* slower than target). For a format **rate-locked to the target** (the ZV-1's sole discrete `30-30` USB format) set **nothing** — replicating the clean pre-#34 path.
2. **Camera raw-writer monotonicity guard** (`handleCameraFrame`): drop any camera frame whose retimed PTS doesn't strictly advance, counted as `cameraRawFramesSkipped`. Closes the `-16364` `camera.mp4` death — a corrupt feed now leaves the master *truncated-but-playable*.
3. NaN-safe diagnostic (`finiteSeconds`) now that we don't pin the max duration; docs in `app/LoomClone/CLAUDE.md` + `docs/developer/recording-pipeline.md`; unit tests for `shouldCapRate` / `targetRateFits` / `finiteSeconds`.

### Validation matrix (live recordings, 2026-06-09/10)

| Camera / path | Floor (from format) | Delivers | Meets floor? | `-12743` | Synced |
|---|---|---|---|---|---|
| FaceTime (built-in) | 30 | **35.8fps** | ✅ | 0 | ✅ |
| Cam Link 4K (ZV-1 over HDMI), 1080p30 & 1440p60 | **25** (format advertises 25-60) | ~26fps | ✅ | 0 | ✅ |
| **ZV-1 native USB**, all modes | **30** (sole format is `30-30`) | **~25fps** | ❌ | ~4–6k | ❌ |

### The actual root cause (refutes the "lock regression")

The meltdown is **not** caused by our lock, and **not** fixed by removing it. Proof: the final ZV-1 native-USB recording (`18975ff7`) ran with `didLock=False` (we set nothing) **and still melted** (5,640 `-12743`) — because selecting the ZV-1's sole discrete `30-30` format makes AVFoundation default `activeVideoMaxFrameDuration` to 1/30 regardless of what we do. **The 30fps floor is intrinsic to the only format the camera offers; there is no app-level lever to lower it.**

The single variable that separates clean from meltdown is **whether the camera meets its floor**:

- It melts **only** because the ZV-1 over native USB now **delivers ~25fps while advertising NTSC `30-30`** → 25 < 30 floor → CMIO fabricates the missing frames (`RepeatPreviousFrame` ×1,817, *"getting frames too slowly by a lot"*) → corrupt PTS → desync.
- FaceTime (delivers 35 ≥ 30) and the Cam Link (floor 25, delivers 26) **meet their floors**, so CMIO never fabricates — clean, *even with the same shared camera+mic session active* (confirmed: their `camera.mp4` files carry both tracks). **So the shared session is not the trigger either.**

### Why it worked before (answered from git + the original task)

The original A/V-sync task (`task-2026-04-16-1-av-sync`, recording `9c6e30bd`) recorded the **ZV-1 in NTSC mode delivering 29.97fps** — it *met* the 30 floor, so nothing was fabricated (349 frames in → 349 out, clean). The camera-format code then was **identical to what we ship now** (`activeFormat` set, duration lock skipped for the ZV-1 because the old CMTime check failed). Learning #5 from that task, verbatim: *"The Sony ZV-1 over USB advertises a single locked format. The fps is whatever the camera's region switch is set to (PAL = 25, NTSC ≈ 29.97) — it's a hardware menu setting."* **The camera's effective USB delivery rate has since dropped from ~30 to ~25** (USB bandwidth, cable/port, or a camera menu/firmware setting). That drop — not any code change — is what now pushes it below the floor.

### Conclusion

**The ZV-1 over native USB is a hardware limitation at its current ~25fps delivery**, not an app bug. No app-level fix exists: we can't lower a floor the camera's sole format pins at 30, and we can't make a bandwidth-starved USB camera deliver 30. The fixes we shipped are still worth it and validated:

- Every **other** camera (multi-rate / cameras that meet their floor) is clean and synced.
- The raw-writer guard keeps `camera.mp4` **playable** even during a full ZV-1 meltdown.
- Task 2's cadence warning fires on the live degradation (camera-agnostic safety net).

**Recommended user-side mitigations** (not code): check the ZV-1's frame-rate/region menu to coax a true 30 again, try a cleaner USB port/cable, or — proven clean — record the ZV-1 via **HDMI → Cam Link 4K** (its `25-60` format floors at 25, which it meets).

**Generalises to other USB cameras:** any camera whose *only* format is a single discrete rate it can't sustain will hit this same wall. It's structurally detectable (`shouldCapRate` already flags "rate-locked to target" formats) — a future pre-record "this camera may not sustain Nfps" hint is the natural follow-up; for now the task-2 warning covers it.

### Definition of done — revised

The original DoD ("ZV-1-over-USB produces no `-12743` flood … A/V-synced") is **not achievable in software** and is retired. The achievable, shipped bar:

- No regression for multi-rate / floor-meeting cameras (Cam Link ×2, FaceTime) — **met**.
- `camera.mp4` no longer dies on a corrupt feed (raw-writer guard) — **met**.
- ZV-1-over-USB documented as a hardware limitation with user-side mitigations + HDMI path — **this section**.
- `#30` updated with the corrected diagnosis.

---

## The diagnosis (resolved — full writeup on #30) — ⚠️ SUPERSEDED, see revised section above

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

## How we got here — the regression (verified against git history) — ⚠️ SUPERSEDED

> The "#34 lock regression" theory below was **refuted on-device** (the ZV-1 melts even with `didLock=False`). The real cause is the camera's USB delivery dropping below the floor its sole format pins at 30 — see the revised section at the top. Kept for history; the git timeline itself is accurate, only the causal conclusion was wrong.

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

## Defence-in-depth: stop blindly trusting the camera clock

The rate-unlock above is the **primary** fix — it removes the *trigger* that corrupts the camera's capture-PTS for the ZV-1. But the durable, camera-agnostic learning from the 2026-06-09 analysis is **structural**: the pipeline treats the camera's capture-PTS as unquestioned ground truth for A/V sync (video PTS = camera capture time; audio PTS = mic capture time; sync is *defined* by trusting that camera timeline). The rate-unlock fixes the *known* trigger for *one* camera — but "USB cameras are unreliable" is this project's founding premise, so the robust posture is to *also not blindly trust the camera clock*. A flaky camera could still hand us a backward / duplicate PTS for reasons we haven't enumerated.

The same one-line invariant that powers **task 2's warning** is the natural place to *enforce* it — task 2 **observes** the violation, task 3 **enforces** it:

- **The composited / emit path already enforces it.** The freshness gate `isStaleSource` (`RecordingActor+FrameHandling.swift`) drops a camera frame whose capture PTS isn't strictly newer than the last emitted — which is *why* a corrupt feed makes output stall rather than emit a garbage timeline. This protection already exists; the rate-unlock just means it rarely has to act. Leave it; document that it *is* the invariant guard for the output path.
- **The gap is the raw camera writer.** `handleCameraFrame` appends every arriving frame to `cameraRawWriter`, and a single backward-PTS sample makes `AVAssetWriter` reject it → `.failed` → `-16364` → an **unplayable `camera.mp4`**. The safety-net master is itself fragile. Add a thin guard: track the last appended raw-camera PTS and **skip any frame whose retimed PTS does not strictly advance**, so a corrupt frame leaves the raw file *truncated-but-playable* instead of dead. This is cheap, camera-agnostic, and makes the safety net actually safe.

**Keep it minimal — do not over-engineer.** No PTS *repair*, no re-stamping content onto fabricated times (that is its own desync). The move is "distrust / drop non-monotonic camera frames at ingestion," nothing more. If the rate-unlock works as the diagnosis predicts, the raw-writer guard almost never fires — it is cheap insurance, justified only because a safety-net file should not be brittle. Whether to land the raw-writer guard in this task or note it as a fast follow is a judgement call for the implementing session; the recommendation is to include it, since it is small and directly closes the `-16364` failure mode #30 has been tracking.

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
- (If the defence-in-depth guard lands) a deliberately-corrupt / flaky camera no longer kills `camera.mp4` — the raw master is truncated-but-playable, not a broken-moov-atom file.
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
| Defence-in-depth: skip non-monotonic frames into the raw camera writer | `Pipeline/RecordingActor+FrameHandling.swift` (`handleCameraFrame` / `retimedSampleForRawWriter`) |
| Possibly: warmup capability probe | `Pipeline/RecordingActor+Prepare.swift` |
| Doc: camera format selection | `app/LoomClone/CLAUDE.md` |
| Doc: pipeline / frame flow | `docs/developer/recording-pipeline.md` |
| Reference: incident/decision record | `docs/archive/m2-pro-video-pipeline-failures.md` (note the diagnosis + decision) |
