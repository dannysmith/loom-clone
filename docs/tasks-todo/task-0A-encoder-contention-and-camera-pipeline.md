# Task 0A — Encoder Contention, Camera Pipeline & Adjustments

Three related issues in the macOS recording pipeline, sequenced so each phase builds on the foundation of the previous one and can be committed independently.

**The core finding**: Our current approach runs three concurrent hardware H.264 encode sessions (composited HLS + raw `screen.mp4` + raw `camera.mp4`) on an M2 Pro that has a single media-engine video encode block. The time-slicing budget is exceeded and the hardware encoder back-pressures, which visibly manifests as `CIContext.render()` timing out with `kIOGPUCommandBufferCallbackErrorTimeout` — the CIContext is a downstream symptom, not the cause. A dedicated `MTLCommandQueue` does **not** isolate us: the Metal command scheduler and VideoToolbox both arbitrate through the same IOKit command-buffer queue.

**The fix**, in summary: stop running three concurrent H.264 sessions. Move the heaviest raw stream (`screen.mp4`) to the ProRes engine — a separate silicon block on M*Pro and M*Max chips that's currently idle in our pipeline. Along the way, fix missing colourspace metadata on camera buffers (which is independently causing CIContext to run an expensive multi-stage colour conversion chain every frame), plumb proper error handling into the compositor so we can detect and recover from future stalls, and finally build camera adjustment controls on the now-stable foundation.

Read `docs/requirements.md` for product context, `task-0-scratchpad.md` for the historical framing of these issues, `docs/m2-pro-video-pipeline-failures.md` for the complete failure-mode incident report, and the Background section below before starting any phase.

---

## ⚠️ Current status (2026-04-11) — PAUSED

This task is **paused pending task-0B (research) and task-0C (isolation test harness)**. The work that followed Phase 2 hit a kernel-level failure mode that our model of the hardware did not predict, and we do not want to continue making speculative changes to the recording pipeline until we have better empirical data.

### DANGER — the `main` branch is currently unsafe at 1440p

The `main` branch includes committed Phase 2b code (the 1440p preset replacing 4K). **Selecting the 1440p preset and hitting record on this build triggers failure mode 4** — a kernel-level IOGPUFamily deadlock that causes a WindowServer watchdog timeout and requires a hard power-button reboot. This has happened once already on the developer's Mac on 2026-04-11 at 13:32. See `docs/m2-pro-video-pipeline-failures.md` for the full incident.

**Until Phase 2b is resolved**: do not select the 1440p preset on this build. The 1080p preset remains safe and is the only production-validated configuration.

### Phase-by-phase state

- **Phase 1** — ✅ Done. Committed in `a71e7cc` ("WIP Phase 1"). Camera Rec. 709 pixel buffer tagging, format introspection logging, and composited-HLS `AVVideoColorPropertiesKey` landed. The first implementation caused failure mode 2 (also a WindowServer watchdog hang) when `AVVideoColorPropertiesKey` was declared on the raw writers too — that path was removed before commit. See Phase 1's Outcome subsection below and the failure modes doc.
- **Phase 2** — ✅ Done. Committed in `71211eb`. Raw screen writer switched to ProRes 422 Proxy on the dedicated ProRes engine. Validated at **1080p preset only** via Stages 1 and 2 (30 s and ~76 s, all writers active, zero GPU errors, healthy 4 s segment cadence). **Stage 3 was never run as originally specified** — the 4K preset was attempted instead and triggered failure mode 3 (H.264 engine back-pressure cascade, ~5 s screen freeze, recoverable). We then moved to Phase 2b rather than completing Stage 3 at 1080p. See Phase 2's Outcome subsection for the empirical data we do have.
- **Phase 2b** — ⚠️ Committed in `71211eb`, **broken**. Replaced the 4K preset with a 1440p preset on the hypothesis that 1440p's 1.78× pixel area over 1080p would stay within the H.264 engine's headroom. The first test recording at 1440p triggered failure mode 4 (kernel-level IOGPUFamily deadlock → WindowServer watchdog → hard reboot). The code is still in `main`. See the Phase 2b section below for the full outcome.
- **Phase 3** (CIContext error handling) and **Phase 4** (camera adjustments) — **moved to `docs/tasks-todo/task-0D-compositor-error-handling-and-camera-adjustments.md`** to keep this task focused on resolving the pipeline instability.

### Next work, in order

1. **Task-0B — deeper research** into IOGPUFamily behaviour, VideoToolbox tuning knobs we're not using, and how comparable apps (Cap, OBS, FFmpeg) handle concurrent hardware video sessions on Apple Silicon. Run as a parallel research session. See `docs/tasks-todo/task-0B-video-pipeline-research.md`.
2. **Task-0C — isolation test harness** that lets us empirically test writer combinations + session tuning without hanging the developer's Mac. Run as a parallel coding session. See `docs/tasks-todo/task-0C-isolation-test-harness.md`.
3. **Resolve Phase 2b** based on the findings from 0B/0C. Likely paths: revert Phase 2b to restore the proven-stable 1080p-only state; reduce raw screen capture resolution below native Retina; switch `SCStreamConfiguration.pixelFormat` to 420v; apply specific `VTCompressionSession` properties that task-0B research finds are load-bearing; or something else entirely driven by what the harness shows.
4. **Task-0D** — Phases 3 and 4 from the original plan. Picks up after Phase 2b is resolved.

### Reference document

Full failure-mode incident report: `docs/m2-pro-video-pipeline-failures.md`. Every incident referenced in this task doc is documented there in detail, including inlined diagnostic evidence (thread names, stack traces, CPU times) from the primary-source `.ips` and `.spin` files under `/Library/Logs/DiagnosticReports/`. The incident report is the load-bearing source for anything we learned on 2026-04-11; this doc cites it liberally.

---

## Background: why this is the plan

### The current three-encoder design

`RecordingActor.prepareRecording` instantiates:

1. A composited HLS writer at the chosen output preset (H.264, 6 Mbps @ 1080p). Frames come from the metronome at 30 fps; each one is composited via `CompositionActor.compositeFrame`, which calls `CIContext.render(to:bounds:colorSpace:)` at `CompositionActor.swift:114`.
2. A raw `screen.mp4` writer at native display resolution (H.264, 25–60 Mbps depending on height). Consumes `CMSampleBuffer`s directly from ScreenCaptureKit — no CIContext involvement.
3. A raw `camera.mp4` writer at the camera's native format (H.264, 12 Mbps). Consumes `CMSampleBuffer`s directly from AVCaptureSession — no CIContext involvement.

All three run concurrently through VideoToolbox's hardware H.264 path.

### What's actually breaking

On M2 Pro (Mac14,9):

- 2 encoders: stable.
- 3 encoders: `CIContext.render()` hits `kIOGPUCommandBufferCallbackErrorTimeout`, then `kIOGPUCommandBufferCallbackErrorSubmissionsIgnored` on every subsequent render. The metronome falls behind (segments stretch from 4 s to 8 s). The recording survives but degrades.

The `finishWriting` hang guard is already in place so this doesn't cause full hangs, just quality degradation.

### Why the CIContext isn't the real culprit

From Apple docs and community evidence (OBS, HandBrake, Sunshine, Blender, Unity):

- **M2 Pro has one video encode engine.** Apple had to issue a public correction on their own spec page over this. M1 Pro, M2 Pro, and M3 Pro all have a single H.264/HEVC engine; only Max and Ultra variants get multiple.
- **VideoToolbox defaults to hardware H.264** on Apple Silicon and won't silently fall back to software. `AVAssetWriter` is a thin wrapper over `VTCompressionSession`; switching APIs doesn't change contention.
- **Apple publishes no concurrent-session limit.** The single media engine time-slices between compression sessions, and three high-bitrate streams (especially one at native 4K) exceeds its budget.
- **Dedicated `MTLCommandQueue` does not isolate CIContext from encoder contention.** The Metal scheduler and VideoToolbox share a front-end arbiter through the same IOKit command-buffer queue. When the encoder back-pressures, CIContext command buffers wait behind it, hit the GPU watchdog, and time out. The CIContext errors are symptoms of a jammed encoder, not a CIContext bug.
- **ScreenCaptureKit cannot deliver pre-encoded samples.** SCStream always yields uncompressed `CVPixelBuffer`s — there is no passthrough-without-re-encode path for the screen stream.

### The ProRes escape hatch

The M*Pro media engine has a **separate ProRes encode block** distinct from the H.264/HEVC block. It's the same silicon that's marketed to pros for real-time multi-stream ProRes editing. In our pipeline it's completely unused.

The OBS community hit exactly this problem and the standard workaround is to move the heaviest passthrough stream to ProRes 422 Proxy. This fits us well:

- Raw `screen.mp4` is a master file we'll re-encode or transcode later anyway — its on-disk bitrate during capture doesn't matter downstream.
- ProRes 422 Proxy at 4K is roughly 350–500 Mbps (~5–8× the H.264 size). Within modern SSD write rates; not an issue for a single-user recording tool.
- The code change is small: swap the codec key on one AVAssetWriter output.
- No server-side impact — raw files aren't uploaded today.

This leaves the H.264 engine running two streams (composited HLS + raw camera) that it demonstrably handles, and puts the heavy stream on silicon that's otherwise idle.

### Untagged camera buffers make CIContext more expensive

Independently of the encoder issue: camera frames from USB devices (ZV-1 and many others) arrive without `kCVImageBufferYCbCrMatrixKey`, `kCVImageBufferTransferFunctionKey`, or `kCVImageBufferColorPrimariesKey`. CIContext can't skip colour management on untagged buffers, so it runs a full `colormatrix → clamp → alpha_swizzle → curve → colormatrix → curve → colormatrix` chain every frame.

Apple's TN2227 and QA1839 are the authoritative reference: attach Rec. 709 metadata on ingest, and set `AVVideoColorPropertiesKey` on the writer outputs to match, and the conversion graph collapses to near-noop.

This fix is orthogonal to the encoder contention — it reduces CIContext workload regardless of how many encoders are running. Doing it first gives us a cleaner baseline for testing the ProRes switch.

### CIContext error-handling is blind

`compositeFrame` uses the void `ciContext.render(to:bounds:colorSpace:)` method (`CompositionActor.swift:114`). It has no return value, no error object, and no task handle. The first time we discover a failed render is when the *next* render also fails. The task-based API `startTask(toRender:to:)` returns a `CIRenderTask` with immediate `NSError` feedback and lets us detect stalls with our own timeout rather than the OS watchdog.

Once we have structured error feedback we can wire up a recovery path: on error, rebuild the `CIContext` + `MTLCommandQueue`; if rebuild also fails, end the recording cleanly with a user-visible error. This is belt-and-braces for unexpected future environments (different cameras, bigger displays, thermal events).

### Historical incident: 2026-04-11 WindowServer hang

Recorded here as load-bearing context for anyone working on future phases — the failure mode we actually hit was worse than the "degraded quality" that motivated this task in the first place, and the cause is instructive.

**What happened.** Mid-way through implementing Phase 1, we added `AVVideoColorPropertiesKey = Rec. 709` to `RawStreamWriter.swift` (both the raw screen and raw camera writers). On the first recording test after that change, the entire Mac hung: mouse frozen, no keyboard response, forced power-button reboot.

**Why.** ScreenCaptureKit delivers pixel buffers in the display's native colour space (sRGB or Display P3 on a Retina Mac) — **not** Rec. 709. By declaring Rec. 709 on the raw screen writer's output, we asked AVFoundation to insert a GPU-side colourspace conversion stage between the input and the hardware encoder. That spawned a `com.apple.coremedia.videomediaconverter` thread which added per-frame GPU work on top of the already-contended three-encoder pipeline. The GPU — shared with WindowServer for display compositing — got wedged. WindowServer's `com.apple.WindowServer.HIDEvents` dispatch queue stopped processing mouse/keyboard events. After 40 seconds of no check-in, WindowServer hit its watchdog timeout (`bug_type 409`) and was killed. There was no kernel panic — it was a userspace watchdog, and the rest of the system was technically alive but unusable without a working WindowServer.

**Diagnostic evidence.** `/Library/Logs/DiagnosticReports/WindowServer-2026-04-11-114809.ips`. Signature: WindowServer's render-server thread (`com.apple.coreanimation.render-server`) was the only TH_RUN thread in the process — everything else including main was TH_WAIT. LoomClone's stackshot showed three `mediaprocessor.videocompression` threads + one `videomediaconverter` thread — the converter is what confirmed the diagnosis, since it only appears in the pipeline when AVFoundation needs to convert colour spaces.

**What we fixed.** Removed `AVVideoColorPropertiesKey` from `RawStreamWriter` entirely. The composited HLS writer (`WriterActor`) still declares it, and that's safe because `CompositionActor.compositeFrame` renders directly into Rec. 709 via `ciContext.render(..., colorSpace: CGColorSpace(name: .itur_709))` — the declared output matches the input, no conversion happens. The camera buffer attachments we set in `CameraCaptureManager` still propagate through to the raw camera writer's output file via `.shouldPropagate` — so `camera.mp4` is still correctly tagged Rec. 709, just without forcing the conversion path on the raw screen writer.

**Lessons for future phases.**

1. **`AVVideoColorPropertiesKey` is a conversion request, not a metadata annotation.** If you declare an output colour space that doesn't match the input, AVFoundation will convert on the GPU. This is not a free metadata tag.
2. **A "watchdog" is not a "panic".** On Apple Silicon, GPU-resource contention can manifest as a WindowServer hang (bug_type 409) rather than a classic kernel panic. The symptoms look identical to the user — frozen UI, forced reboot — but the diagnostic artifact lives at `/Library/Logs/DiagnosticReports/WindowServer-*.ips` rather than in `/Library/Logs/DiagnosticReports/*.panic`.
3. **Staged testing is non-negotiable.** After any change touching the encode pipeline on this hardware, test at 30 s before stepping up to 1 min before stepping up to longer. The cost of a second hang is much higher than the cost of a few iterative tests.
4. **The ZV-1's format description is tagged even though individual pixel buffers aren't.** This was a surprise discovered via Phase 1's format-introspection logging: `[camera] Format introspection: subType=420v primaries=ITU_R_709_2 transfer=ITU_R_709_2 matrix=ITU_R_709_2`, while the camera *preview* path logged `createFromPixelbuffer: kCVImageBufferYCbCrMatrixKey not found. Using R709`. Format description extensions describe the codec; individual buffers carry their own attachments (or don't). Our Phase 1 per-buffer tagging is still doing useful work during recording — just not for the reason originally documented in the scratchpad.

---

## Phase 1 — Rec 709 colour metadata on camera buffers

### Goal

Stop CIContext running the expensive multi-stage colourspace conversion chain on every camera frame by tagging camera pixel buffers with explicit Rec. 709 metadata at the point they enter the pipeline, and matching the writer-side output colour properties.

### Behaviour after this lands

- Every camera frame passing through `CameraCaptureManager`'s delegate callback has `kCVImageBufferYCbCrMatrixKey`, `kCVImageBufferColorPrimariesKey`, and `kCVImageBufferTransferFunctionKey` set to `ITU_R_709_2` before it reaches any downstream consumer.
- All `AVAssetWriter` video outputs (composited HLS, raw screen, raw camera) declare `AVVideoColorPropertiesKey` matching Rec. 709, so the writer doesn't do its own redundant conversion.
- Xcode Instruments' Metal System Trace shows the CIContext render step dropping the `colormatrix → clamp → alpha_swizzle → curve → colormatrix → curve → colormatrix` chain for camera-sourced frames, collapsing to a near-noop colour path.

### Implementation outline

**`CameraCaptureManager.swift`** — in the capture delegate callback, before forwarding the sample buffer:

```swift
let attachments: [CFString: Any] = [
    kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
    kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
    kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_ITU_R_709_2,
]
if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
    CVBufferSetAttachments(pixelBuffer, attachments as CFDictionary, .shouldPropagate)
}
```

Use `.shouldPropagate` so CIImage and AVAssetWriter both see the attachments.

Introspect the camera format at startup (already partially happens in `bestFormat`) and log the input's active pixel format, YCbCr matrix (if any), transfer function, and colour primaries. This gives us a diagnostic trail for debugging future cameras.

**`WriterActor.swift`** — add `AVVideoColorPropertiesKey` to `videoSettings`:

```swift
AVVideoColorPropertiesKey: [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
]
```

**`RawStreamWriter.swift`** — ~~same addition on both the raw screen and raw camera video outputs.~~ **DO NOT DO THIS.** This was in the original plan and turned out to be the direct cause of the 2026-04-11 WindowServer hang (see the historical incident in the Background section). Raw writers must omit `AVVideoColorPropertiesKey` entirely — they let AVFoundation infer the output colour space from the input pixel buffers. The camera path still produces correctly Rec. 709-tagged output because `CameraCaptureManager`'s delegate callback attaches the tags with `.shouldPropagate` mode, and AVAssetWriter honours pixel-buffer attachments when no explicit output properties are set.

**`CompositionActor.swift`** — the `render(...)` call already passes `CGColorSpace(name: .itur_709)`. Leave it. Add a line-level comment explaining the tagging contract so future-us doesn't get confused.

**Screen buffers** — ScreenCaptureKit frames on macOS 14+ already arrive tagged. Verify this in the Instruments trace; if they're untagged in some config (e.g. HDR display capture), add tagging at the `ScreenCaptureManager` boundary as well. Otherwise leave screen buffers alone.

### Exit criteria

- [x] Camera pixel buffers exit `CameraCaptureManager` with all three colour attachments set
- [~] ~~All three `AVAssetWriter` video outputs declare `AVVideoColorPropertiesKey`~~ — revised: only the composited HLS writer (`WriterActor`) declares it. Raw writers (`RawStreamWriter`) must not, per the 2026-04-11 incident. Camera output is still correctly Rec. 709-tagged via pixel-buffer attachment propagation.
- [ ] Xcode Instruments Metal System Trace of a live recording shows the CIContext render step no longer running the multi-stage colour conversion chain on camera frames — not verified via Instruments. Verified behaviourally instead: Stage 1/2 recording tests showed healthy metronome cadence with no CIContext back-pressure and no regressions.
- [x] Composited HLS playback colour is visually indistinguishable from before (confirmed by playback of the 1-minute test recording)
- [x] Raw `camera.mp4` opened in QuickTime shows correct colour
- [x] Raw `screen.mov` opened in QuickTime shows correct colour (formerly `screen.mp4`; see Phase 2)
- [x] Camera format introspection logs are visible on startup and include pixel format, matrix, transfer function, primaries — confirmed on the ZV-1, which logs `subType=420v primaries=ITU_R_709_2 transfer=ITU_R_709_2 matrix=ITU_R_709_2`
- [~] 5-minute recording on M2 Pro with display + camera + mic shows no behavioural regression — superseded by Phase 2's staged validation (Stages 1 and 2 passed at 30 s and ~76 s; Stage 3 pending at 4K for 5 min)

### Outcome (2026-04-11)

**Status:** Substantially complete, with one deliberate deviation from the original plan (see the `RawStreamWriter` note in the Implementation outline).

**What landed:**

- `CameraCaptureManager.captureOutput` attaches Rec. 709 colour metadata to every pixel buffer with `.shouldPropagate` so both CIImage (the compositor) and AVAssetWriter (the raw camera writer) honour the tags downstream.
- Format introspection at camera startup logs the active format's pixel format (fourcc) and declared colour extensions.
- `WriterActor` declares `AVVideoColorPropertiesKey = Rec. 709` on the composited HLS output — safe because `CompositionActor` renders directly into Rec. 709.
- `CompositionActor.compositeFrame` gained a comment explaining the tagging contract.

**What was deliberately not done:**

- `RawStreamWriter` does **not** declare `AVVideoColorPropertiesKey`. The 2026-04-11 WindowServer hang (documented in the Background section) proved that declaring Rec. 709 output on a writer whose input pixel buffers arrive in a different colour space forces a GPU-side conversion that wedges the GPU on contended hardware. Let AVFoundation infer from input instead.
- Xcode Instruments Metal System Trace comparison was not produced. Behavioural testing (segment cadence, absence of GPU errors in `log stream`) turned out to be a sufficient health signal, and Phase 2's architectural fix made the CIContext optimisation much less load-bearing anyway.

**Surprising finding:** ZV-1's format description declares Rec. 709 extensions, but individual pixel buffers delivered to the *preview path* (via `AVCaptureVideoPreviewLayer` / `CameraPreviewManager`) arrive without attachments — Core Image logs `createFromPixelbuffer: kCVImageBufferYCbCrMatrixKey not found. Using R709`. Our recording path doesn't hit these warnings because we tag the buffer before forwarding it. The preview-path warnings are now a separate noise-cleanup task in the scratchpad.

---

## Phase 2 — Move raw screen.mp4 to ProRes 422 Proxy

### Goal

Eliminate hardware H.264 encoder contention during recording by moving the raw screen stream off the H.264 engine onto the separate ProRes silicon block. Restore stable recording on M2 Pro with all three writers active.

### Behaviour after this lands

- `raw/screen.mp4` becomes `raw/screen.mov`, written via `AVVideoCodecType.proRes422Proxy` to an `AVAssetWriter` with file type `.mov`.
- Composited HLS writer and raw `camera.mp4` writer are unchanged — both still H.264 via VideoToolbox.
- During recording on M2 Pro with display + camera + mic at native 4K screen + 1080p camera, no `kIOGPUCommandBuffer*` timeouts occur. The composited metronome maintains its 4-second segment cadence.
- On-disk file size for `screen.mov` is 5–8× larger than the previous H.264 `screen.mp4` at the same content. Acceptable — this is a master file; downstream uploads/transcodes will shrink it.
- `recording.json` `rawStreams.screen` block is updated to reflect the new codec (`prores422proxy`) and filename. The `bitrate` field becomes approximate (ProRes is roughly CBR-per-frame, not target-bitrate), so record the observed average instead.

### Why ProRes 422 Proxy (not 422 / 422 HQ / 4444)

- **Proxy** is the lightest ProRes variant — ~45 Mb/s at 1080p, ~180 Mb/s at 4K. Still visually excellent for a master we'll re-encode from.
- **422 / 422 HQ / 4444** give more headroom but at much higher bitrates (up to ~1 Gb/s at 4K for 4444). We don't need editorial-grade quality; we need "higher quality than our H.264 master and offloadable to the ProRes engine."
- Proxy keeps disk write rates well within SSD headroom and leaves the ProRes engine with spare capacity.

### Implementation outline

**`RawStreamWriter.swift`** — extend the `Kind` enum:

```swift
enum Kind {
    case videoH264(width: Int, height: Int, bitrate: Int)
    case videoProRes(width: Int, height: Int)   // NEW
    case audio(bitrate: Int)
}
```

Split the writer initialisation based on kind:

- `.videoH264` → existing path, `AVFileType.mp4`, `AVVideoCodecType.h264`.
- `.videoProRes` → new path, `AVFileType.mov`, `AVVideoCodecType.proRes422Proxy`. No `AVVideoCompressionPropertiesKey` (ProRes doesn't take the same settings dict).

**`RecordingActor.swift`** — change the raw screen writer instantiation from `.videoH264` to `.videoProRes`. Keep the camera writer on `.videoH264`.

**File extension / path** — update `screen.mp4` → `screen.mov` throughout: `RecordingActor.prepareRecording`, `recording.json` timeline construction, cleanup paths, and any tests.

**`recording.json`** — adjust `rawStreams.screen` schema:

```json
"rawStreams": {
  "screen": {
    "filename": "screen.mov",
    "width": 3840, "height": 2160,
    "videoCodec": "prores422proxy",
    "bitrate": 129497400,
    "bytes": 1235718003
  }
}
```

Camera and audio blocks unchanged.

**Correction from the original plan:** the original doc proposed renaming the field to `averageBitrate`. We kept the existing `bitrate` field name to avoid a schema-version bump and to keep the code path uniform with the camera stream (which still reports its H.264 *target* bitrate in the same field). The semantic difference — "target" for H.264, "observed average" for ProRes — lives in a comment near the setter in `RecordingActor.stopRecording`. If this ambiguity becomes a problem for downstream tooling, bump `schemaVersion` to 2 and rename then.

**Logging** — add a one-time startup log line reporting "Raw screen writer: ProRes 422 Proxy at {width}x{height}" so we can see in crash reports what the writer was configured with.

### Validation procedure (hardware-dependent)

This phase must be validated on M2 Pro hardware before merging. The architectural claim is "ProRes engine has enough headroom for 4K 422 Proxy concurrent with our two H.264 streams" and that's empirical, not documented.

1. Build the phase locally.
2. Record a 10-minute session with display + camera + mic at the highest preset available (4K if the display supports it, otherwise 1440p or 1080p).
3. During the recording, in Activity Monitor's GPU pane, observe Media Engine utilisation and GPU utilisation. Expectation: both engines are used; GPU is mostly idle.
4. In the terminal run `log stream --predicate 'subsystem CONTAINS "Metal"'` during the recording and watch for any `kIOGPUCommandBufferCallback*` errors. Expectation: none.
5. Open Xcode Instruments → Metal System Trace → record a 2-minute window → confirm no command-buffer timeouts.
6. On recording stop, confirm:
   - `screen.mov` plays in QuickTime at native resolution, no dropped frames, decodes at real-time speed.
   - Composited HLS segments are a consistent ~4 seconds each (not stretched).
   - Raw `camera.mp4` is stable.
7. Check disk-space impact: `screen.mov` at 4K for 10 min should be roughly 15–25 GB depending on content.

If step 4 or 5 surfaces errors, **stop and escalate** — the ProRes engine isn't giving us the headroom we hoped for, and we need a contingency.

### Contingencies if ProRes doesn't relieve contention

Ranked by preference:

1. **Reduce ProRes resolution.** Write `screen.mov` at a scaled-down resolution (e.g. 2560×1440 for a 4K display), not native. Still ProRes, still on the dedicated engine, less data throughput. We lose some master-file fidelity but the raw file is still usable for re-composition.
2. **Force one H.264 stream to software encode** via `VTSessionSetProperty` with `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = false` on the raw camera writer. Apple's docs imply this is allowed; community reports are thin. Software H.264 at 720p/12 Mbps is tractable on modern CPUs.
3. **Drop the raw camera H.264 writer and re-derive it from a higher-quality composited track.** Changes the master-file story significantly — lose this as a last resort.

### Exit criteria

- [x] `RawStreamWriter.Kind` has a `.videoProRes` case and the existing H.264 case is renamed `.videoH264`
- [x] Raw screen writer is instantiated with `.videoProRes` at native display resolution
- [x] Output filename is `screen.mov`, file type is `.mov`, codec key is `AVVideoCodecType.proRes422Proxy`
- [x] `recording.json` `rawStreams.screen` block is updated to reflect the codec change (codec: `prores422proxy`, bitrate: observed average computed from bytes ÷ duration)
- [~] **On M2 Pro**: a 10-minute recording with display + camera + mic at the highest available preset produces no `kIOGPUCommandBufferCallback*` errors — **PARTIALLY COMPLETE, NOT AS ORIGINALLY SPECIFIED.** Stage 1 (30 s, 1080p preset) and Stage 2 (~76 s, 1080p preset) passed cleanly with all writers active. Stage 3 was specified as "5 min at 4K preset" — it was never run. Instead, the 4K preset was attempted at Stage 1 scale and immediately triggered failure mode 3 (H.264 back-pressure cascade, kIOGPU errors, ~5 s screen freeze, recovered). No long-duration recording was ever successfully completed at any preset above 1080p. The 1080p preset configuration is the only empirically-validated production pipeline.
- [x] Composited HLS segments are a consistent ~4 seconds each throughout the recording — confirmed on the 1-minute test: 18 middle segments at 4.0002 s mean, min 3.992 s, max 4.007 s, total spread 15 ms across 72 s
- [x] `screen.mov` plays cleanly in QuickTime at native resolution — confirmed on both the 30 s and 1 min test recordings
- [ ] Activity Monitor GPU pane shows Media Engine + ProRes engine both in use during recording — not explicitly observed. Behavioural evidence (clean segment cadence + no GPU errors + ProRes output file at the expected bitrate) strongly implies it. Worth eyeballing during Stage 3 for completeness.
- [x] Raw `camera.mp4` is unchanged in behaviour (still H.264, still 12 Mbps, still at native camera format) — confirmed: 1-minute test produced 109 MB at 1280×720 with observed 11.97 Mbps, within 0.3% of the 12 Mbps target
- [x] Composited HLS upload pipeline is unchanged — recording still ends with a working playback URL — confirmed
- [ ] Cancelling a recording cleans up `screen.mov` along with everything else — not explicitly tested. The cancel path already removes the whole local session directory (`RecordingActor.cancelRecording` → `FileManager.removeItem(at: localSavePath)`), so `screen.mov` falls out of that for free, but worth a manual spot-check.

### Outcome (2026-04-11)

**Status:** Implemented and committed. Validated at 1080p preset via Stages 1 and 2 (30 s and ~76 s). **Stage 3 (long-duration at the highest preset) was never completed** — the first attempt went to 4K preset, triggered failure mode 3 immediately, and we pivoted to Phase 2b rather than back off to 1080p Stage 3. See the Phase 2b section and the `## Current status` block at the top for the full story.

**What landed:**

- `RawStreamWriter.Kind.video` renamed to `.videoH264`; new `.videoProRes(width:height:)` case added.
- `RawStreamWriter.configure` branches on kind: `.videoH264` → `.mp4` / `AVVideoCodecType.h264` / existing compression settings; `.videoProRes` → `.mov` / `AVVideoCodecType.proRes422Proxy` / no `AVVideoCompressionPropertiesKey` (ProRes doesn't take H.264's settings dict) / no `AVVideoColorPropertiesKey` (see Phase 1 incident).
- `RecordingActor.prepareRecording` now instantiates the raw screen writer with `.videoProRes` at the display's native pixel size, writing to `screen.mov`. Camera writer continues to use `.videoH264` at the camera's native format.
- `rawScreenDims` tuple reshaped to `(width: Int, height: Int)?` — no bitrate field, since ProRes has no target bitrate to carry through.
- `RecordingActor.stopRecording` computes the observed average bitrate from `bytes × 8 ÷ logicalDuration` when populating the timeline's `rawStreams.screen` entry, guarding against tiny durations.
- Dead code removed: the `rawScreenBitrate(forHeight:)` helper in `RecordingActor` is gone — it was only used by the old H.264 screen writer.
- Startup log line reports "Raw screen writer: ProRes 422 Proxy at {width}x{height} (hardware ProRes engine)" so crash reports show exactly what the writer was configured with.

**Empirical results from the 1-minute test** (session `0cf230dc-07f9-4d2e-93fd-01e7505e612d`):

| Metric | Value |
|---|---|
| Session duration | 76.34 s |
| Segments emitted | 20 (18 middle + 2 partials) |
| Middle-segment cadence | 4.0002 s mean, spread 15 ms |
| `screen.mov` size | 1.24 GB at 3840×2160 |
| `screen.mov` observed bitrate | **129.5 Mbps** |
| `camera.mp4` size | 109 MB at 1280×720 |
| `camera.mp4` observed bitrate | 11.97 Mbps |
| `audio.m4a` size | 1.44 MB |
| Composited HLS total | 46.9 MB (20 segments) |
| Upload errors | 0 |
| `kIOGPU*` errors | 0 |

**Notable empirical finding: ProRes 422 Proxy runs notably below Apple's spec sheet on mixed content.** Apple publishes ~181 Mbps for 4K/30 ProRes 422 Proxy; our observed average on real content was 129.5 Mbps (71% of spec). Content with more motion pushes it higher — the first 32 s of the recording averaged far below that, the next 44 s (with scrolling / window moves) much higher. For future capacity planning:

- **Low-motion 4K content**: ~100 Mbps observed → ~12.5 GB/hour
- **High-motion 4K content**: ~180 Mbps spec → ~22.5 GB/hour
- Rule of thumb: budget ~15 GB/hour for a 4K master file, up to ~25 GB/hour for busy content

This is larger than the original plan's estimate (~11 GB for 10 min ≈ 66 GB/hour at the full spec). Worth remembering when we eventually add auto-cleanup of raw files after server confirmation.

**Segment size trajectory within the 1-minute test:** seg_001 through seg_008 averaged ~1.4 MB each (static content). seg_009 through seg_018 jumped to ~3.4 MB each with peaks at 5.5 MB (active content — scrolling, window moves). Critically, **segment durations stayed locked to 4.000 ± 0.008 s throughout this 3× bitrate jump**, which is the single strongest signal that the H.264 engine has headroom on the two-stream split (composited HLS + raw camera) that Phase 2 left it with — **at 1080p preset**. Attempting 4K preset immediately after this test produced a completely different outcome (see Phase 2b and the `4K preset attempt` note below).

### The 4K preset attempt (failure mode 3)

Before Phase 2b, the first thing tested after the Stage 2 pass was the 4K preset — the original Stage 3 target. Selecting the 4K preset and hitting record produced, immediately and without warning:

- A ~5-second screen freeze
- Thousands of `IOGPUMetalError: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)` in the Xcode console
- Cascading `kIOGPUCommandBufferCallbackErrorSubmissionsIgnored` errors (command queue poisoned)
- Severe segment cadence degradation: seg_000 at 5.085 s, seg_001 at 5.408 s, seg_002 abbreviated to 1.445 s, seg_003 with a 40 Mbps bitrate burst
- Recording eventually completed in a degraded state; session `ce156dc3-34a7-4224-a155-cee7535dfb7b` preserved on disk

This is **failure mode 3** in `docs/m2-pro-video-pipeline-failures.md`. Root cause: at 4K preset, the composited HLS encoder is asked to do 3840×2160 H.264 at 18 Mbps alongside raw camera H.264 at 720p @ 12 Mbps on the single M2 Pro H.264 engine — 3.08× the pixel-area load of the proven-stable 1080p preset baseline. The engine can't time-slice between them fast enough; back-pressure propagates into CIContext command buffers; watchdog fires.

Unlike Phase 2b's failure (kernel-level deadlock), this failure was **userspace-recoverable**: WindowServer did not die, the system stayed usable, the recording limped on. But the output was unusable and the 5-second screen freeze was a clear warning sign.

In response to this we proposed capping composited HLS output at 1080p regardless of preset. After discussion, we chose instead to replace the 4K preset with a 1440p preset (less aggressive pixel-count increase) to see if a middle ground existed. That decision produced Phase 2b.

---

## Phase 2b — Replace 4K preset with 1440p (BROKEN)

### What we tried

The 4K preset attempt in Phase 2 triggered failure mode 3 (H.264 engine back-pressure cascade). Rather than cap the composited HLS output at 1080p regardless of preset selection, we proposed a middle ground: replace the 4K preset with a 1440p preset. The hypothesis was that 1440p's 1.78× pixel area over 1080p (vs 4K's 3.08×) would stay within the H.264 engine's headroom while still giving users a meaningfully higher-quality streaming option than 1080p.

### What landed

- `OutputPreset.p4k` replaced with `OutputPreset.p1440` (2560×1440 @ 10 Mbps H.264)
- `RecordingCoordinator.is4KAvailable` renamed to `is1440pAvailable`, threshold changed from `>= 2160` to `>= 1440`
- `MenuView` quality picker gating updated to show 1440p option only when the selected display or camera can natively feed it
- `OutputPreset.fromID("4k")` falls through to `.default` (1080p) as before — no migration needed for legacy UserDefaults values
- No changes to `WriterActor`, `CompositionActor`, `RecordingActor`, `RawStreamWriter`, or any capture manager — they consume `preset.width` / `preset.height` / `preset.bitrate` polymorphically

Committed alongside Phase 2 in `71211eb`.

### What happened

**First test recording at 1440p preset: entire Mac froze immediately on pressing record.** Mouse unresponsive, keyboard ignored, no visible error dialog, no recovery after 40+ seconds. Forced hard reboot via power button.

This is **failure mode 4** in `docs/m2-pro-video-pipeline-failures.md`. It is qualitatively worse than failure mode 3:

- **Kernel-level deadlock**, not userspace back-pressure
- Zero `kIOGPUCommandBufferCallback*` errors in the userspace logs (the deadlock is below the level where Metal's watchdog can see it)
- `com.apple.videotoolbox.preparationQueue` thread in LoomClone is stuck inside the `IOGPUFamily` kernel extension waiting for an IOSurface allocation that never completes
- Entire recording pipeline (H.264 encoders, ProRes frame receiver, CIContext render queue, metronome Swift task) frozen downstream of the kernel wait
- `VTEncoderXPCService` and `replayd` XPC helpers also parked, donating importance to LoomClone, waiting for us to process work we can't
- WindowServer's `ws_main_thread` blocked in SkyLight's Metal submission path because the GPU resources it needs are held by our deadlocked pipeline
- After 40 seconds, WindowServer service watchdog fires; system requires hard reboot

Full diagnostic evidence inlined in `docs/m2-pro-video-pipeline-failures.md` (failure mode 4 section), sourced from `/Library/Logs/DiagnosticReports/WindowServer_2026-04-11-133259_danny.userspace_watchdog_timeout.spin`.

### The research premise that broke

Phase 2's architectural premise was: "ProRes engine is separate silicon from the H.264 engine, so offloading the raw screen writer to ProRes 422 Proxy frees the H.264 engine to handle the two remaining H.264 streams." This is true at the hardware-engine level and it worked at 1080p preset. **What it didn't account for is that both engines still allocate their working buffers through the shared `IOGPUFamily` kernel extension.** When enough simultaneous hardware-backed video sessions compete for IOSurface allocations from IOGPUFamily on a single-media-engine chip, the kernel arbiter can enter a state where it stops servicing new allocation requests from the VideoToolbox preparation thread. The stopped thread holds GPU resources WindowServer needs for its own display compositing; WindowServer watchdogs; system hangs.

This is a gap in publicly-available Apple developer documentation. Our previous research pass (the one that informed Phase 2) found nothing about IOGPUFamily as a shared bottleneck below both hardware video engines. Task-0B is supposed to close this gap — or, if the answers aren't public, at least produce concrete hypotheses for task-0C's harness to test.

### Why 1440p and not 1080p

Empirically, the only meaningful differences between the 1080p preset (proven stable) and the 1440p preset (kernel deadlock):

1. Compositor output canvas: 1920×1080 → 2560×1440 (1.78× pixel area)
2. Composited HLS H.264 encoder input size: same 1.78× larger
3. Composited HLS bitrate: 6 Mbps → 10 Mbps (1.67×)
4. Output pool IOSurface size per buffer: 8.3 MB → 14.7 MB (1.78× larger)
5. PiP overlay circle diameter: 240 px → 320 px

None of these individually should trigger a kernel deadlock. Which combination crosses the line, and why, is **unknown**. Answering this question is the purpose of task-0C's Tier 3 test plan.

### Current state

- Phase 2b code is in `main` (committed in `71211eb`). The working tree is clean.
- Recording at 1440p preset on the current build will reproduce failure mode 4. Do not test this.
- Recording at 1080p or 720p preset on the current build is still safe (those configurations are unchanged from Phase 2's validated state).
- No action has been taken to revert or gate Phase 2b. This was an explicit choice — we wanted to preserve the ability to test "what happens at 1440p" in the isolation test harness, and reverting the preset code would make that test plan harder to set up. If you need to be sure Phase 2b won't bite someone unfamiliar with the situation, add a runtime guard or revert the commit.

### Paths forward

The decision for what to do with Phase 2b will depend on what task-0B and task-0C produce. The likely options, roughly ranked:

1. **A research-informed fix lands.** Task-0B identifies a specific `VTCompressionSession` property, `SCStreamConfiguration` option, or pipeline change that empirically resolves the deadlock (validated in task-0C's harness). We update Phase 2b with the fix, re-test, ship.
2. **Reduce raw screen capture resolution.** If task-0C's Tier 3.3 test passes (ProRes screen at display-points resolution rather than native Retina), we accept the quality trade-off on raw masters and ship 1440p with lower-res screen capture. The user has indicated this trade-off is acceptable as a last-resort.
3. **Drop the raw camera writer while recording at 1440p preset.** If task-0C's Tier 3.5 test shows this works, we lose the raw camera master above 1080p preset. Less desirable because it's a feature regression.
4. **Revert Phase 2b entirely.** Ship 1080p preset as the maximum streaming resolution. Raw screen master is still at native Retina. This is the safest fallback — we know it works. Loses the "higher-quality streaming" ambition that motivated Phase 2b in the first place.
5. **Revert Phase 2, revert Phase 2b, ship pre-task state.** Absolute worst case. Back to 3× H.264 engines and degraded-but-not-hanging quality at 1080p preset. Not preferred; we'd rather keep the ProRes offload win from Phase 2 even at 1080p.

All of these are speculative until task-0B and task-0C produce real data. Do not implement any of them in isolation — they all depend on findings from those tasks.

---

## Follow-ups not in this task

- **Metronome skipping CIContext in single-source modes.** In `cameraOnly` mode the compositor currently runs a full render every metronome tick even though there's no screen to composite. An optimisation would skip the render and feed the camera frame directly to the HLS writer. Not in scope for the current failure-mode focus.
- **Broader camera testing matrix.** Phase 1's format-introspection logging should eventually include data from a couple of cameras (built-in FaceTime HD, USB ZV-1). A fuller matrix (Continuity Camera, Elgato Cam Link, generic USB webcam) is a future task.
- **CIContext error handling and recovery.** Moved to `task-0D` as Phase 1 of that task.
- **Camera white-balance and brightness adjustments.** Moved to `task-0D` as Phase 2 of that task.

## Cross-task references

- `docs/m2-pro-video-pipeline-failures.md` — complete failure-mode incident report, load-bearing for understanding why this task is paused
- `docs/tasks-todo/task-0B-video-pipeline-research.md` — deeper research into IOGPUFamily, VideoToolbox tuning, and comparable apps
- `docs/tasks-todo/task-0C-isolation-test-harness.md` — isolation test harness for empirical validation
- `docs/tasks-todo/task-0D-compositor-error-handling-and-camera-adjustments.md` — the follow-on task that picks up Phases 3 and 4 after the pipeline is stable
- `docs/tasks-todo/task-0-scratchpad.md` — original scratchpad where these issues were first documented
- `docs/requirements.md` — product requirements, especially the "Quality" section (streamed version may be lower quality than local capture)
