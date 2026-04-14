# M2 Pro Video Pipeline Failures — Incident Reference

This document is institutional memory. It records every failure mode we've observed while building the LoomClone recording pipeline on an M2 Pro Mac, with enough diagnostic evidence inlined that future readers (human or AI) can understand what happened even after the original `.ips` and `.spin` files are rotated out of `/Library/Logs/DiagnosticReports/`.

The emphasis here is on **what failed and how we know**, not on what we tried to fix. Fixes live in task docs; this doc is for the failure modes themselves.

## When to read this doc

- You're about to make a change that touches the recording pipeline's encoder, compositor, or capture layer.
- The app has hung the Mac again and you're trying to figure out if it's a known failure mode.
- You're an AI agent working on this codebase and want to avoid re-learning lessons the hard way.
- You're writing a bug report or DTS ticket to Apple and need to cite concrete evidence.

## Hardware context

Every failure documented here was observed on the same machine:

- **Model:** Mac14,9 (14-inch MacBook Pro, M2 Pro, 2023)
- **CPU cores:** 12
- **Memory:** 32 GB unified
- **macOS:** 26.4 (build 25E246)
- **Architecture:** arm64e
- **Camera used in tests:** Sony ZV-1 via USB (`uniqueID=0x0000000000000000`), delivering 1280×720 @ 30fps 420v
- **Microphone:** Yeti Stereo via USB

The M2 Pro is critical to what follows. Some key facts:

- **Single H.264/HEVC video encode engine.** M1 Pro, M2 Pro, and M3 Pro all have exactly one. Only the Max variants (2 engines) and Ultra variants (4 engines) have more. Apple had to publicly correct their own spec page on this point for M2 Max, which is how confusing this is.
- **Separate ProRes encode/decode engine.** Introduced with M1 Pro. This is dedicated silicon distinct from the H.264/HEVC engine. Handles ProRes encode/decode without involving the general-purpose GPU or the H.264 engine.
- **Shared unified GPU.** The general-purpose GPU cores are shared between our app (CoreImage compositing via CIContext) and WindowServer (display compositing via SkyLight). When our GPU work gets stuck, WindowServer gets stuck too, because they arbitrate through the same OS-level command-buffer queue.
- **IOGPUFamily kernel extension.** The kernel-side arbiter that manages IOSurface allocation for all hardware-accelerated video work. Both the H.264 engine and the ProRes engine allocate their working buffers through IOGPUFamily. The research phase did not mention this and we didn't know it was a shared bottleneck until failure mode 4 below.

The research we relied on going into this work assumed "different hardware engines = independent pipelines." That turned out to be true at the hardware level but **false at the IOGPUFamily level**. See failure mode 4.

## Summary of observed failure modes

| # | Name | Trigger | Severity | Reboot required |
|---|------|---------|----------|-----------------|
| 1 | Degraded segment cadence | 3 concurrent H.264 writers producing composited HLS + raw screen + raw camera | Userspace-recoverable | No |
| 2 | GPU colourspace conversion wedge | `AVVideoColorPropertiesKey = Rec. 709` declared on a writer whose input was sRGB/P3, forcing GPU conversion | **Kernel-level hang — WindowServer watchdog** | Yes (hard power-off) |
| 3 | H.264 encoder back-pressure cascade | Composited HLS encoder configured for 4K @ 18 Mbps H.264 alongside a second H.264 stream | Userspace-recoverable (~5s screen freeze) | No |
| 4 | IOGPUFamily kernel deadlock | 1440p preset: 2× H.264 + 1× ProRes + CIContext + ScreenCaptureKit running concurrently | **Kernel-level hang — WindowServer watchdog** | Yes (hard power-off) |

There are three distinct severity tiers here:

- **Userspace-recoverable** — Metal's command-buffer watchdog fires on a specific stuck submission, kills it, and the pipeline limps forward in degraded state. `kIOGPUCommandBufferCallbackErrorTimeout` and `SubmissionsIgnored` errors appear in the userspace logs. The system stays usable.
- **Kernel wedge with WindowServer watchdog** — something in the recording pipeline holds kernel resources that WindowServer's display-compositing work needs. WindowServer's main thread stops processing HID events. 40 seconds later, the service-process watchdog fires. The Mac is unresponsive and requires a hard power-button reboot. Userspace GPU errors may or may not precede this.

We have not observed a kernel panic during any of this work. The severe failures are all **watchdog timeouts** (`bug_type 409`), not panics. Diagnostic artifacts live in `/Library/Logs/DiagnosticReports/WindowServer*.ips` or `.spin`, not in `*.panic`.

## Failure mode 1 — Degraded segment cadence

### Observed

Three concurrent H.264 encode sessions active:
- Composited HLS writer (1920×1080 @ 6 Mbps)
- Raw screen writer (native display resolution, up to 4K, 25–60 Mbps depending on height)
- Raw camera writer (1280×720 @ 12 Mbps)

Symptoms during recording:
- `CIContext.render()` inside the compositor throws `kIOGPUCommandBufferCallbackErrorTimeout`.
- Subsequent GPU submissions on the same command queue are rejected with `kIOGPUCommandBufferCallbackErrorSubmissionsIgnored`.
- The metronome falls behind its 30 fps cadence.
- HLS segment durations stretch from the expected 4 s to 8 s or more.
- The recording completes, but with degraded cadence and lost frames.

The `finishWriting` hang guard (checking `.failed` status before calling `finishWriting`) is already in place, so this doesn't cause full hangs — just quality degradation.

### Diagnostic evidence

No direct diagnostic reports were captured for this failure mode. It was discovered in the course of building Phase 0 of the prototype and documented in the scratchpad before we began systematic investigation. The original description lives at:

- `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` → Background → "The current three-encoder design" and "What's actually breaking"
- `docs/tasks-done/2026-04-11-task-0A-source-selection-and-raw-recording.md` (the predecessor task that added raw local recording)

### Interpretation

The H.264 encoder on M2 Pro's single media engine cannot keep up with 3× simultaneous hardware encode sessions at these bitrates. Back-pressure propagates from the encoder upward:

1. VideoToolbox's internal encode queues fill up.
2. AVAssetWriter input buffers stall on append.
3. CIContext render commands queued behind stuck encoder work in the shared IOKit command-buffer arbiter.
4. Stuck CIContext command buffer eventually hits the GPU watchdog (~2s), returns `kIOGPUCommandBufferCallbackErrorTimeout`.
5. First error poisons the Metal command queue — every subsequent submission is rejected with `SubmissionsIgnored` until the queue is rebuilt.
6. Metronome thread (which is awaiting CIContext render completion) falls behind; segments stretch past their nominal 4 s interval.

This failure is **userspace-recoverable**: WindowServer's own GPU work is on a different command queue arbitration path and keeps going, so the system stays usable.

### What we don't know

- Whether the back-pressure pattern would eventually cause a full pipeline stall if a recording ran for long enough (we never left one running past ~2 minutes).
- Whether any individual encoder is the primary bottleneck, or whether it's the combined load.
- What the exact "time-slicing budget" of the single H.264 engine is in Mpx/s — Apple does not publish this.

## Failure mode 2 — GPU colourspace conversion wedge (2026-04-11 11:48)

### Observed

During Phase 1 implementation, `AVVideoColorPropertiesKey = Rec. 709` was added to `RawStreamWriter`'s video output settings (intended to collapse CIContext's colourspace conversion chain). This applied to both the raw screen writer and the raw camera writer.

Within seconds of hitting record:
- Mouse pointer stopped moving
- Keyboard input ignored
- Screen frozen on whatever was last rendered
- No visible error dialog or crash window
- Waiting 40+ seconds produced no recovery
- Forced hard reboot via power button

### Diagnostic evidence

**File:** `/Library/Logs/DiagnosticReports/WindowServer-2026-04-11-114809.ips`

**Report header highlights:**
- `bug_type: 409` (userspace watchdog timeout, not kernel panic)
- `termination.indicator: "monitoring timed out for service"`
- `termination.namespace: "WATCHDOG"`
- Termination details: `"unresponsive dispatch queue(s): com.apple.WindowServer.HIDEvents(tid:4096599) unresponsive work processor(s): WindowServer main thread 40 seconds since last successful checkin"`
- `modelCode: "Mac14,9"`
- `thermalPressureLevel: "ThermalPressureLevelNominal (0)"` — so this is NOT a thermal event

**WindowServer thread state (stackshot):**
- Only ONE thread running: `com.apple.coreanimation.render-server` (the GPU-submitting thread)
- Main thread: TH_WAIT
- `com.apple.WindowServer.HIDEvents` queue: TH_WAIT
- Classic "WindowServer stuck waiting on the GPU through its own render server" signature

**LoomClone thread state (stackshot):**

Inlined here because the `.ips` file will eventually be rotated out:

- 3× `com.apple.coremedia.mediaprocessor.videocompression` threads — all in TH_WAIT
- 4× `com.apple.coremedia.formatwriter.qtmovie` threads — one in TH_RUN, rest in TH_WAIT
- 2× `com.apple.coremedia.mediaprocessor.audiocompression` threads — TH_WAIT
- **`com.apple.coremedia.videomediaconverter` thread — present in the stackshot** (this is the smoking gun)
- `com.apple.audio.IOThread.client` — TH_WAIT
- Multiple CoreMedia rootQueue/sharedRootQueue worker threads — TH_WAIT

**The `videomediaconverter` thread is the critical marker for this failure mode.** That thread only appears in the pipeline when AVFoundation needs to convert pixel data between colour spaces as part of a video encode. Its presence confirms that AVFoundation was doing GPU-side colourspace conversion in response to our `AVVideoColorPropertiesKey` declaration.

### Interpretation

ScreenCaptureKit delivers pixel buffers in the display's native colour space — sRGB on standard displays or Display P3 on Retina displays. **Not Rec. 709.** When we declared `AVVideoColorPropertiesKey = Rec. 709` on the raw screen writer's output settings, we were effectively telling AVFoundation: "the input you're about to receive needs to be converted to Rec. 709 before encoding."

AVFoundation honoured this by inserting a GPU-side colourspace conversion stage between the input pixel buffer and the hardware H.264 encoder. That's what the `videomediaconverter` thread is — a CoreMedia worker running the GPU-backed colour conversion on every frame.

On top of 3× concurrent H.264 encode sessions already running, the extra per-frame colour conversion GPU work pushed the shared GPU/IOKit command-buffer arbiter into a state where WindowServer could no longer get its display compositing work through in time. WindowServer's render-server thread kept trying but made no progress. Main thread blocked waiting for render-server. HID events stopped being processed. 40 seconds later, the service-process watchdog fired and killed WindowServer.

The rest of the system was technically still alive during this period — kernel was running, other processes existed — but with WindowServer dead, the display and HID inputs were non-functional. No userspace recovery was possible.

### What was tried (briefly)

Removed `AVVideoColorPropertiesKey` from `RawStreamWriter` entirely. Kept it on `WriterActor` (composited HLS writer) where it's safe because `CompositionActor.compositeFrame` renders directly into Rec. 709 via `ciContext.render(..., colorSpace: CGColorSpace(name: .itur_709))` — the declared output matches the input that CIContext produces, so no conversion is needed. Camera pixel buffers are still tagged Rec. 709 via attachment propagation in `CameraCaptureManager`'s delegate callback, which AVAssetWriter honours when no explicit output colour properties are set.

### What we don't know

- Whether keeping `AVVideoColorPropertiesKey` on the raw camera writer specifically (where the input buffers ARE tagged Rec. 709 from our manual attachment) would have been safe. We removed it from both writers conservatively.
- Whether the colour conversion was the primary cause or just the straw that broke the camel's back on top of the 3× H.264 load.
- The exact threshold at which adding one more GPU operation tips the system from "userspace-recoverable degradation" into "kernel wedge".

### Key lessons

1. **`AVVideoColorPropertiesKey` is a conversion request, not a metadata annotation.** If the declared output colour space differs from the input colour space, AVFoundation inserts a GPU conversion stage. It is not free.
2. **"Watchdog" is not "panic".** On Apple Silicon, GPU-resource contention manifests as a WindowServer watchdog timeout rather than a kernel panic. Diagnostic artifact lives at `/Library/Logs/DiagnosticReports/WindowServer*.ips`, not `*.panic`.
3. **The raw camera writer's output file is still correctly Rec. 709-tagged** even without `AVVideoColorPropertiesKey` on the writer, because `CameraCaptureManager.captureOutput` attaches the tags with `.shouldPropagate` and AVAssetWriter reads pixel-buffer attachments when no explicit output properties are set.

## Failure mode 3 — H.264 encoder back-pressure cascade (2026-04-11 13:06)

### Observed

After Phase 2 was implemented (raw screen writer moved to ProRes 422 Proxy on the dedicated ProRes engine), the app was validated at 1080p preset across two successive tests:

- Stage 1 (~30 s at 1080p): clean, no errors, 4.0 s segment cadence
- Stage 2 (~76 s at 1080p): clean, 18 middle segments at 4.0002 s mean with 15 ms total spread

When the user selected the 4K preset and hit record, the behaviour changed dramatically:

- ~5-second screen freeze at record start — mouse stopped, UI unresponsive
- System recovered on its own
- Recording continued in severely degraded state
- User stopped the recording after about 19 seconds

### Diagnostic evidence

No system-level diagnostic report for this incident. WindowServer did not watchdog — it recovered after the initial stall. The diagnostic evidence is entirely in the userspace logs.

**Recording session:** `ce156dc3-34a7-4224-a155-cee7535dfb7b` (slug `89d492ea`), saved to `/Users/danny/dev/loom-clone/server/data/ce156dc3-34a7-4224-a155-cee7535dfb7b/`

**Preset active at time of hang** (from `recording.json`):
```json
{"preset": {"bitrate": 18000000, "height": 2160, "id": "4k", "label": "4K", "width": 3840}}
```

**Segment durations from `recording.json`** (the headline symptom — healthy recordings maintain ~4.000 s per segment):

| Segment | Duration | Bytes | Observed bitrate |
|---|---|---|---|
| seg_000 | **5.085 s** | 350,753 | — |
| seg_001 | **5.408 s** | 1,258,928 | — |
| seg_002 | **1.445 s** | 6,696,170 | — |
| seg_003 | **3.968 s** | 19,931,958 | **40.2 Mbps instantaneous** (2.2× target) |
| seg_004 (trailing) | 2.970 s | 15,972,148 | — |

`seg_000` and `seg_001` are stretched — metronome fell behind while CIContext was stuck waiting. `seg_002` is abbreviated because the encoder caught up at an internal keyframe boundary. `seg_003` and `seg_004` are bursts of backed-up data being flushed at 2× the target bitrate.

**Error messages in Xcode console (thousands of occurrences):**

First occurrence (command-buffer timeout):
```
IOGPUMetalError: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)
-[_MTLCommandBuffer didCompleteWithStartTime:endTime:error:], line 1210: error 'Execution of the command buffer was aborted due to an error during execution.'
Error excuting command buffer = Error Domain=MTLCommandBufferErrorDomain Code=2 "Caused GPU Timeout Error" (com.apple.CoreImage.ci_affine_writeSIMD_420_colormatrix_clamp_to_alpha_swizzle_rgb1_premul_curve_unpremul_srcOver_blendWithMaskB0_crop_affine_colormatrix_curve_colormatrix_affine_srgb_to_linear_crop_swizzle_rrr1_affine_colormatrix_srgb_to_linear_colormatrix)
-[CIRenderTask waitUntilCompletedAndReturnError:] Unexpected error in the backing renderer
```

Subsequent cascades (command queue poisoned):
```
IOGPUMetalError: Ignored (for causing prior/excessive GPU errors) (00000004:kIOGPUCommandBufferCallbackErrorSubmissionsIgnored)
```

**The fused Core Image kernel name is diagnostic in itself.** Decomposing it:

- `420_colormatrix_clamp_to_alpha` — camera YCbCr 420 → RGB conversion
- `swizzle_rgb1_premul` → `curve_unpremul` — channel rearrangement and gamma curve
- `srcOver_blendWithMaskB0` — the circle-mask PiP overlay blend
- `crop_affine` → `colormatrix_curve_colormatrix` — cropping and colour transforms
- `affine_srgb_to_linear` — sRGB → linear gamma conversion on screen BGRA input
- `crop_swizzle_rrr1` → `affine_colormatrix_srgb_to_linear_colormatrix` — additional colour math

Core Image fused the entire compositing operation into a single Metal kernel. At 4K preset, this kernel processes 3840 × 2160 × 30 = 249 Mpx/s.

### Interpretation

At 4K preset, the composited HLS writer was configured for **3840×2160 H.264 at 18 Mbps** on top of the raw camera writer at 1280×720 H.264 at 12 Mbps. Both streams run on the single M2 Pro H.264 engine. The combined load:

| Configuration | H.264 engine load (megapixels per frame pair) | Outcome |
|---|---|---|
| 1080p preset (proven stable) | 1920×1080 + 1280×720 = **2.99 Mpx** | Stable, 4.000 s ± 8 ms segments |
| 1440p preset (untested at the time) | 2560×1440 + 1280×720 = **4.61 Mpx** | See failure mode 4 |
| 4K preset (observed broken) | 3840×2160 + 1280×720 = **9.21 Mpx** | Back-pressure cascade, 5s screen freeze |

At 4K preset the H.264 engine load was 3.08× the proven-stable 1080p baseline. The engine couldn't time-slice between 4K HLS encoding and 720p camera encoding fast enough. Back-pressure propagated:

1. 4K HLS encoder work stalls in the media engine
2. CIContext.render() command buffers submitted to the composited HLS writer's pixel buffer adaptor queue behind the stalled encoder commands
3. Each CIContext.render() call waits ~2 seconds, then Metal's command-buffer watchdog fires and returns `kIOGPUCommandBufferCallbackErrorTimeout`
4. First error poisons the CIContext's Metal command queue — every subsequent render submission is rejected with `SubmissionsIgnored` until the context is rebuilt
5. Metronome thread can't get composited frames, falls behind — segments stretch
6. WindowServer's display-compositing work briefly got stuck behind our stuck submissions in the shared arbiter — **this is why the 5-second screen freeze happened**
7. After the GPU watchdog killed our stuck submissions, WindowServer's command queue cleared and it recovered
8. Our recording limped on with stretched segments and bursts of backed-up encoder output

**This failure mode is distinct from failure mode 4** because it's userspace-recoverable. Failure mode 4 is a kernel-level deadlock that never resolves.

### What was tried (briefly)

The immediate response was to change the user-facing preset model so the composited HLS output never runs at 4K. Phase 2b replaced the 4K preset with a 1440p preset (2560×1440 @ 10 Mbps), on the hypothesis that 1440p's 1.78× pixel area increase over 1080p would stay within the H.264 engine's headroom. This turned out to trigger failure mode 4 instead.

### What we don't know

- Whether 4K preset would have eventually stabilised if left running for longer (the cascade we observed looked like an accelerating failure, not a recoverable one, but we don't have data past ~19 seconds)
- Whether any configuration of 4K composited HLS is achievable on M2 Pro — e.g. at dramatically lower bitrate, or with a different CIContext compositing strategy
- Whether the GPU watchdog threshold can be changed to give CIContext command buffers more time before they're killed (no known public API)

## Failure mode 4 — IOGPUFamily kernel deadlock (2026-04-11 13:32)

### Observed

After Phase 2b was implemented (1440p preset replacing 4K), the user immediately tested a recording at 1440p with display + camera + mic:

- User hit record
- Entire Mac froze **immediately** — no 5-second grace period, no visible start of the recording
- Mouse unresponsive, keyboard ignored
- No visible error dialog
- Waiting 40+ seconds produced no recovery
- Forced hard reboot via power button

This is the second kernel-level hang of the session. The symptoms looked identical to failure mode 2 from the user's perspective, but the underlying cause is completely different.

### Diagnostic evidence

**File:** `/Library/Logs/DiagnosticReports/WindowServer_2026-04-11-133259_danny.userspace_watchdog_timeout.spin`

This is a **spindump** (`.spin`) rather than a stackshot (`.ips`). Spindumps contain multiple samples of thread state over a time window, which gives more diagnostic detail than a single stackshot. This one captured 12 samples over 5.56 seconds.

**Report header:**
- `Date/Time: 2026-04-11 13:32:42.297 +0100`
- `End time: 2026-04-11 13:32:47.857 +0100`
- `Duration: 5.56s`
- `Steps: 12`
- `Reason: "(1 monitored services unresponsive): checkin with service: WindowServer (0 induced crashes) returned not alive with context: unresponsive work processor(s): WindowServer main thread 40 seconds since last successful checkin, 616 total successful checkins"`
- `Hardware model: Mac14,9`
- `Active cpus: 12`
- `Memory size: 32 GB`

#### WindowServer state

- Main thread (`ws_main_thread`, thread 0xed8) is on `DispatchQueue "com.apple.SkyLight.mtl_submit"`
- All 12 samples show the same stack: `dyld → WindowServer → SkyLight → SkyLight → SkyLight Metal submission internals`
- SkyLight is Apple's private display-compositing framework. The `mtl_submit` queue is where SkyLight submits display-composition Metal commands to the GPU. The main thread is blocked trying to submit.
- **Translation:** WindowServer is trying to push a display-compositing Metal command to the GPU and can't. Something else is holding the GPU.

#### LoomClone state (PID 28364)

LoomClone had been running for 65 seconds when the spindump captured it. The recording had been active for about 33 seconds before the freeze (derived from the "last ran N seconds ago" timings below).

**The single running thread:**

- **Thread 0x29f24** `com.apple.coremedia.formatwriter.qtmovie` — **5.560 s CPU time over the 5.56 s sampling window. 100% CPU utilisation for the entire spindump duration.**
- Stack samples show execution in various MediaToolbox / CoreMedia / CoreFoundation internal functions, with occasional callbacks into the LoomClone binary (at offsets ~29k-31k into the app binary)
- **No kernel syscalls in the running frames.** This thread is spinning in pure CPU code inside MediaToolbox — it is NOT stuck on disk I/O or waiting on kernel.
- This is the ProRes screen writer's format-writer worker thread.

**The parked threads (all downstream of the running thread, waiting for work that never arrives):**

| Thread | Name | Last ran |
|---|---|---|
| 0x29f26 | `com.apple.coremedia.mediaprocessor.videocompression` | 32.935 s ago |
| 0x29f29 | `com.apple.coremedia.mediaprocessor.videocompression` | 32.884 s ago |
| 0x29f3c | `com.apple.coremedia.mediaprocessor.videocompression` | 32.903 s ago |
| 0x29f32 | `com.apple.coremedia.formatwriter.qtmovie` | 32.913 s ago |
| 0x29f33 | `com.apple.coremedia.formatwriter.qtmovie` | 33.008 s ago |
| 0x29f10 | `DispatchQueue "CI::RenderCompletionQueue"` | 32.921 s ago (blocked in `psynch_cvwait`) |
| 0x29f14 | `DispatchQueue "CI::complete_intermediate"` | 32.921 s ago (blocked in `psynch_cvwait`) |
| 0x29e7d | Swift Task on `cooperative` queue — blocked inside a CoreImage render call | 32.927 s ago |
| 0x29ec0 | `com.apple.coremedia.videomediaconverter` | 35.916 s ago (10/12 samples on pthread_cond) |
| 0x29f23 | `com.apple.coremedia.mediaprocessor.audiocompression` | 21.086 s ago |

All of these have been idle for 32+ seconds. The recording pipeline started, ran for ~8 seconds, and then every thread except one froze in place.

**The smoking-gun thread:**

- **Thread 0x29ea7** `DispatchQueue "com.apple.videotoolbox.preparationQueue"` — last ran **0.854 s ago** (the only thread apart from the spinner making any forward progress)
- Stack trace identical across all 12 samples:

```
VideoToolbox internal preparation
  → IOSurface (userspace) allocation
  → IOKit user client syscall
  → kernel → IOSurface kernel extension
  → IOGPUFamily kext + 60444
  → IOGPUFamily kext + 58728
  → kernel wait
```

**This thread is stuck inside the IOGPUFamily kernel extension waiting for a hardware-backed IOSurface.** Every ~1 second it briefly resumes (hence "last ran 0.854 s ago"), re-tries the IOGPU call, and blocks again. It's in a tight kernel-wait loop with zero forward progress — which is why the "last ran" timestamp is more recent than the 32 seconds of its parked peers.

#### Downstream processes

**VTEncoderXPCService [28437]** — the out-of-process VideoToolbox encoder helper. This process does the actual video encoding work and communicates with LoomClone over XPC:

| Thread | Last ran |
|---|---|
| `ProResFrameReceiver` | 32.913 s ago |
| `AVE_UCRecv` (Apple Video Encoder User Client Receive) | 32.903 s ago |
| `AVE_UCRecv` (second instance) | 33.008 s ago |
| Main thread | 33.052 s ago |

`ProResFrameReceiver` is the thread that receives raw screen frames from LoomClone to encode them as ProRes. It stopped receiving 33 seconds ago. `AVE_UCRecv` threads wait for completion interrupts from the hardware video encoder — they're parked too. **The hardware video encoder is no longer delivering work completions to VTEncoderXPCService.**

**replayd [754]** — the ScreenCaptureKit capture daemon:

| Thread | Last ran |
|---|---|
| Main thread | 22.887 s ago |
| user-initiated queue | 33.889 s ago |

**replayd is also parked.** The screen capture daemon has stopped producing screen frames.

**Importance donation trail.** LoomClone's threads are annotated `process received importance donation from replayd [754], process received importance donation from VTEncoderXPCService [28437]`. Importance donation means: process X has an XPC operation pending against process Y and has boosted Y's scheduling priority to expedite it. Both replayd and VTEncoderXPCService donated priority to LoomClone, which tells us they are both **waiting on LoomClone to do something**, not the other way around. LoomClone can't do the something because its own preparation thread is stuck in IOGPUFamily.

### Interpretation

Unlike failure mode 3, this is not a userspace GPU watchdog cascade. There are **no `kIOGPUCommandBufferCallback*` errors** in the userspace logs for this incident. The failure is at a lower level — in kernel-side IOGPUFamily resource management, before command submission reaches the level where Metal's watchdog can see it.

The triangle of waits:

1. **LoomClone** — the metronome's Swift task is blocked inside a CoreImage render call. CoreImage is waiting for a pixel buffer from VideoToolbox's preparationQueue. VideoToolbox's preparationQueue is stuck in IOGPUFamily kernel wait.
2. **VTEncoderXPCService** — `ProResFrameReceiver` is waiting for LoomClone to send it more raw screen frames, which LoomClone can't do because its compositor thread is waiting on a pixel buffer that can't be allocated.
3. **replayd** — is waiting for LoomClone to acknowledge receipt of screen capture frames, which LoomClone can't do because everything is waiting on IOGPUFamily.

Meanwhile WindowServer is trying to submit display-compositing work through SkyLight's `mtl_submit` path. That path goes through the same IOGPUFamily kernel extension that our recording pipeline has locked up. **WindowServer is stuck because the kernel arbiter for hardware video IOSurfaces is also the arbiter for display-compositing surfaces.** Main thread blocks on the submission. 40 seconds of no check-in later, the service watchdog fires.

**The single spinning LoomClone thread is the consequence, not the cause.** The ProRes `formatwriter.qtmovie` thread is in a MediaToolbox internal retry loop — probably a `CMSimpleQueueDequeue` or similar, waiting for samples from the frame receiver. Samples will never come (because the frame receiver is parked in VTEncoderXPCService, waiting on the kernel). It's burning CPU without accomplishing anything useful.

### Why 1440p and not 1080p?

The only meaningful differences between the proven-stable 1080p preset and the deadlock-triggering 1440p preset:

1. Compositor output canvas: 1920×1080 → 2560×1440 (1.78× pixel area)
2. Composited HLS H.264 encoder input size: same 1.78× larger
3. Composited HLS bitrate: 6 Mbps → 10 Mbps (1.67×)
4. Output pool IOSurface size: 8.3 MB → 14.7 MB per buffer
5. PiP overlay diameter: 240 px → 320 px

None of these individually should trigger a kernel deadlock. We do not know which one (or which combination) tips IOGPUFamily into the failure mode.

### The research assumption that broke

Phase 2 was built on a specific research finding: "ProRes engine is separate silicon from the H.264 engine, so offloading the raw screen writer to ProRes 422 Proxy frees the H.264 engine to handle the two remaining H.264 streams." This was based on WWDC material, Softron documentation, Apple's M2 Pro spec page, and OBS community reports about using ProRes to relieve encoder contention.

**That finding is true at the hardware-engine level.** ProRes and H.264 ARE separate silicon blocks. The architectural claim wasn't wrong in spirit.

**What we didn't know is that they still share IOGPUFamily at the kernel level.** IOGPUFamily is the kernel extension that manages IOSurface allocation for all hardware-accelerated video work. Both ProRes sessions and H.264 sessions allocate their working buffers (input and output) through the same IOGPUFamily path. When IOGPUFamily hits a resource contention state it can't resolve, it doesn't matter that the actual encoders are on different silicon — they all starve for buffers.

This is a gap in publicly-available Apple developer documentation. We could not find any Apple material describing IOGPUFamily's scheduling behaviour, its resource limits, or the specific conditions that cause it to deadlock. We did not know this layer even existed as a potential bottleneck before this incident. It is possible (probable?) that Apple has internal documentation and/or engineer knowledge of these limits that we do not have access to.

### What was tried

Nothing. This diagnostic is being written before any further code changes. The current working tree still has Phase 2b in place, and attempting to record at 1440p will reproduce this deadlock.

### What we don't know (this is a lot)

- Whether this deadlock exists at other output resolutions between 1080p and 1440p
- Whether lower composited HLS bitrate (e.g. 7–8 Mbps) at 1440p would avoid it
- Whether reducing screen capture resolution (e.g. from native 4K to display-points 1920×1080) would change the IOSurface memory pressure enough to avoid it
- Whether `VTCompressionSessionPrepareToEncodeFrames` (an API we don't currently call) would pre-allocate IOSurface resources in a way that avoids the deadlock
- Whether any of the VideoToolbox session properties we don't currently set (`kVTCompressionPropertyKey_RealTime`, `MaxFrameDelayCount`, `MaximizePowerEfficiency`, priority hints) affect IOGPUFamily's resource allocation behaviour
- Whether changing ScreenCaptureKit's `SCStreamConfiguration.pixelFormat` (currently default BGRA) to YCbCr 420 would reduce IOSurface pressure
- Whether this is a documented Apple limit we're exceeding, or an undocumented IOGPUFamily bug
- Whether Apple Silicon Max/Ultra chips with multiple media engines (and potentially different IOGPUFamily scheduling) avoid this entirely
- Whether Cap, Screen Studio, Loom, or Riverside have hit this and worked around it (Cap is open-source; we can read the code)

### Key lessons

1. **IOGPUFamily is a shared kernel-level arbiter across all hardware video engines.** Engine separation at the silicon level does not imply independent resource management at the kernel level. Any work that ends up allocating IOSurfaces through IOGPUFamily competes with any other such work, regardless of which engine it targets.
2. **Kernel-level GPU resource deadlocks are invisible to userspace GPU error monitoring.** Metal's command-buffer watchdog fires on specific submitted command buffers that take too long to complete. It does not fire when a thread is stuck waiting for IOGPUFamily to hand out a new buffer, because there's no command buffer yet. Userspace has no visibility into this condition until the whole system has wedged.
3. **WindowServer's watchdog is the only thing that reliably fires in this state**, and it does so ~40 seconds after the hang starts — long enough that by the time the diagnostic is generated the user has already hard-rebooted.
4. **Phase 2's architectural premise was incomplete.** "Move one writer to different silicon" is necessary for avoiding H.264 engine contention but not sufficient for avoiding all GPU-level contention. The full mental model needs to include IOGPUFamily as a shared resource below both engines.

## Cross-cutting observations

### Severity tiers and how to tell them apart

| Tier | Userspace GPU errors visible? | WindowServer affected? | Recoverable without reboot? | Examples |
|---|---|---|---|---|
| Degraded | Yes (`kIOGPUCommandBufferCallback*`) | No | Yes | Failure mode 1 |
| Userspace cascade | Yes (cascades to `SubmissionsIgnored`) | Briefly (recoverable) | Yes, with degraded output | Failure mode 3 |
| Kernel wedge | No or not directly caused by our work | Yes, main thread stuck | **No — hard reboot required** | Failure modes 2 and 4 |

### Why WindowServer is always the collateral damage

Our recording pipeline and WindowServer share two critical resources:

1. **The unified GPU.** CIContext uses it for compositing; WindowServer's SkyLight uses it for display compositing. Metal command buffers from both arbitrate through the same IOKit front-end.
2. **IOGPUFamily.** Both our hardware video encoders and WindowServer's display compositing allocate IOSurfaces from this kernel extension.

There is no way for our app to run at the user level without sharing these resources with WindowServer. When something in our pipeline gets stuck holding those resources, WindowServer can't get through. The M2 Pro has no independent compositing path for WindowServer to fall back to. This means **any GPU/IOGPU deadlock in our app can take down the whole UI of the user's Mac**, even though our app is just a regular sandboxed application.

### Three things that worked stably on M2 Pro

For the record:

1. **Single-H.264-writer composited HLS at 1080p @ 6 Mbps** — this worked fine even in the original pre-task scenario. It's the baseline.
2. **Two-H.264-writer setup at 1080p preset + ProRes raw screen at native 4K** — the Phase 2 configuration at 1080p preset. Stage 1 (30 s) and Stage 2 (~76 s) tests passed cleanly with 4.000 ± 0.008 s segment cadence. This is the only confirmed-stable configuration we have that includes a raw screen master file.
3. **Everything parked and idle** — the app in its menubar state between recordings uses negligible resources. No contention.

Everything else we tried either degraded, cascaded, or hung.

## How to identify these failure modes in future reports

When investigating a new hang or recording failure:

1. **Check `/Library/Logs/DiagnosticReports/` first.** Look for `WindowServer*.ips` or `WindowServer*.spin` files dated around the incident time. Also check `~/Library/Logs/DiagnosticReports/` for user-level crashes.
2. **Identify the severity tier.** Does the report exist at all? If yes → kernel wedge tier (failure modes 2 or 4). If no → probably userspace cascade (failure mode 3) or degraded (failure mode 1). In that case the evidence is only in Xcode console logs and the segment cadence in `recording.json`.
3. **If there's a WindowServer report, check `bug_type`.** `409` with `WATCHDOG` namespace = userspace watchdog timeout (our pattern). `210` or similar would be kernel panic (not our pattern — would imply different cause).
4. **If there's a WindowServer report, check LoomClone's thread list:**
   - **`com.apple.coremedia.videomediaconverter` thread present and active** → failure mode 2 pattern (colour space conversion forced by writer config somewhere)
   - **`com.apple.videotoolbox.preparationQueue` stack deep in `IOGPUFamily` kext** → failure mode 4 pattern (kernel IOGPU deadlock)
   - **`com.apple.coremedia.formatwriter.qtmovie` at ~100% CPU with every other pipeline thread parked for 20+ seconds** → failure mode 4 pattern (downstream consequence of the IOGPU wait)
   - **Multiple `mediaprocessor.videocompression` threads active and running (not parked)** → failure mode 1 or 3 pattern (encoder contention under heavy concurrent load)
5. **If there's a WindowServer report, check WindowServer's own main thread:**
   - Blocked on `com.apple.SkyLight.mtl_submit` → GPU is held, consistent with failure modes 2 and 4
   - Blocked on anything else → different cause, look elsewhere
6. **Userspace log patterns:**
   - `kIOGPUCommandBufferCallbackErrorTimeout` as first occurrence → userspace watchdog fired on a stuck Metal submission (failure modes 1, 3)
   - `kIOGPUCommandBufferCallbackErrorSubmissionsIgnored` cascading → command queue poisoned, pipeline in degraded state (failure modes 1, 3)
   - No userspace GPU errors but system still hung → failure mode 4 pattern (kernel-level, below watchdog visibility)
7. **Correlate with the active preset.** Check `recording.json` (if any) for the `preset` field. Presets above 1080p have triggered failure modes on M2 Pro; 1080p is the only stable configuration we've validated.

## Open research questions

Things we cannot answer from publicly available information, that would significantly improve our model of this system:

1. **What is the documented concurrent hardware video session limit on M1/M2/M3 Pro chips?** Apple does not publish one. The best signal we have is OBS community reports of 2 concurrent 4K H.264 streams being the practical limit on single-engine chips.
2. **What specific conditions cause IOGPUFamily to deadlock** rather than back-pressure gracefully? We have one data point (1440p with three writers + CIContext) and no way to generalise.
3. **Are there VideoToolbox session properties that affect IOGPUFamily resource allocation behaviour?** `kVTCompressionPropertyKey_RealTime`, `MaxFrameDelayCount`, `MaximizePowerEfficiency`, `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder`, pool sizing hints — we don't currently set any of these and don't know if they'd help.
4. **Does Apple publish any sample code** that runs more than 2 concurrent hardware video sessions? We couldn't find any in our initial research. If the answer is "no", that's itself a signal about what Apple considers reasonable practice.
5. **What is the IOSurface pool sizing strategy** for ScreenCaptureKit and `AVAssetWriterInputPixelBufferAdaptor`, and is any of it tunable?
6. **How do Cap, Screen Studio, Loom, and Riverside handle this on Apple Silicon Pro chips?** Cap is open-source — we should read the relevant parts of its codebase to see what patterns it uses and whether it avoids our failure modes.
7. **Does `VTCompressionSessionPrepareToEncodeFrames`** (an API we don't currently call) pre-allocate IOSurface resources in a way that would prevent allocation stalls mid-recording?
8. **What's the IOSurface memory footprint cliff?** At 1080p preset the total IOSurface working set across all writers + compositor + capture fits in some footprint we know is safe. At 1440p something broke. We don't know if it's a raw memory limit, a pool-count limit, a per-surface-size limit, or something more subtle.

## Resolution (2026-04-14)

The failure sections above are the ground-truth record of what happened. This section records what we did after the 2026-04-11 hangs, what we tested, and the current state of each failure mode. The detailed audit trails for each piece of work live in their own docs — this section is the narrative that ties them together.

### What we applied — VideoToolbox best-practice tunings

Seven tunings were considered from the research pass (`docs/research/11-m2-pro-video-pipeline-deep-dive.md`), derived by auditing what OBS, Cap, HandBrake, and FFmpeg ship on Apple Silicon. Five were applied to both the main app and the test harness; two turned out to be unreachable through `AVAssetWriter`'s public API and were deferred.

Applied:

1. **`SCStreamConfiguration.pixelFormat = 420v`** (`kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`). Matches what every other production screen recorder ships. OBS issue #5840 documents this as "the format that makes the HW VideoToolbox very reliable" on M1/M2. Halves per-frame screen IOSurface bytes vs BGRA. (`ScreenCaptureManager.swift`)
2. **Writer warm-up reordering.** `writer.startWriting()` moved from `commitRecording()` into `prepareRecording()`, called before `SCStream.startCapture()` opens. Gives VideoToolbox time to allocate encoder resources before frames start arriving — directly addresses the `preparationQueue` stall the failure mode 4 spindump shows. (`RecordingActor.prepareRecording`)
3. **`kVTCompressionPropertyKey_RealTime = kCFBooleanFalse`** on all H.264 writers. Counter-intuitive, but the OBS community reports `RealTime = true` causes heavy frame drops on M1/M2; false/unset is the reliable default. (`WriterActor`, `RawStreamWriter(.videoH264)`)
4. **`AVVideoAllowFrameReorderingKey = false`** on all H.264 writers. Disables B-frames and their reorder buffer. HLS doesn't need them. (same files)
5. **`kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = true`** on all H.264 writers. Makes silent software fallback impossible — `startWriting()` throws loudly with a VT error if hardware isn't available. Safety net, not a fix. (same files)

Deferred (not reachable through `AVAssetWriter`):

6. **`kVTCompressionPropertyKey_MaxFrameDelayCount` bounding.** `AVAssetWriter` hardcodes a value of `3` for H.264 and throws `NSInvalidArgumentException` for any other value, and rejects compression-properties dicts entirely on ProRes. Reachable only via direct `VTCompressionSession`.
7. **`PixelBufferPoolIsShared` audit.** Property lives on the internal `VTCompressionSession` which `AVAssetWriter` doesn't expose.

Per-tuning detail including what was tried, what rolled back, and why two tunings couldn't land: `docs/task-1-tunings-audit-2026-04-14.md`.

### What we tested — isolation test harness

A standalone diagnostic target at `app/TestHarness/` was built to exercise writer / compositor / capture combinations against synthetic frames outside the main app. The intent was to answer, against data rather than speculation, whether the post-task-1 pipeline was stable at the configuration that hung the Mac, and to run reverse-sweeps identifying which specific tuning was load-bearing.

Results on synthetic content:

- **Tier 1** (single component in isolation): 7 configs, all PASS.
- **Tier 2** (two-writer combinations): 6 configs, all PASS.
- **Tier 3** (three-writer combinations, including **T3.2 — the literal 2026-04-11 13:32 configuration reconstructed**): 6 configs, all PASS including T3.2.

The Tier 3 result says one clear thing: **the writer shape alone is not the sole trigger for failure mode 4.** Post-task-1, the same writer configuration that wedged the Mac runs cleanly against synthetic input.

Caveat worth writing down: synthetic "moving pattern" content in 420v compresses 3–4× more efficiently than real `SCStream` output, so the synthetic H.264 encoder runs at 20–30% of its target bitrate — materially less load than real capture produces. **Tier 4 (real-capture replacement) was meant to close that gap but didn't.** The harness's `SCStream` delivery path develops a latent back-pressure bug when writers are attached — delivery collapses from ~30 fps (no writers) to ~0.4 fps (any writer attached). Three attempted fixes didn't resolve it. Task-2 closed without Tier 4 evidence rather than chase a harness bug indefinitely.

Full write-up with baselines, per-tier analysis, and the Tier 4 failure mode: `docs/task-2-harness-findings-2026-04-14.md`. Baselines at `test-runs/tier-{1,2,3}-baseline-*.md`.

### What we validated on the main app — 2026-04-14

Two recordings on the post-task-1 main app against the same M2 Pro, same Sony ZV-1 camera, same BenQ EW2780U 4K display that was attached on 2026-04-11:

| Preset | Duration | Mode switches | HLS achieved / target | Raw screen | Raw camera | Hangs |
|---|---|---|---|---|---|---|
| 1080p | 71 s | 4 | 4.6 Mbps / 6 Mbps (77%) | ProRes 4K @ 121 Mbps | H.264 720p @ 12 Mbps, 25 fps | none |
| **1440p** | **62 s** | **3** | **8.05 Mbps / 10 Mbps (80%)** | **ProRes 4K @ 135 Mbps** | **H.264 720p @ 12 Mbps, 25 fps** | **none** |

Both recordings: zero `kIOGPUCommandBufferCallback*` errors, healthy 4 s HLS segment cadence, all segments uploaded successfully, playback verified in the web viewer.

SCStream's actual delivery rate on the main app under the full Phase 2b writer load is ~28 fps (measured from the ProRes packet count over the recording duration). The main-app pipeline is healthy under real load. For reference: the harness reports ~0.4 fps in the same writer shape, which — given the main app works — is a harness-specific bug and not a product problem.

### The one quality trade-off — ProRes chroma subsampling

Task-1 tuning 1 (`pixelFormat = 420v`) is the one change that has a measurable quality cost. SCStream now delivers 4:2:0 YUV 8-bit where previously it delivered 4:4:4 BGRA 8-bit. The raw ProRes master file reports `yuv422p10le` (4:2:2 10-bit) in its container, but the extra chroma precision is upsampled from the 4:2:0 source — not recovered information.

For typical screen content (text, UI, app windows, code editors) this is imperceptible. It might be visible on close inspection of:

- Very thin coloured text or lines (e.g. syntax-highlighted code on dark backgrounds).
- Fine chroma-heavy graphics (dashboard gradients, tight coloured edges, small coloured icons).

This is the chroma subsampling OBS, Cap, and FFmpeg all ship for screen capture. WWDC22/10155 recommends `420v` explicitly "for encoding and streaming." Accepted trade-off.

No other quality characteristics changed — H.264 High profile, target bitrates, audio codec/bitrate, resolutions, frame rates are all as before.

### Failure-mode status after resolution

| # | Failure mode | Status |
|---|---|---|
| 1 | Degraded segment cadence | **Avoided by shape, not by tuning.** The Phase 2 move to ProRes for the raw screen writer (pre-task-1) eliminated the third concurrent H.264 session, which was the trigger. Not directly re-tested at its triggering shape — there's no configuration on `main` that reproduces three concurrent H.264 writers. |
| 2 | GPU colourspace conversion wedge | **Resolved by Phase 1**, before task-1. Rec. 709 attachment tagging happens explicitly on camera buffers (`CameraCaptureManager`); `AVVideoColorPropertiesKey` is only declared on writers whose input actually matches. Not re-triggered since. |
| 3 | H.264 encoder back-pressure cascade | **Avoided by shape, not by tuning.** Same story as mode 1 — Phase 2's ProRes offload removed the triggering configuration. |
| 4 | IOGPUFamily kernel deadlock | **Resolved in practice by task-1.** The exact configuration that hung the Mac on 2026-04-11 13:32 now runs cleanly under real load on the main app at 1440p (see validation table above). We have not isolated which specific tuning is load-bearing — that was blocked on Tier 5 reverse-sweeps, which couldn't run without the Tier 4 real-capture reproduction the harness couldn't produce. |

### What remains unknown

Failure mode 4 is resolved in practice but only partially explained:

- **Which specific tuning carries the stability weight.** We applied five tunings at once. The combined set works; no reverse-sweep has isolated whether it's `420v`, warm-up ordering, `RealTime = false`, `AllowFrameReordering = false`, or some specific combination that matters. Reverse-sweeping requires a reproducing real-capture configuration.
- **Whether the hang can re-emerge under edge conditions** — specific display configurations, thermal pressure, prolonged recording, specific content patterns. We've validated ~60 s at 1440p; longer-duration validation hasn't happened yet.
- **The full kernel-side interaction** between SCStream's IOSurface pool and VideoToolbox's encoder pool that underlies the original deadlock. The spindump evidence shows the symptom (`IOGPUFamily` blocked on `preparationQueue`); the proximate cause is understood; the architectural root (why this specific combination of pools and engines deadlocks on M2 Pro specifically) remains a partial model.

If the hang reappears under any condition, this document plus `docs/task-2-harness-findings-2026-04-14.md` is the starting material. First concrete step would be fixing the harness's real-capture delivery bug so Tier 5 reverse-sweeps become runnable.

## Related documents

- `docs/task-1-tunings-audit-2026-04-14.md` — detailed audit of each of the seven tunings: what the research flagged, what was already in place, what was applied, what was tried and rolled back, what was deferred and why
- `docs/task-2-harness-findings-2026-04-14.md` — close-out narrative of the harness work: what the synthetic tiers showed, the Tier 4 real-capture bug, and why task-2 closed without that evidence
- `docs/research/11-m2-pro-video-pipeline-deep-dive.md` — research pass that produced the twelve hypotheses (H1–H12) behind the tunings and sweep priorities
- `docs/tasks-done/task-2026-04-14-1-videotoolbox-best-practice-tunings.md` — the task doc for the tunings work
- `docs/tasks-done/task-2026-04-14-2-run-test-harness-tests.md` — the task doc for the harness work
- `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` — the placeholder task doc that now gates on main-app validation (to be rewritten once validation produces a clear outcome, or closed if the 2026-04-14 validation stands)
- `docs/tasks-done/task-2026-04-11-0A-encoder-contention-and-camera-pipeline.md` — the Phase 1 / 2 / 2b record including failure modes 2 and 4's historical incident callouts
- `docs/tasks-done/task-2026-04-11-0A-source-selection-and-raw-recording.md` — the predecessor task that added raw local recording (the reason we have three concurrent writers in the first place)
- `docs/requirements.md` — product requirements, specifically the "Quality" section, which documents the composited-vs-capture resolution separation that underlies the Path B/C/D/F options in task-4
- `docs/research/01-macos-recording-apis.md` — original research phase on ScreenCaptureKit, AVAssetWriter, CoreImage architecture
- `app/TestHarness/README.md` — the harness itself, including the "Active limitations" section documenting the Tier 4 real-capture bug

## Primary source diagnostic files

These files are the raw evidence for the failures documented above. **They will eventually be rotated out of `/Library/Logs/DiagnosticReports/`** — the retention period is bounded by macOS. The critical information from each has been inlined into the failure mode sections above, but while they still exist on disk, they are worth preserving:

| Failure mode | File | Size | Key content |
|---|---|---|---|
| 2 | `/Library/Logs/DiagnosticReports/WindowServer-2026-04-11-114809.ips` | ~3 MB | Stackshot with `videomediaconverter` thread in LoomClone, WindowServer main thread stuck, bug_type 409 |
| 4 | `/Library/Logs/DiagnosticReports/WindowServer_2026-04-11-133259_danny.userspace_watchdog_timeout.spin` | ~4.7 MB | Spindump (12 samples) with `videotoolbox.preparationQueue` stuck in IOGPUFamily kext, ProRes format-writer at 100% CPU, every other pipeline thread parked |

Recording artifacts that exist for failure mode 3 (no system-level diagnostic, but recording session was saved):

- Server-side: `/Users/danny/dev/loom-clone/server/data/ce156dc3-34a7-4224-a155-cee7535dfb7b/` (recording.json, init.mp4, seg_*.m4s, stream.m3u8)
- Local: `/Users/danny/Library/Application Support/LoomClone/recordings/ce156dc3-34a7-4224-a155-cee7535dfb7b/` (same plus raw masters screen.mov, camera.mp4, audio.m4a)

If this document outlives those files, the key facts from each have already been inlined into the failure mode sections above. But while the files still exist, having them intact is valuable — particularly the `.spin` file, which is the single best artefact we have for reporting failure mode 4 to Apple DTS.
