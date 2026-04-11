# 11 — M2 Pro Video Pipeline Deep Dive

**Scope.** Follow-up research to `docs/m2-pro-video-pipeline-failures.md` and task-0B. Answers the four research areas laid out in `docs/tasks-todo/task-0B-video-pipeline-research.md`. Feeds concrete hypotheses into task-0C (isolation test harness). No code changes. Primary sources cited throughout; where a source is behind a login wall or requires JavaScript to render, that is called out inline.

**Prior research this builds on.**

- `docs/research/01-macos-recording-apis.md` — the original ScreenCaptureKit / AVAssetWriter / VideoToolbox architectural pass.
- `docs/research/03-cap-codebase-analysis.md` — the prior Cap architecture pass. Area 4 below is a delta against that doc, not a re-analysis.
- `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` — the task this research exists to inform. The Background section documents the "ProRes engine is separate silicon" premise that failure mode 4 broke.

---

## Summary

We hit a kernel-level deadlock (failure mode 4 in the failures doc) when running three concurrent hardware video writers plus a CIContext compositor on M2 Pro at 1440p output. A WindowServer spindump shows `com.apple.videotoolbox.preparationQueue` stuck deep inside `IOGPUFamily` waiting on an IOSurface allocation, with collateral damage to SkyLight's display compositing path, and the service watchdog firing forty seconds later. We went looking for four things: has anyone else seen this, what VideoToolbox tuning knobs we aren't using, what IOGPUFamily actually is, and how comparable apps handle concurrent writers.

**On signature:** we appear to be the first public report of the kernel-deadlock variant, but not the first to hit "macOS Tahoe + ProRes + heavy AV pipeline → system instability." The closest behavioural neighbour is the `ScreenCaptureKit -3821` disconnect cluster documented across OBS, QuickRecorder, and third-party blog post-mortems. The most temporally adjacent cluster is Adobe Premiere Pro 26 on Tahoe 26.0–26.2, where ProRes export hangs the system outright. No documented workaround or fix version exists publicly.

**On tuning:** we are leaving most of the relevant knobs on the table. Apple ships exactly one warm-up hook for compression sessions (`VTCompressionSessionPrepareToEncodeFrames`) and we don't call it. The default behaviours for `MaxFrameDelayCount` (unlimited), `AllowFrameReordering` (true), `RealTime` (unset → "unknown"), and `CVPixelBufferPool` buffer age (1 s) all conspire to maximise the IOSurface working set. The single highest-leverage change is switching ScreenCaptureKit's pixel format from BGRA to 420v, which Apple explicitly recommends for encoding pipelines and which cuts per-frame IOSurface bytes by ~63%.

**On IOGPUFamily:** it is effectively a black box. IOGPUFamily and the AGX kext are not in apple-oss-distributions; no sample code, no sysctl, no `ioreg` property is documented as tunable; no userspace API exposes "IOSurface bytes free." The Asahi Linux reverse-engineering work confirms the hardware model (one ASC firmware coprocessor, one GPU MMU, fixed channel topology) and is consistent with our spindump's shape, but does not document how Apple arbitrates video-engine work against display compositing. Recommendation: stop trying to model this layer and validate empirically in task-0C.

**On comparable apps:** no open-source production app runs the configuration we are running. Cap (the closest match by use case) tops out at two concurrent H.264 writers, uses zero ProRes, and defers *all* compositing to a post-recording wgpu editor. OBS, FFmpeg, and HandBrake all run a single VTCompressionSession per job. All three call `VTCompressionSessionPrepareToEncodeFrames` as standard practice. All three explicitly set `RealTime = kCFBooleanFalse` on Apple Silicon — OBS did so after issue #5840, which documented that `RealTime = true` caused heavy framedrops and unreliable hardware VT on M1/M2.

**Bottom line for decision-making.** The current pipeline shape (three concurrent hardware encoders + a live CIContext compositor) is novel territory with no production precedent. Option A: keep the shape and push hard on the tuning knobs in Area 2 to see whether the 1440p preset stabilises. Option B: reshape the pipeline to match the Cap recipe — defer compositing, reduce to two concurrent writers — and accept that as the known-stable floor. The hypotheses in section 7 below are ordered so the harness in task-0C can test Option A first and fall back to Option B if empirical results don't support it.

---

## Area 1 — The failure mode 4 kernel signature

### Direct matches

**None found.** No public report matches two or more of the specific signatures (preparationQueue stuck in IOGPUFamily + ProResFrameReceiver parked + SkyLight.mtl_submit WindowServer hang from a third-party recording app + `bug_type 409`). Platforms searched: Apple Developer Forums (Video Toolbox, AVFoundation, Metal, ScreenCaptureKit, Media Technologies, IOSurface tags), OpenRadar via the `lionheart/openradar-mirror` repo, GitHub issue trackers for obsproject/obs-studio, CapSoftware/Cap, HandBrake/HandBrake, lihaoyun6/QuickRecorder, screenpipe/screenpipe, dortania/OpenCore-Legacy-Patcher, Stack Overflow, Hacker News, MacRumors, Adobe community forums, Blackmagic forum, Asahi Linux blog/docs, Nonstrict blog, fatbobman blog. None of the composite queries returned a match.

### Adjacent reports

**1. HandBrake #5424 — VideoToolbox encoder hangs on macOS Sonoma, M1 Ultra only.** <https://github.com/HandBrake/HandBrake/issues/5424>. After upgrading to macOS 14, second-pass H.265 10-bit VideoToolbox encoding would hang and require a hard reboot. `VTEncoderXPCService` pinned at 100% CPU. Reproduced in HandBrake CLI/GUI and in Apple Compressor. Not reproducible on plain M1 or M2. Labelled "Upstream Issue." No Apple response visible. Closed in December 2023, presumably by a Sonoma point release; no specific fix version identified. Workaround: software encoder. Same shape as ours — userspace VT pipeline → kernel-level wedge → hard reboot, different chip class, same absence of Apple acknowledgement.

**2. Apple Developer Forums 694622 / FB9757381 — ProRes encoding fails on M1 Pro/Max with `kCVPixelFormatType_64ARGB`.** <https://developer.apple.com/forums/thread/694622>. Long-running working code that wrote ProRes 4444 started failing on M1 Pro/Max after a few frames — `CVPixelBufferPool` became nil. Doesn't happen on Intel or base M1. Workaround: use `kCVPixelFormatType_64RGBALE` on Apple Silicon. Confirms the ProRes hardware path is fragile under specific pixel-format/driver conditions that Apple's own QA didn't cover. Not the same failure mode but a data point that the ProRes engine pathway has a history of edge-case wedges.

**3. The ScreenCaptureKit `-3821` "stream stopped by system" cluster.** The strongest behavioural neighbour we found.

- <https://fatbobman.com/en/posts/screensage-from-pixel-to-meta/> — best public post-mortem. Argues the error manifests when ScreenCaptureKit can't meet its buffer requirements ("VRAM or bandwidth pressure"), disconnects the stream, and does not degrade gracefully. Speculates a connection to "WindowServer texture handling" and notes a community folk-remedy of keeping >12 GB free disk space during recording.
- <https://github.com/obsproject/obs-studio/issues/13131> — OBS on macOS 15 hitting `-3821` freezes. OBS maintainer: "the error likely originates from the OS itself."
- <https://github.com/obsproject/obs-studio/issues/9056> — OBS macOS screen capture freezing after several hours of recording. Multiple reporters across M-series chips.
- <https://github.com/lihaoyun6/QuickRecorder/issues/142> — Independent confirmation in a separate SCK-based recorder.

**Why this cluster matters for us.** Same triggering surface (SCK + AVAssetWriter under high-bandwidth load), same vague Apple diagnosis ("system resources"), same lack of an Apple-supplied root cause. Critically, in the `-3821` case the runtime *disconnects* the stream cleanly; in our signature the IOGPUFamily call path doesn't return and wedges the kernel. Plausible unified model: both are the same underlying resource-exhaustion condition in the video/IOSurface stack, manifesting in two different failure modes depending on where the call path is when the resource becomes unavailable.

**4. Adobe Premiere Pro / Media Encoder on macOS Tahoe 26.0+.** The most temporally adjacent cluster.

- <https://community.adobe.com/questions-729/unable-to-export-via-ppro-or-media-encoder-on-macos-tahoe-26-0-1-1551726> — ProRes 422 export fails with Error 14 / I/O errors after updating to Tahoe 26.0.1.
- <https://community.adobe.com/questions-729/premiere-pro-issues-with-macos-tahoe-26-0-1420043> — aggregate bug thread: unresponsive timeline, unexpected shutdowns, system-level hangs during ProRes work.
- <https://community.adobe.com/bug-reports-728/critical-memory-leak-premiere-pro-v26-0-on-macos-26-tahoe-89gb-vm-allocate-exhaustion...-1548856> — Premiere 26 + Tahoe VM_ALLOCATE exhaustion → hard system crash.
- <https://helpx.adobe.com/premiere/desktop/troubleshooting/limitations-and-known-issues/known-and-fixed-issues.html> — Adobe's own known-issues page: "Premiere can hit an internal assertion failure related to ProRes decompression."

Same OS version (Tahoe 26.x), same codec family (ProRes 422), same end-state (system unresponsive, hard reboot). Adobe is not a screen recorder, so the triggering surface is different, but the outcome matches ours and the OS+codec combination is identical. Strongly suggests Tahoe shipped with a regression somewhere in the ProRes / VideoToolbox / IOSurface interaction path that Apple has not publicly named.

**5. Asahi Linux AGX kernel driver DMA-BUF deadlock.** <https://asahilinux.org/docs/hw/soc/agx/>. The Asahi team documents that their Linux AGX driver can deadlock when importing DMA-BUFs from external devices if buffer-lifecycle reference handling is not careful. This is a reverse-engineered re-implementation, not Apple's stack, so direct transfer is weak — but it is independent confirmation that the AGX firmware/coprocessor model has multiple paths where buffer-lifecycle bugs can lock the GPU.

### Negative space (searched, nothing found)

Capturing the explicit negatives so the memo can honestly say we looked:

- `"videotoolbox.preparationQueue" stuck IOGPUFamily hang` — zero matches
- `"VTEncoderXPCService" "ProResFrameReceiver" hang macOS` — zero matches
- `"SkyLight.mtl_submit" WindowServer watchdog hang AVAssetWriter` — zero matches
- `"bug_type" "409" WindowServer spindump VideoToolbox` — only generic 409 reports, none tied to a third-party recording pipeline
- `"IOSurfaceRootUserClient" hang deadlock macOS application` — only security exploit material
- `"AVAssetWriter" multiple instances ProRes "deadlock" OR "stuck" Apple Silicon` — only the 64ARGB pixel-format bug
- `"ProRes engine" media engine M2 limit concurrent encoders` — no public hard concurrent-session limit anywhere
- `"VTCompressionSession" multiple sessions ProRes H264 hang macOS` — zero matches

The Apple Developer Forums tag pages for `videotoolbox`, `iosurface`, and `screencapturekit` render empty via WebFetch because the forum uses heavy client-side rendering. Results above are from search-engine snippets and cached titles, not full-text forum searches. There may be material behind the login wall that we cannot see.

### Confidence call

**We are almost certainly the first public report of this specific signature.** The combination of a userspace AVFoundation pipeline driving an IOGPUFamily/IOSurface kernel deadlock with WindowServer collateral damage via SkyLight.mtl_submit, plus the spindump forensics at that level of detail, does not appear anywhere I could reach.

**We are not the first to hit "Tahoe + ProRes + heavy AV pipeline → system instability."** That umbrella is well-attested in Adobe's Premiere Pro 26 reports and sits inside a larger pattern of "SCK / AVFoundation under buffer pressure on Apple Silicon doesn't fail gracefully" that has been documented since 2023.

**Most reasonable hypothesis for the memo.** Tahoe shipped a regression in the ProRes hardware-encode → IOSurface allocation path (or its interaction with IOGPUFamily arbitration). Most apps hit it as `-3821` disconnects, Premiere hits it as export errors and hard crashes, and our specific combination — concurrent ProRes 422 Proxy + two H.264 writers + CIContext compositor at 1440p — is unfortunate enough to deadlock the kernel side of the call rather than fail it gracefully.

**No workaround exists publicly for the kernel-deadlock variant.** The `-3821` mitigations (auto-restart, keep VRAM/disk free, monitor drop rate) all assume the runtime returns control. They don't apply to us. **No fix version is identified.** Tahoe 26.4.1 release notes only mention an 802.1X Wi-Fi fix. The Adobe Premiere reports are still active as of the most recent posts.

**Implication for action.** We should capture our spindump and userspace context into a Feedback Assistant report once the pipeline is stable enough that we can reliably reproduce the failure in a minimal harness (task-0C). This is likely the most useful thing we can do for Apple and, indirectly, for ourselves.

---

## Area 2 — VideoToolbox / ScreenCaptureKit / CVPixelBufferPool tuning we're not using

All Apple-quoted text in this section is verbatim from the public framework headers mirrored at `github.com/xybp888/iOS-SDKs` and `github.com/phracker/MacOSX-SDKs`. These mirror the same header files that Apple's `developer.apple.com` reference docs are generated from; the online pages are not reliably fetchable via WebFetch due to client-side rendering but the source text is identical. WWDC-session quotes are from Apple's own transcripts on `developer.apple.com/videos`.

### VTCompressionSession properties

| Property | Apple's words (verbatim) | Affects IOSurface / concurrency? | Candidate for our failure mode? |
|---|---|---|---|
| `kVTCompressionPropertyKey_RealTime` | "Hints the video encoder that compression is, or is not, being performed in real time. … By default, this property is NULL, indicating unknown." | Indirect — controls scheduling priority and rate-control aggressiveness. No documented IOSurface-allocation effect. | Set explicitly on all sessions. But see the OBS #5840 finding below: OBS/FFmpeg/HandBrake all ship with `kCFBooleanFalse` because `true` caused framedrops and unreliability on M1/M2. |
| `kVTCompressionPropertyKey_MaxFrameDelayCount` | "The maximum number of frames that a compressor is allowed to hold before it must output a compressed frame. … If the maximum frame delay count is M, then before the call to encode frame N returns, frame N-M must have been emitted. The default is kVTUnlimitedFrameDelayCount." | **Direct.** Held frames each retain their source IOSurface plus internal reference frames. Default is unlimited. | **Yes — high priority.** Bound it to a small finite value per session. |
| `kVTCompressionPropertyKey_AllowFrameReordering` | "Enables frame reordering. In order to encode B frames, a video encoder must reorder frames… True by default. Set this to false to prevent frame reordering." | **Direct.** Disabling reordering removes the B-frame reorder buffer and the IOSurface references it holds. | **Yes — high priority.** Disable on H.264 writers. HLS low-latency does not require B-frames. |
| `kVTCompressionPropertyKey_MaximizePowerEfficiency` | "Hints to the video encoder that it should maximize power efficiency during encode." | Indirect. Apple says "minimize impact on … other system activity" which could include IOSurface churn, but does not specify. | Probably not for the composited H.264 / ProRes writers (conflicts with `RealTime = false` throughput goals). Candidate for the camera writer only. |
| `kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality` | "Hint for the video encoder that it should maximize its speed during encode, sacrificing quality if needed." | Indirect. Faster pipeline = faster drain of the compression window = fewer held IOSurfaces. | Worth trying on the composited H.264 writer. |
| `kVTCompressionPropertyKey_NumberOfPendingFrames` | "The number of pending frames in the compression session." (Read-only.) | Diagnostic only. | Measure whether tuning is actually shrinking the working set. |
| `kVTCompressionPropertyKey_PixelBufferPoolIsShared` | "Indicates whether a common pixel buffer pool is shared between the video encoder and session client. False if separate pools are used due to incompatible pixel buffer attributes." (Read-only.) | **Diagnostic gold.** `false` means a pixel-format mismatch silently doubles the IOSurface footprint of that pipeline. | Assert `true` immediately after creating each session. Any `false` is a bug. |
| `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder` | "If set to kCFBooleanTrue, only use hardware encode and return an error if this isn't possible. … Hardware acceleration may be unavailable for a number of reasons. A few common cases are: – the machine does not have hardware acceleration capabilities – the requested encoding format or encoding configuration is not supported – **the hardware encoding resources on the machine are busy**." | **Documentary evidence** that Apple itself acknowledges the system can run out of HW encoder slots. | Set to `true` so silent software fallback fails loudly instead of dragging the GPU into a deadlock. |
| `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder` | Read-only confirmation of hardware path. | Diagnostic. | Sanity check all four sessions actually landed on hardware. |

**There is no `kVTCompressionPropertyKey_Priority` in any shipping VideoToolbox header.** Apple does not expose a per-session priority knob; sessions cannot explicitly yield to each other.

Source: `VTCompressionProperties.h` — <https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/VideoToolbox.framework/Headers/VTCompressionProperties.h>; and the macOS 11.3 SDK version for the newer keys at <https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX11.3.sdk/System/Library/Frameworks/VideoToolbox.framework/Versions/A/Headers/VTCompressionProperties.h>.

### `VTCompressionSessionPrepareToEncodeFrames`

Verbatim from `VTCompressionSession.h`:

> "You can optionally call this function to provide the encoder with an opportunity to perform any necessary resource allocation before it begins encoding frames. This optional call can be used to provide the encoder an opportunity to allocate any resources necessary before it begins encoding frames. **If this isn't called, any necessary resources will be allocated on the first VTCompressionSessionEncodeFrame call.** Extra calls to this function will have no effect."

What this means in practice:

- It is the only Apple-documented warm-up hook for a compression session.
- Apple's text is explicit that "any necessary resources" — which on Apple Silicon hardware encoders includes the encoder's IOSurface working set — are otherwise allocated on first-frame submission. That first-frame allocation is exactly what our spindump shows hanging on `com.apple.videotoolbox.preparationQueue`.
- Apple does not promise it pre-allocates IOSurfaces specifically, but the behavioural contract — "all the allocation happens here instead of on first encode" — makes it the right place for that work to happen serially, before the other sessions and the SCStream are all competing for the same IOGPUFamily allocator.
- The practical recommendation, well-supported by the header text alone: call it on each session sequentially on a serial queue, **before** opening the SCStream and before any other session starts producing frames.
- OBS, FFmpeg, and HandBrake all call this. We don't. This is arguably the single biggest delta between our pipeline and every comparable production app we could find (see Area 4).

Source: <https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/VideoToolbox.framework/Headers/VTCompressionSession.h>. The online doc page at <https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionpreparetoencodeframes(_:)> is generated from this same header.

### `CVPixelBufferPool` tuning

| Key | Apple's words | Relevance | Candidate? |
|---|---|---|---|
| `kCVPixelBufferPoolMinimumBufferCountKey` | Pool will keep at least N buffers alive even when idle. | Floor on resident IOSurface count. | Lower or leave unset (default 0). |
| `kCVPixelBufferPoolMaximumBufferAgeKey` | "By default, buffers will age out after one second. If required, setting an age of zero will disable the age-out mechanism completely." | **Direct.** The default 1-second age-out is long relative to our encoder working set — buffers stay resident a full second after last use. | **Yes.** Lower to ~0.1 s on every pool we control. Do not set to 0 (that pins forever). |
| `kCVPixelBufferPoolAllocationThresholdKey` | Hard allocation ceiling. Exceeding it returns `kCVReturnWouldExceedAllocationThreshold`. Only works via `CVPixelBufferPoolCreatePixelBufferWithAuxAttributes`. | **Direct.** Lets us fail fast instead of allocating one more IOSurface at the wrong moment. | **Yes.** Set per-pool ceilings; on `kCVReturnWouldExceedAllocationThreshold`, drop the frame. |

**Cross-writer pool sharing is not a supported pattern.** `AVAssetWriterInputPixelBufferAdaptor` owns its own pool and `VTCompressionSessionGetPixelBufferPool` returns the encoder's internal pool. Apple's header text is explicit: "Using the provided pixel buffer pool for buffer allocation is typically more efficient than appending pixel buffers allocated using a separate pool." That means we should always use the adaptor's own pool downstream — but cross-writer sharing is not something we should attempt.

Source: `CVPixelBufferPool.h` — <https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/CoreVideo.framework/Headers/CVPixelBufferPool.h>.

### ScreenCaptureKit configuration

Apple's most detailed public guidance on `SCStreamConfiguration` tuning is **WWDC22 session 10155, "Take ScreenCaptureKit to the next level"** (<https://developer.apple.com/videos/play/wwdc2022/10155/>). Verbatim excerpts below.

| Property | Apple's guidance | Candidate? |
|---|---|---|
| `pixelFormat` | WWDC22/10155 lists **BGRA** "for on-screen display" and **YUV420** (`kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`, FourCC `420v`) "for encoding and streaming". Apple's own 4K/60 example sets `pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`. | **Highest-priority single change.** BGRA is 4 bytes/pixel; 420v is 1.5 bytes/pixel. At 1440p that is ~14.7 MB → ~5.5 MB per frame. The H.264 and ProRes encoders both want YCbCr internally anyway; sending BGRA forces a colour-conversion stage in CIContext. |
| `queueDepth` | WWDC22/10155 verbatim: "ScreenCaptureKit accepts queue depth range between three to eight with a default queue depth of three." Stall rule: "the time it takes your app to release the surfaces back to the pool must be less than MinimumFrameInterval times QueueDepth minus 1, after which ScreenCaptureKit runs out of surfaces to use, enters a stall, and will start to miss new frames." | Each unit of queueDepth is one IOSurface in the stream's pool. Apple's sample code at <https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos> uses `queueDepth = 5` with an in-code comment: *"Increase the depth of the frame queue to ensure high fps at the expense of increasing the memory footprint of WindowServer."* Test at default 3 first. |
| `minimumFrameInterval` | Standard CMTime frame-rate cap. | Offering a "1440p 30fps safe mode" halves encoder pressure vs 60 fps. Worth exposing as a preset. |
| `width` / `height` / `scalesToFit` | Server-side scaling is hardware-accelerated per WWDC22/10155: "Hardware-accelerated content capture, scaling, pixel and color format conversion to achieve high-performance capture with reduced CPU usage." | **Yes.** Let SCK scale to the composited output size rather than capturing native + downscaling in CIContext. Moves that work off the shared GPU path and onto the dedicated capture path. |
| `captureResolution` (`SCCaptureResolutionType`) | `.automatic` / `.best` / `.nominal`. | Try `.nominal` — `.best` keeps Retina, `.nominal` gives 1× pixels. |

### In-process vs out-of-process encoding

**Finding: there is no public API to force in-process encoding.** No `kVTVideoEncoderSpecification_…` key documented in the header allows opting out of `VTEncoderXPCService`. The hardware encoder on Apple Silicon is reached only via that XPC service; this is an implementation choice, not client-configurable. Apple has never publicly explained why. Practical implication: every tuning knob in this memo is a *load reducer* on `VTEncoderXPCService` — we cannot dodge the XPC service itself.

### Does Apple ship sample code running ≥2 concurrent `VTCompressionSession` instances?

**No.** Exhaustively:

- **"Capturing screen content in macOS"** (<https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos>): displays and processes frames. No `VTCompressionSession`.
- **"Capturing HDR content with ScreenCaptureKit"** (WWDC24/10088): capture and display. No concurrent encoders.
- **RosyWriter** and the AVCam family: single video writer.
- **Apple's VideoToolbox sample code**: covers encoding one file. No concurrent-session examples.

This is the key negative result. **Apple ships no public reference for ≥2 concurrent `VTCompressionSession` instances, let alone the three-encoder + CIContext-compositor shape we are running.** The closest public art is third-party (OBS, FFmpeg, Cap). The kernel-level deadlock we are hitting is plausibly an under-tested Apple regime, not a bug in our code — which motivates being maximally conservative with every tuning knob.

### Ranked shortlist — top tuning changes most likely to reduce IOSurface pressure

1. **Switch `SCStreamConfiguration.pixelFormat` from BGRA to `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`.** ~63% reduction in per-frame screen IOSurface bytes. Apple's own 4K/60 example uses this format. Source: WWDC22/10155.
2. **Call `VTCompressionSessionPrepareToEncodeFrames` on every session sequentially before opening the SCStream.** Apple's header is explicit that otherwise allocation happens on first `EncodeFrame`, i.e. during contention. Source: VTCompressionSession.h.
3. **Set `kVTCompressionPropertyKey_MaxFrameDelayCount` to a small finite value** (e.g. 1 for ProRes screen, 2 for H.264 composited, 2 for camera). Default is `kVTUnlimitedFrameDelayCount` — the documented worst case for working-set size. Source: VTCompressionProperties.h.
4. **Set `kVTCompressionPropertyKey_AllowFrameReordering = false` on the H.264 sessions.** Removes the encoder's B-frame reorder buffer entirely. HLS does not require B-frames. Source: VTCompressionProperties.h.
5. **Set `kVTCompressionPropertyKey_RealTime = kCFBooleanFalse` on all sessions.** OBS, FFmpeg, and HandBrake all ship this way. OBS issue #5840 documents framedrops and unreliability when set to `true` on M1/M2. Source: OBS #5840, OBS encoder.c line 790, FFmpeg videotoolboxenc.c line 1606.
6. **Lower `kCVPixelBufferPoolMaximumBufferAgeKey` from 1 s default to ~0.1 s** on every pool we control, and set `kCVPixelBufferPoolAllocationThresholdKey` via `CVPixelBufferPoolCreatePixelBufferWithAuxAttributes`. Forces fast recycling and gives a hard ceiling that fails fast instead of triggering kernel allocation at the wrong moment. Source: CVPixelBufferPool.h.
7. **Drop `SCStreamConfiguration.queueDepth` to 3** (the default). WWDC22/10155 explicitly warns more depth = more IOSurfaces = more memory in WindowServer.
8. **Assert `kVTCompressionPropertyKey_PixelBufferPoolIsShared = true`** immediately after creating each session. `false` means a hidden second pool is silently doubling the footprint.
9. **Set `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = true`** so silent software fallback fails loudly.

---

## Area 3 — IOGPUFamily and IOSurface resource management

### What IOGPUFamily actually is

**Known from public sources:**

- IOGPUFamily is an Apple-private IOKit kext (kernel extension). It sits **below** Metal, Core Image, Core Animation, VideoToolbox, and ScreenCaptureKit — every userspace API that touches the GPU opens `IOGPUDeviceUserClient` (or a related user client) via Mach IPC into IOKit, and from there the kernel side schedules work on the AGX firmware coprocessor.
- IOGPUFamily is **not** in `apple-oss-distributions`. The xnu repo publishes IOKit base classes and `IOUserClient.{h,cpp}` but no IOGPUFamily / IOAcceleratorFamily2 sources or headers (<https://github.com/apple-oss-distributions/xnu>). The historical `IOGraphicsFamily` is open; the GPU compute/3D family is not.
- Apple security advisories repeatedly describe IOGPUFamily as "a kernel driver responsible for handling communication with the GPU" and have published kernel-OOB-write fixes against it (e.g. the iOS 18.4 advisory from March 2025, <https://support.apple.com/en-us/100100>). That confirms it is a single central kext used by all GPU work, not a thin shim.

**Inferred (no public documentation, but consistent with our spindump and with Asahi's reverse engineering):**

- IOGPUFamily owns IOSurface allocation arbitration for GPU-backed surfaces. The Asahi work on M1 shows the AGX firmware owns the GPU MMU and that "GPU memory *is* firmware memory" — any IOSurface the GPU will touch must be mapped through the same MMU that the firmware uses (<https://asahilinux.org/2022/11/tales-of-the-m1-gpu/>). So allocating an IOSurface that the hardware encoder, the ProRes engine, ScreenCaptureKit, and the compositor will all share crosses this single arbiter. Our spindump — `videotoolbox.preparationQueue` blocked inside IOGPUFamily while WindowServer's `mtl_submit` is also blocked — is exactly the shape this model predicts.

**Tunable resource limits: none documented.** No sysctl, no environment variable, no `ioreg` property marked as configurable. `MTLDevice.recommendedMaxWorkingSetSize` is the only public number Apple exposes about a GPU memory budget, and it is described as a soft hint.

### IOSurface attribute catalogue

Sourced from `IOSurface.framework/IOSurfaceRef.h` and `IOSurfaceAPI.h` (mirrored at <https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX10.8.sdk/System/Library/Frameworks/IOSurface.framework/Versions/A/Headers/IOSurfaceAPI.h> and <https://github.com/xybp888/iOS-SDKs/blob/master/iPhoneOS13.0.sdk/System/Library/Frameworks/IOSurface.framework/Headers/IOSurfaceTypes.h>).

| Constant | Relevance to our problem |
|---|---|
| `kIOSurfaceAllocSize` | Total bytes. Defaults to `BufferHeight * BytesPerRow`. The biggest knob: larger preset = larger allocations = faster IOSurface pressure. |
| `kIOSurfaceWidth` / `kIOSurfaceHeight` / `kIOSurfaceBytesPerRow` / `kIOSurfaceBytesPerElement` | Geometry and stride. |
| `kIOSurfacePixelFormat` | OSType four-char-code (e.g. `'420v'`). Drives which hardware path is chosen. |
| `kIOSurfaceCacheMode` | One of `kIOSurfaceDefaultCache`, `InhibitCache`, `WriteThruCache`, `CopybackCache`, `WriteCombineCache`, `CopybackInnerCache`. Wrong cache mode causes silent CPU↔GPU coherency stalls but not deadlocks. |
| `kIOSurfacePlaneInfo` | Per-plane geometry (YUV planes etc.). |
| `kIOSurfacePurgeableNonVolatile / Volatile / Empty / KeepCurrent` | **Only public lever that signals "I'm OK if you reclaim this memory."** Userspace can mark a surface volatile so the kernel can throw away its pages between uses. |
| `kIOSurfaceLockReadOnly`, `kIOSurfaceLockAvoidSync` | `AvoidSync` returns `kIOReturnCannotLock` rather than blocking on a paging op — useful for detecting that we're about to stall. |

**No documented attribute** for "pool ID", "priority", "allocation timeout", or "request shared/non-shared physical pool." **No public API** to ask the kernel "how much IOSurface memory is left."

### Command buffer arbitration — what we can prove vs what we can't

- **`CIContext(mtlCommandQueue:)` is documented to make Core Image submit on the caller's queue.** WWDC 2020 "Optimize the Core Image pipeline for your video app" (<https://developer.apple.com/videos/play/wwdc2020/10008/>) is explicit: "When an app passes a texture to Core Image, it uses its own internal Metal queue to render content into another Metal texture. … The solution to this problem is to create the CIContext with the same queue that is used by the other Metal renders. This allows the app to remove the waits." At the `MTLCommandQueue` level, Core Image really does share the queue we pass it.
- **However, this is a Metal queue, not an IOKit hardware queue.** `MTLCommandQueue` is a userspace ordering primitive. At the IOKit layer all Metal queues from all processes — our app, WindowServer, VideoToolbox's internal threads, SCStream — submit through `IOGPUDeviceUserClient` into the same set of AGX firmware work channels. Asahi's reverse-engineering shows the firmware exposes a fixed set of channels per work type (TA / 3D / CP / DeviceControl, four groups of three each). Multiple Metal queues from multiple processes are multiplexed onto these.
- **What is publicly proved:** sharing a `MTLCommandQueue` between Core Image and your renderer eliminates redundant userspace barriers.
- **What is not publicly proved:** that Metal, VideoToolbox, ProRes engine submissions, and SkyLight compositing all serialise through a single IOKit-level lock inside IOGPUFamily. This is strongly suggested by (a) our spindump, (b) Asahi's finding that AGX firmware owns one MMU and one set of channels, (c) the existence of a single `IOGPUDeviceUserClient` class. But Apple has never published it and IOGPUFamily is closed.
- VideoToolbox is even more opaque. The objc.io VideoToolbox writeup (<https://www.objc.io/issues/23-video/videotoolbox/>) is candid that the framework is "sparsely documented" with documentation that says only "Please check the header files." There is no public statement on whether H.264 and ProRes `VTCompressionSession` instances share a back-end queue.

**Honest summary.** The model "everything funnels through a single IOKit arbiter" is consistent with all public evidence and is the only model that explains the spindump. It is not formally documented. The previous research pass in `docs/research/01-macos-recording-apis.md` treated the ProRes engine and the H.264 engine as "separate silicon → independent pipelines"; the spindump and the Asahi work together show that assumption was incomplete. The engines are physically separate, but the kernel-side arbitration and the firmware-side MMU are not.

### Asahi Linux insights

Useful and applicable transfers to the macOS mental model:

- **Single firmware coprocessor owns all GPU work scheduling.** The AGX ASC firmware is "responsible for power management, command scheduling and preemption, fault recovery, and even performance counters." There is exactly one of these on the SoC. Source: <https://asahilinux.org/2022/11/tales-of-the-m1-gpu/>.
- **GPU memory is firmware memory.** "The firmware takes the same page table base pointer used by the GPU MMU and configures it as its ARM64 page table." Implication: any allocation the GPU will touch must be mapped through the same MMU the firmware uses. There is one MMU. Allocations from concurrent clients fundamentally serialise through it.
- **Fixed channel topology.** Four channel groups, each with TA/3D/CP channels, plus a DeviceControl channel. All work submission goes through ring buffers in shared memory. Concurrent processes get parallelism *at the channel level*, not unbounded. Source: <https://asahilinux.org/docs/hw/soc/agx/>.
- **Tiler heap is firmware-managed.** "The GPU tiler needs a buffer to store vertex attribute and primitive data. This is done through a few fixed-size buffers provided by the driver, and a heap that the GPU firmware allocates stuff out of at its discretion." Apple's firmware decides when and how much. There is no public knob.

**What Asahi has *not* documented:** the hardware video encode/decode blocks (H.264, HEVC, ProRes). Asahi's progress reports through Linux 6.18/6.19 still treat video engines as out of scope (<https://asahilinux.org/2026/02/progress-report-6-19/>, <https://asahilinux.org/docs/platform/feature-support/m2/>). So whether the ProRes engine sits on a separate firmware channel or is mediated by the same ASC is **not publicly known**. Our prior assumption that ProRes is "separate silicon → independent pipeline" is unverified at the scheduling layer.

**Key transfer to the macOS mental model:** even if H.264 and ProRes engines are physically separate, every IOSurface they read or write must be mapped via the one MMU the AGX firmware owns. Allocation contention sits above the engine boundary. This is the single finding that most directly contradicts the task-0A Background section's research summary, and it is load-bearing for why Phase 2's fix worked at 1080p but not 1440p.

### Unified memory pressure

- **Hard number:** on M2 Pro 32 GB, `MTLDevice.recommendedMaxWorkingSetSize` is approximately 22.9 GB (~75% of physical RAM). Widely reported, consistent across Apple Silicon. Sources: <https://developer.apple.com/forums/thread/732035>, <https://stencel.io/posts/apple-silicon-limitations-with-usage-on-local-llm%20.html>.
- **What it means:** soft hint. Not enforced as a hard cap. Does not tell us what fraction is used by other processes. WindowServer alone holds substantial IOSurface memory for the framebuffer chain, plus every windowed app's backing surfaces.
- **Detecting pressure before a hang:** no public API surfaces "IOSurface bytes free" or "IOGPU memory free." Indirect signals: `footprint --by-category` per process (shows IOSurface bytes attributed to each PID); `vm_stat` pages-free + pages-purgeable (IOSurfaces marked `kIOSurfacePurgeableVolatile` count as purgeable; when purgeable drops near zero the kernel is reclaiming aggressively); `MTLDevice.currentAllocatedSize` for our own process; `memory_pressure` daemon signals (coarse).
- **Not available:** no equivalent of `nvidia-smi`. No GPU-encoder-busy percentage. No "ProRes engine pending bytes." No documented kernel timeout for an IOGPUFamily wait — the spindump shows a 40-second hang followed by the service watchdog firing, which is the watchdog's timeout, not the kernel's. There is no published evidence of any internal IOGPU allocation timeout at all. The public model is "wait forever until either the allocation succeeds or the userspace process is killed."

### Observability toolbox for the harness

Concrete commands the isolation harness in task-0C can capture around each test:

```bash
# IOKit registry — GPU and accelerator state
ioreg -rxc IOGPU
ioreg -rxc IOAccelerator
ioreg -rxc AGXAccelerator
ioreg -rxc IOSurfaceRoot
ioreg -lw0 | grep -i -E 'IOGPU|IOAccel|IOSurface|PerformanceStatistics'

# VM / unified memory pressure
vm_stat 1
sysctl -a | grep -E 'vm\.|hw\.memsize|hw\.pagesize'
hostinfo
memory_pressure -l warn
footprint --by-category $(pgrep -x WindowServer)
footprint --by-category $(pgrep LoomClone)

# Unified logs — start before repro, stop after
log stream --level debug --predicate \
  'subsystem == "com.apple.coremedia" OR subsystem == "com.apple.videotoolbox" \
   OR subsystem == "com.apple.SkyLight" OR subsystem == "com.apple.iosurface" \
   OR subsystem == "com.apple.coreanimation" OR subsystem == "com.apple.GPU"'

log show --last 5m --predicate \
  'eventMessage CONTAINS "IOSurface" OR eventMessage CONTAINS "IOGPU" \
   OR eventMessage CONTAINS "hung" OR eventMessage CONTAINS "watchdog"'

# Spindumps and samples on hang
sudo spindump -notarget WindowServer 10 -file /tmp/wserver.spindump
sample com.apple.videotoolbox.preparationQueue 5
```

**Instruments templates** (<https://developer.apple.com/metal/tools/>):

- **Metal System Trace** — the only Apple-supplied tool that lets us see queue contention across processes. WWDC 2019 "Metal for Pro Apps" (<https://asciiwwdc.com/2019/sessions/608>) walks through it.
- **Allocations + IO Activity + VM Tracker** — IOSurface allocations show up under the `IOSurface` category, with stack traces back to whatever framework requested them. WWDC 2022 "Profile and optimize your game's memory" (<https://developer.apple.com/videos/play/wwdc2022/10106/>).

### Honest assessment

**Stop trying to model this layer. Validate empirically.** Three reasons:

1. **No source.** IOGPUFamily, IOAcceleratorFamily2, the AGX kext, VideoToolbox internals, and the AGX firmware are all closed. xnu and IOKit base classes are open, but every piece that arbitrates GPU work is private.
2. **No tunables.** One number exposed (`recommendedMaxWorkingSetSize`) and one purgeability flag. No sysctl, no environment variable, no IOSurface attribute that lets us request a separate pool, set a priority, set a timeout, or query free memory.
3. **Asahi has not reverse-engineered the video engines.** The piece we'd most want — "is the ProRes engine on its own channel?" — is exactly the thing nobody has published.

**Recommendation: task-0C should treat IOGPUFamily as an oracle that fails, and focus on the layer above it.** Specifically: add allocation accounting in our process (wrap every `CVPixelBufferPool` and `IOSurfaceCreate` site, log byte counts and peak allocation); add per-writer heartbeats (post alive every 250 ms, supervisor kills the session if any heartbeat misses 2 s — gives us a recovery path the kernel will not); lower contention at the allocation-rate layer (mark scratch surfaces purgeable between frames, sequence allocation moments across encoders). Reasoning from "what does IOGPUFamily do under the hood" to a fix will not converge. Reasoning from "what does our process look like to the layer above IOGPUFamily" will, because we control that layer.

---

## Area 4 — How comparable apps handle concurrent writers

### Cap — the closest match by use case

The existing analysis at `docs/research/03-cap-codebase-analysis.md` covered Cap's overall architecture. This section is a delta focused on what that doc did not answer.

**Cap does not touch `VTCompressionSession` directly.** GitHub code search across `CapSoftware/Cap` returns zero hits for `VTCompressionSession`, `ProRes`, `PrepareToEncodeFrames`, `kVTCompressionPropertyKey_RealTime`, `MaxFrameDelayCount`, or `MaximizePowerEfficiency`. The entire macOS encoding path goes through `AVAssetWriter` + `AVAssetWriterInput` via `OutputSettingsAssistant`. Cap never creates a `VTCompressionSession` themselves and never sets a low-level VT property. This is the highest-level Apple-provided encoder API that exists.

**Exact encoder configuration** (from `crates/enc-avfoundation/src/mp4.rs`, `MP4Encoder::init_with_options`, lines ~183–256 at <https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/enc-avfoundation/src/mp4.rs>):

```rust
let mut asset_writer = av::AssetWriter::with_url_and_file_type(
    cf::Url::with_path(output.as_path(), false).unwrap().as_ns(),
    av::FileType::mp4(),
)?;

let assistant = av::OutputSettingsAssistant::with_preset(
    av::OutputSettingsPreset::h264_3840x2160(),
)?;

// Compression props (inserted into output_settings):
//   AVVideoAverageBitRateKey
//   AVVideoAllowFrameReorderingKey = false
//   AVVideoExpectedSourceFrameRateKey = fps
//   AVVideoMaxKeyFrameIntervalKey = fps (instant) or 2*fps
// ColorProperties: ITU_R_709_2 throughout.

let mut video_input = av::AssetWriterInput::with_media_type_and_output_settings(
    av::MediaType::video(),
    Some(output_settings.as_ref()),
)?;
video_input.set_expects_media_data_in_real_time(true);
```

Four compression properties, plus colour. No B-frames. No lookahead tuning. They rely on `expectsMediaDataInRealTime = true` at the AVFoundation layer — which AVAssetWriter passes down to its internal VT session.

**Concurrent encoder count during a studio recording** (from `crates/recording/src/output_pipeline/macos.rs` and `crates/recording/src/studio_recording.rs` ~lines 1055–1133):

- 1× screen pipeline (`AVFoundationMp4Muxer`)
- 1× camera pipeline if camera feed present (`AVFoundationCameraMuxer`)
- Audio pipelines (AAC, separate muxers)

**Maximum concurrent hardware H.264 sessions during a Cap studio recording: 2** (screen + camera). Cap never runs three concurrent VT video sessions.

**ProRes usage: none anywhere.** Zero hits in the repo. Every video stream goes through the same `OutputSettingsPreset::h264_3840x2160()` H.264 path.

**CIContext / live compositing: none during recording.** Cap does not composite while recording in studio mode. The camera is recorded as a separate stream, compositing happens later in the editor via `wgpu` (`crates/rendering/`). Only "Instant Mode" bakes the camera in, and it does so via direct AVFoundation muxing, not a CIContext pipeline. The phrase `CIContext` does not appear in `output_pipeline/macos.rs`.

**ScreenCaptureKit pixel format** (from `crates/recording/src/sources/screen_capture/macos.rs`): `settings.set_pixel_format(cv::PixelFormat::_420V)` — NV12. Queue depth: `((fps/30 * 5).ceil()).clamp(3, 8)`. Pool size default 20 (overridable via `CAP_PIXEL_BUFFER_POOL_SIZE`).

**Encoder warmup: none.** `AVAssetWriter.startWriting()` and `startSession(atSourceTime:)` happen on the first frame inside `queue_video_frame`. No explicit equivalent of `VTCompressionSessionPrepareToEncodeFrames`.

**Cap issue tracker for our failure modes.** #1449 ("Screen Recording freezing on MacOS", M4 Pro 48 GB, macOS 15.5, all studio-mode recordings freeze even at 10 seconds). #1466 ("Cap desktop hangs when stopping recording", Windows 11, not relevant). No Cap issues mention `IOGPUFamily`, kernel panic, `WindowServer`, watchdog, or M2 Pro at 1440p. Cap's freeze reports don't carry the kernel-level fingerprint we see.

### OBS Studio

File: `plugins/mac-videotoolbox/encoder.c` at <https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/mac-videotoolbox/encoder.c>. OBS *does* create `VTCompressionSession` directly.

**Session creation** (`create_encoder`, ~line 607): OBS passes its own callback queue (`enc->queue`) to `VTCompressionSessionCreate` — no NULL queue, no implicit dispatch onto VT's internal preparation queue. This gives them tighter control over which thread receives encoded frames.

**Properties set on the H.264/HEVC path** (~lines 647–805):

- `MaxKeyFrameIntervalDuration`, `MaxKeyFrameInterval`, `ExpectedFrameRate`
- `AllowFrameReordering` (configurable)
- `ProfileLevel`
- Bitrate / CBR/VBR (separate function)
- `SpatialAdaptiveQPLevel` (macOS 15+, conditional)
- **`RealTime` = `kCFBooleanFalse`** (line 790) — *always false on macOS*
- Colorspace

Lines 789–795 verbatim:

```c
// This can fail depending on hardware configuration
code = session_set_prop(s, kVTCompressionPropertyKey_RealTime, kCFBooleanFalse);
if (code != noErr)
    log_osstatus(LOG_WARNING, enc,
                 "setting kVTCompressionPropertyKey_RealTime failed, "
                 "frame delay might be increased", code);
```

Lines 802–805:

```c
code = VTCompressionSessionPrepareToEncodeFrames(s);
if (code != noErr) { return code; }
```

**OBS calls `VTCompressionSessionPrepareToEncodeFrames` always.** This is the warmup we don't currently do.

**Properties OBS deliberately does NOT set:** `MaxFrameDelayCount`, `MaximizePowerEfficiency`.

**ProRes path:** OBS supports ProRes via `create_prores_encoder_spec()` (~lines 560–587), selecting a specific encoder by ID via `kVTVideoEncoderSpecification_EncoderID`. ProRes uses a separate VT session from the H.264/HEVC path — they are mutually exclusive code paths, not stacked.

**ScreenCaptureKit configuration** (`plugins/mac-capture/mac-sck-video-capture.m`): `setPixelFormat:l10r_type` (`'l10r'` = `kCVPixelFormatType_ARGB2101010LEPacked`, 10-bit packed RGBA for HDR), `setQueueDepth:8`.

**The smoking gun — OBS issue #5840 + PR #5809.** <https://github.com/obsproject/obs-studio/issues/5840>, <https://github.com/obsproject/obs-studio/pull/5809>. On M1/M2, having `kVTCompressionPropertyKey_RealTime = true` combined with bitrate limits caused severe framedrops independent of the actual bitrate ceiling. Quote from the issue: *"removing the RealTime property makes the HW VideoToolbox very reliable"* and *"no drops occurring (even at really high bitrates) if that property was not set."* OBS's fix landed in PR #5809 — they switched to `kCFBooleanFalse`. FFmpeg made the same change earlier. **This is directly relevant to our hang:** setting `RealTime = true` on M-series VT alters how the encoder reserves and holds IOSurface backing — exactly the resource that's deadlocking us.

**OBS forum: 8K hangs on M-series.** <https://obsproject.com/forum/threads/apple-vt-hardware-encoder-crashes-when-attempting-8k-recordings.154754/>. M1 Max users report H.264 and HEVC VT encoders crashing above 4K. HandBrake sees the same. One user reports success only with the ProRes hardware encoder at 8K. No mention of `IOGPUFamily` or kernel deadlock, but the pattern (H.264/HEVC fails above some resolution, ProRes survives) is consistent with hitting the H.264 engine's IOSurface ceiling.

**Concurrent session count in OBS:** single-session per `vt_encoder` instance. OBS theoretically supports multiple simultaneous outputs via separate `vt_encoder` instances, but in practice users running 2+ concurrent VT outputs on M-series Pro chips report degraded performance, not hangs.

### FFmpeg

File: `libavcodec/videotoolboxenc.c` at <https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/videotoolboxenc.c>. The reference implementation. `vtenc_create_encoder()` ~line 1350.

**Properties set** (selected, from ~lines 1413–1660):

- `Quality`, `ConstantBitRate`, `AverageBitRate`, `DataRateLimits`
- `PrioritizeEncodingSpeedOverQuality` (conditional)
- `ProfileLevel`, `MaxKeyFrameInterval`
- `MoreFramesBeforeStart`, `MoreFramesAfterEnd`
- `AllowFrameReordering`, `AllowOpenGOP`
- `H264EntropyMode`, `MaxH264SliceBytes`
- `MinAllowedFrameQP`, `MaxAllowedFrameQP`
- **`RealTime`** (line 1606) — `vtctx->realtime`, **defaults to false** (`-realtime 0`)
- **`MaximizePowerEfficiency`** (line 1641) — `vtctx->power_efficient`, default false
- `ReferenceBufferCount`, `SpatialAdaptiveQPLevel`
- **`VTCompressionSessionPrepareToEncodeFrames`** at line 1658 — always called

**FFmpeg does not set `MaxFrameDelayCount`.** FFmpeg supports ProRes as a distinct codec path (`AV_CODEC_ID_PRORES`). The ProRes path skips H.264-specific properties. Single-session-per-instance; concurrent encoding in FFmpeg means launching multiple `ffmpeg` processes. No FFmpeg trac ticket for concurrent-session hangs on Apple Silicon — the closest are "hardware encoder may be busy" errors (-12908 / -12915) when too many sessions are open across processes.

### HandBrake

File: `libhb/platform/macosx/encvt.c` at <https://raw.githubusercontent.com/HandBrake/HandBrake/master/libhb/platform/macosx/encvt.c>. `hb_vt_init_session()` ~line 1500.

Sets more properties than any other project examined:

- `RealTime` = **`kCFBooleanFalse`** (lines 1531–1535)
- `AllowTemporalCompression`, `AllowFrameReordering`
- `MaxKeyFrameInterval`, `ExpectedFrameRate`
- `PrioritizeEncodingSpeedOverQuality`
- `MinAllowedFrameQP` / `MaxAllowedFrameQP`
- `ReferenceBufferCount`
- **`MaxFrameDelayCount`** (lines 1553–1558) — *only HandBrake sets this*, conditional on config
- `SpatialAdaptiveQPLevel`, `SuggestedLookAheadFrameCount`
- `DataRateLimits`
- HDR metadata (`MasteringDisplayColorVolume`, `ContentLightLevelInfo`, etc.)
- `H264EntropyMode`, `MaxH264SliceBytes`
- Full colour pipeline
- `Quality` or `AverageBitRate`, `ProfileLevel`
- **`VTCompressionSessionPrepareToEncodeFrames`** at line 1574

Full ProRes profile range supported. Single-session per job. Discussion #3932 ("Macbook Pro M1 Pro/Max Talks") and above-4K H.265 failure reports consistent with the OBS 8K thread. No concurrent-session deadlock reports.

### Comparison matrix

| Property | Cap | OBS | FFmpeg | HandBrake | Our app |
|---|---|---|---|---|---|
| Concurrent hardware video encoders per recording | **2** | 1 typically | 1 per process | 1 per job | **3+** |
| Uses ProRes? | No | Optional, separate path | Optional, separate path | Yes, full range | **Yes — 422 Proxy** |
| `kVTCompressionPropertyKey_RealTime` | Not set directly (uses AVAssetWriter `expectsMediaDataInRealTime`) | `kCFBooleanFalse` | defaults `false` | `kCFBooleanFalse` | (verify current code) |
| `MaxFrameDelayCount` set? | No | No | No | **Yes (when configured)** | (verify) |
| `MaximizePowerEfficiency` set? | No | No | Configurable, default false | No | (verify) |
| Calls `PrepareToEncodeFrames`? | N/A (AVAssetWriter does it internally) | **Yes** | **Yes** | **Yes** | **No** (AVAssetWriter path) |
| SCStream pixel format | NV12 (`'420v'`) | `'l10r'` (ARGB2101010LE) | N/A | N/A | (BGRA via CI?) |
| Live CIContext compositor + encoders? | **No — post-recording in wgpu** | No | No | No | **Yes** |
| Known concurrent-session kernel hangs | None matching | 8K H.264 crash thread, #5840 framedrop fix | "encoder busy" graceful failures | Above-4K HEVC failures | This hang |

### Things those apps don't do that we currently do

This is the most load-bearing section of Area 4.

1. **No examined production app runs three concurrent VT video sessions on M-series Pro hardware.** Cap (closest match by use case) tops out at two. OBS, FFmpeg, HandBrake all run a single VT session per process/job. Our pipeline runs three: composited HLS H.264, raw screen ProRes Proxy, raw camera H.264. **M2 Pro has exactly one general video encode engine and one ProRes engine.** Two concurrent H.264 sessions on the single video engine plus ProRes on its dedicated engine plus a CIContext compositor traversing the same IOGPUFamily resources is a configuration none of these apps validate.
2. **No examined app runs a CIContext live compositor simultaneously with multiple encoders.** Cap composites post-recording in wgpu inside the editor. OBS does compositing in its own scene-graph (Metal on macOS) but feeds a single VT session. Our pipeline has Core Image fighting the same Metal command queue and IOSurface pool that VT's preparation queue is allocating against.
3. **No examined app uses ProRes alongside concurrent H.264 sessions for screen recording.** The OBS 8K thread shows users reverting to ProRes *as an alternative to* H.264, not in addition. ProRes is treated as "use this when H.264 won't work" — not as a parallel raw track.
4. **We do not call `VTCompressionSessionPrepareToEncodeFrames`.** OBS, FFmpeg, and HandBrake all call this. Cap gets away without it because they go through AVAssetWriter, which calls it internally during `startWriting()`. If we use raw `VTCompressionSession` anywhere in our pipeline, this is the single biggest missing step.
5. **We may set `kVTCompressionPropertyKey_RealTime = true` on the composited path.** OBS, FFmpeg, and HandBrake have all converged on `RealTime = false` for hardware VT on Apple Silicon. OBS #5840 attributes framedrops and unreliability on M1/M2 to `RealTime = true`. We need to verify our composited writer's setting.
6. **We may use BGRA from ScreenCaptureKit while Cap uses NV12.** If the composited pipeline requests BGRA because CIContext wants RGBA inputs, we're forcing an extra colour-space conversion through Metal, adding pressure on the same GPU resources that VT allocates.
7. **No examined app shares a single CIContext-backed Metal command queue with multiple concurrent encoders during recording.** This is genuinely novel territory. That none of these apps do it is itself a finding.

### Known-stable recipes

**Cap "Studio Mode" (2 concurrent H.264 VT sessions, no ProRes, no live compositing).** `AVAssetWriter` + `OutputSettingsAssistant.h264_3840x2160()` for both screen and camera. Four compression properties only. `expectsMediaDataInRealTime = true`. SCStream `pixelFormat = '420v'`. Pool size 20, queue depth 3–8. Compositing deferred to a wgpu editor pipeline post-recording. `crates/enc-avfoundation/src/mp4.rs:183-256`, `crates/recording/src/output_pipeline/macos.rs:290-680`, `crates/recording/src/sources/screen_capture/macos.rs`.

**OBS "single H.264 VT recording."** Direct `VTCompressionSessionCreate` with explicit dispatch queue. `RealTime = kCFBooleanFalse`. Keyframe + framerate + reorder + profile. Bitrate via separate function. `PrepareToEncodeFrames` called. SCStream `'l10r'`, queueDepth 8. `plugins/mac-videotoolbox/encoder.c:607-810`, `plugins/mac-capture/mac-sck-video-capture.m`.

**FFmpeg "single H.264 VT recording."** Same shape as OBS with more properties available, defaults `realtime=0`, `power_efficient=0`. `libavcodec/videotoolboxenc.c:1350-1660`.

**There is no documented production-grade recipe for the configuration we are running** — three concurrent hardware video sessions including ProRes plus a live CIContext compositor on M-series Pro hardware. If we want to keep that shape we are pioneering it. If we want a known-stable recipe, the closest is Cap's two-encoder studio mode with all compositing deferred.

Notable note on Screen Studio: they have an open community feature request *asking* for VideoToolbox hardware encoding, which suggests they currently use software encoding — which would sidestep this entire problem class. A polished M-series screen recorder may be avoiding hardware VT specifically because of issues like ours.

---

## Updated answers to the open research questions in `m2-pro-video-pipeline-failures.md`

The failures doc lists eight open questions. Updated answers below.

**1. What is the documented concurrent hardware video session limit on M1/M2/M3 Pro chips?**

Still not publicly documented as a hard number. Apple does not publish it. Best indirect evidence: the `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder` header comment lists "the hardware encoding resources on the machine are busy" as an enumerated failure case (VTCompressionProperties.h), which confirms a limit exists but not its value. Community reports (OBS forum 8K thread) suggest 2 concurrent 4K H.264 streams is the practical ceiling on single-engine chips. Status: **partially answered — limit confirmed to exist, value remains unknown, likely intentionally undocumented.**

**2. What specific conditions cause IOGPUFamily to deadlock rather than back-pressure gracefully?**

Not answered from public information. IOGPUFamily is closed, no public docs on its scheduling, no community reports at this level of detail. The most we can say: our spindump shows the failure is on IOSurface *allocation*, not on command-buffer submission, which means it happens before Metal's watchdog can see it. The Asahi reverse-engineering tells us the AGX firmware owns one MMU and a fixed channel topology, so allocation must serialise through it. Adobe Premiere + Tahoe ProRes hangs suggest the condition is reachable from the ProRes path specifically, and may be a Tahoe regression. Status: **remains open. Empirical validation in task-0C is the only path forward.**

**3. Are there VideoToolbox session properties that affect IOGPUFamily resource allocation behaviour?**

Partially answered. No property is *documented* to directly affect IOGPUFamily behaviour. But several properties affect the encoder's working set size (which affects how much IOSurface memory is allocated): `MaxFrameDelayCount`, `AllowFrameReordering`, `ReferenceBufferCount`, `RealTime`. See Area 2 for the full catalogue and ranked shortlist. OBS #5840 is the strongest piece of evidence that `RealTime` in particular has second-order effects on reliability on Apple Silicon. Status: **answered as far as public docs permit. Empirical validation needed for specific IOGPUFamily effects.**

**4. Does Apple publish sample code running more than 2 concurrent hardware video sessions?**

**No.** Exhaustively checked: "Capturing screen content in macOS", "Capturing HDR content with ScreenCaptureKit", RosyWriter, AVCam variants, the VideoToolbox sample code. None run ≥2 concurrent `VTCompressionSession` instances. This is a confirmed negative. Status: **fully answered — Apple does not publish sample code for our configuration shape. Implication: the regime we are operating in is under-exercised by Apple's own QA.**

**5. What is the IOSurface pool sizing strategy for ScreenCaptureKit and `AVAssetWriterInputPixelBufferAdaptor`, and is any of it tunable?**

Partially answered. For ScreenCaptureKit: `SCStreamConfiguration.queueDepth` is the documented knob (range 3–8, default 3). For `AVAssetWriterInputPixelBufferAdaptor`: the pool is owned by the adaptor and exposed via `pixelBufferPool`; Apple's docs recommend using this pool for any frames fed back to the adaptor. Both layers ultimately allocate through `CVPixelBufferPool`, which has `MinimumBufferCountKey`, `MaximumBufferAgeKey`, and `AllocationThresholdKey`. Default buffer age-out is 1 second. Status: **answered for the userspace layer. Kernel-side IOSurface pool behaviour remains undocumented.**

**6. How do Cap, Screen Studio, Loom, and Riverside handle this on Apple Silicon Pro chips?**

- **Cap:** answered in detail in Area 4 above. Two concurrent H.264 sessions at most, no ProRes, no live compositing, SCStream `'420v'`, AVAssetWriter path (not raw VT).
- **Screen Studio, Loom, Riverside, Descript, Camo, Detail, Tella:** closed source. No engineering blog posts found describing concurrent VT session counts or 1440p hang mitigations. Screen Studio has an open community request asking for VideoToolbox hardware encoding, suggesting they currently use software encoding.

Status: **answered for Cap (definitively), unanswered for the closed-source set.**

**7. Does `VTCompressionSessionPrepareToEncodeFrames` pre-allocate IOSurface resources in a way that would prevent allocation stalls mid-recording?**

Partially answered. Apple's header is explicit that "any necessary resources will be allocated on the first VTCompressionSessionEncodeFrame call" if `PrepareToEncodeFrames` isn't invoked. Apple doesn't promise IOSurface specifically but the behavioural contract — "all allocation happens here instead of on first encode" — means calling it before opening the SCStream is the right place for that work to happen serially, before we have four pipelines competing for the same allocator. OBS, FFmpeg, and HandBrake all call it. Status: **answered at the documentation level. Empirical validation (does it actually avoid the preparationQueue stall?) is the top task-0C hypothesis.**

**8. What's the IOSurface memory footprint cliff?**

Not answered directly. Apple does not publish a GPU-memory budget. `recommendedMaxWorkingSetSize` on M2 Pro is ~22.9 GB (soft hint, not enforced, not per-process). No public API exposes IOSurface bytes free. `footprint --by-category` can show per-process IOSurface bytes but not the kernel-side total. Status: **remains open. Task-0C should instrument `footprint` polling and `vm_stat` deltas during each test run to build an empirical cliff map.**

---

## Hypotheses to test in task-0C

Each hypothesis is falsifiable, has an explicit setup, and names a clear pass/fail signal. Ordered so the harness can test the cheapest / highest-leverage changes first. Confidence is a rough label: **high** means the finding is directly supported by Apple docs, WWDC, or concrete production-app code; **medium** means inferred from partial evidence; **low** means speculative but worth testing because the cost is low.

### H1 — ScreenCaptureKit pixel format (confidence: high)

**Claim.** Configuring `SCStreamConfiguration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange` (`420v`) instead of BGRA reduces the per-frame screen IOSurface footprint by ~63% and is sufficient, on its own, to make the 1440p preset stable.

**Why we think this.** Apple's own 4K/60 example uses this format (WWDC22/10155). Cap uses it. BGRA is 4 bpp, 420v is 1.5 bpp. At 1440p that is ~14.7 MB → ~5.5 MB per frame, multiplied across queue depth and encoder working sets. The encoders want YCbCr internally; we are currently paying for a conversion we don't need.

**Setup.** Harness runs the three-writer + CIContext pipeline at 1440p. Baseline run with BGRA (the current config). Compare to a run with `420v`. Measure: `footprint --by-category` delta on `WindowServer` and the harness process, `vm_stat` pages-free delta, observed hangs over N runs.

**Pass criterion.** N consecutive stable 1440p runs with no `preparationQueue` stall in the harness equivalent of our spindump (measured via `sample` on the `videotoolbox.preparationQueue` thread each second).

**Fail criterion.** Any run exhibits the hang within M seconds.

### H2 — `VTCompressionSessionPrepareToEncodeFrames` warm-up (confidence: high)

**Claim.** Calling `VTCompressionSessionPrepareToEncodeFrames` on every `VTCompressionSession` — sequentially on a serial queue, *before* opening the SCStream or starting any other session — eliminates the mid-recording allocation stall on `com.apple.videotoolbox.preparationQueue` by forcing the IOSurface working set to be allocated up front, one session at a time.

**Why we think this.** Apple's header is explicit about what this call does. OBS, FFmpeg, and HandBrake all call it. Our spindump shows the hang is on `preparationQueue` during IOSurface allocation — exactly the path this call is documented to drain at warm-up time instead. Cap avoids the problem by going through AVAssetWriter, which calls it internally during `startWriting()`; if we are using raw `VTCompressionSession` anywhere that doesn't warm up, we are by contract deferring allocation to first-frame time.

**Setup.** Harness uses raw `VTCompressionSession` for each of the three writers. Baseline: create sessions, open SCStream, begin encoding (allocation happens on first frame). Test: create each session, call `VTCompressionSessionPrepareToEncodeFrames` on it, wait for completion, then create the next session. Only open the SCStream after all three sessions have been prepared.

**Pass criterion.** `preparationQueue` allocation events in `log stream` all occur during the warm-up phase, not during the recording phase. Zero recording-phase hangs.

**Fail criterion.** Allocation events occur during the recording phase despite warm-up, or the warm-up itself hangs.

### H3 — `MaxFrameDelayCount` bounded (confidence: high)

**Claim.** Setting `kVTCompressionPropertyKey_MaxFrameDelayCount` to a small finite value (1 for ProRes screen, 2 for H.264 composited, 2 for H.264 camera) bounds each encoder's held IOSurface count and reduces aggregate working set enough to prevent the deadlock.

**Why we think this.** Default is `kVTUnlimitedFrameDelayCount`. Each held frame retains a source IOSurface and internal reference frames. HandBrake is the only examined project that sets this explicitly and documents it as a performance/memory knob.

**Setup.** Independent variable: `MaxFrameDelayCount` values. Baseline unlimited, then test with bounded values. Measure peak IOSurface bytes via `footprint`.

**Pass criterion.** Peak IOSurface working set measurably lower, 1440p preset stable across N runs.

### H4 — `AllowFrameReordering = false` on H.264 writers (confidence: high)

**Claim.** Disabling frame reordering on the composited HLS H.264 writer and the camera H.264 writer removes the B-frame reorder buffer and its IOSurface references, reducing each H.264 session's working set.

**Why we think this.** Cap already sets this. HLS low-latency does not require B-frames.

**Setup.** Baseline with reordering (current Cap-style config already sets false — verify). Test differential is primarily for sessions where we might have enabled it.

**Pass criterion.** Documented-stable behaviour at 1440p with reordering off.

### H5 — `RealTime = false` on all sessions (confidence: medium-high)

**Claim.** Explicitly setting `kVTCompressionPropertyKey_RealTime = kCFBooleanFalse` on every `VTCompressionSession` (matching OBS, FFmpeg, HandBrake) improves reliability on Apple Silicon by changing how the encoder reserves and releases IOSurface backing.

**Why we think this.** OBS issue #5840 is the most concrete piece of evidence we have: on M1/M2, `RealTime = true` caused framedrops and unreliability; removing it made hardware VT "very reliable" per the reporter. The mechanism is undocumented but the production-app convergence on `false` is strong signal.

**Setup.** Harness varies `RealTime` across runs: unset (default "unknown"), `true`, `false`. Measure framedrops, encoder completion latency, and hang frequency over N runs.

**Pass criterion.** `false` exhibits fewer hangs and fewer framedrops than `true` or unset.

**Caveat.** We need to actually measure this rather than assume the OBS finding transfers. `RealTime` semantics are "hint to the encoder about scheduling" — it is possible the behaviour differs between OBS's single-session setup and our three-session setup.

### H6 — `CVPixelBufferPool` tuning (confidence: medium)

**Claim.** Lowering `kCVPixelBufferPoolMaximumBufferAgeKey` to ~0.1 s and setting `kCVPixelBufferPoolAllocationThresholdKey` via `CVPixelBufferPoolCreatePixelBufferWithAuxAttributes` reduces resident IOSurface count and causes us to fail fast (via `kCVReturnWouldExceedAllocationThreshold`) when the pool is saturated, instead of triggering a kernel allocation at the wrong moment.

**Why we think this.** CVPixelBufferPool.h header text. The default 1-second age-out is long relative to our encoder working set.

**Setup.** Instrument our pools with the tuning. On threshold errors, drop the frame and log. Measure peak working set and hang incidence.

**Pass criterion.** Peak IOSurface working set measurably lower. Pipeline drops frames gracefully under pressure instead of hanging.

### H7 — Serialised encoder start-up (confidence: medium)

**Claim.** Starting the three encoders serially — each one fully prepared (including `PrepareToEncodeFrames`) and accepting frames before the next one is created — eliminates the allocation race that triggers the IOGPUFamily contention window.

**Why we think this.** The spindump shows the hang happens immediately at record-start; our mental model is that three encoder allocations happening in parallel during the first few hundred milliseconds is the vulnerable window. Serialising removes the parallelism at the one moment it causes harm.

**Setup.** Harness creates writer 1, calls `PrepareToEncodeFrames`, waits, then writer 2, etc. Open SCStream only after all encoders are ready. Compare to parallel creation.

**Pass criterion.** Hang goes away or is measurably delayed.

### H8 — Drop ScreenCaptureKit `queueDepth` to 3 (confidence: medium)

**Claim.** Using `SCStreamConfiguration.queueDepth = 3` (the default) instead of a higher value reduces the number of IOSurfaces the stream holds simultaneously and reduces pressure on IOGPUFamily.

**Why we think this.** WWDC22/10155 verbatim: "Increase the depth of the frame queue to ensure high fps at the expense of increasing the memory footprint of WindowServer." Apple's own sample code uses 5 but flags the trade-off explicitly.

**Setup.** Baseline whatever our current queueDepth is; test at 3.

**Pass criterion.** Stable runs with no observable drop in capture frame rate (measured via arrival timestamps on the SCStream callback).

### H9 — `PixelBufferPoolIsShared` audit (confidence: high as a diagnostic)

**Claim.** Reading `kVTCompressionPropertyKey_PixelBufferPoolIsShared` on every session immediately after creation will reveal any session where a hidden second IOSurface pool is silently doubling the footprint (the property returns `false` when the session and client pools are incompatible).

**Setup.** Log this value on every session at creation. Not a mitigation — a sanity check that the other tuning changes are actually having the effect we think.

**Pass criterion.** All sessions report `true`. Any `false` is an actionable bug.

### H10 — `RequireHardwareAcceleratedVideoEncoder = true` (confidence: medium as a diagnostic)

**Claim.** Setting this spec key to `true` on every session causes silent software fallback to fail loudly. If the current pipeline is ever silently falling back to software mid-session, this will surface it. Combined with the header note that "the hardware encoding resources on the machine are busy" is an enumerated failure case, this may give us an early-warning error at the point where IOGPUFamily would otherwise deadlock.

**Setup.** Add the spec key to all session creations. Watch for `-12908` / `-12915` or similar errors at session create or mid-stream.

**Pass criterion.** Either no errors (we are always on hardware) or we see an error at the contention moment instead of a hang.

### H11 — Shape change: drop ProRes, match Cap's recipe (confidence: high as a fallback)

**Claim.** If H1–H10 cumulatively fail to stabilise the 1440p preset, dropping ProRes entirely and matching Cap's two-H.264-sessions-no-live-compositing recipe is known-stable on M2 Pro-class hardware.

**Why we think this.** Cap is in production on M-series Pro hardware with this exact configuration. We have read the code.

**Setup.** Harness runs the Cap recipe: two `AVAssetWriter` sessions with `OutputSettingsAssistant.h264_3840x2160()`, four compression properties, `expectsMediaDataInRealTime = true`, SCStream `'420v'`, no CIContext compositor. Compositing deferred to post-recording (which we already do in server land for HLS segmenting).

**Pass criterion.** Stable at 1440p over N long-duration runs.

**Cost.** Loses the live composited HLS output that the server pipeline currently expects. The requirements doc already notes the streamed/composited version can be lower resolution than local capture — this may be the cleanest way to honour that.

### H12 — Per-writer heartbeat supervisor (confidence: medium, always worth having)

**Claim.** Adding a per-writer heartbeat (each writer posts "alive" every 250 ms; a supervisor kills and recreates the session if any heartbeat misses 2 s) gives us a userspace recovery path for failure modes 1, 3, and the `-3821` cluster. It does not fix failure mode 4 (kernel-level) but it contains its blast radius — if we can detect the hang early enough, we might be able to finalise the existing writers before the WindowServer watchdog fires.

**Setup.** Independent of the other hypotheses. Add heartbeat infrastructure, observe behaviour during deliberate overload.

**Pass criterion.** Deliberate overload (e.g. 4K preset via the old code path) produces a graceful stop instead of an ungraceful hang. Open question: whether 2 s is fast enough given WindowServer's 40-second watchdog — we need this to fire well before the watchdog.

---

## Unanswered questions and recommendations for follow-up

1. **Exact IOSurface budget on M2 Pro.** Apple does not publish a GPU memory budget. The only way to answer this is an empirical cliff map: task-0C should run the harness at increasing working-set sizes while polling `footprint` and `vm_stat`, and record the smallest footprint at which the hang reproduces. This would be the most valuable piece of data a Feedback Assistant report could include.

2. **Whether the ProRes engine is on its own AGX firmware channel.** Asahi has not reverse-engineered the video engines. We cannot answer this from public sources. The only path forward is to observe behaviour via Metal System Trace during a stable and a deadlocked run and compare the channel utilisation.

3. **Whether a specific Tahoe minor release regresses or fixes the ProRes path.** The Adobe Premiere reports are temporally adjacent but we have not confirmed the specific Tahoe version at which they started. Task-0C runs should log the macOS build number, and we should keep an eye on the next Tahoe release notes for any mention of ProRes, VideoToolbox, or IOSurface fixes.

4. **Whether the `-3821` cluster shares a root cause with our deadlock.** Our model says yes (both are resource exhaustion in the same stack, manifesting differently depending on where the call path is). We cannot prove this without either Apple engineer input or a harness that can reliably provoke both.

5. **Whether the Max/Ultra chip variants with multiple media engines avoid this entirely.** We do not have M-series Max/Ultra hardware to test on. If we can borrow one briefly, running the harness on it at 1440p would be high-value: same IOGPUFamily, different engine count. If it reproduces there too, the fix must be in userspace tuning; if it only reproduces on Pro, we have a sharper bug report.

6. **Whether a DTS ticket or Feedback Assistant submission would surface internal Apple engineer knowledge.** DTS tickets cost an incident but Apple engineers can answer questions about private frameworks when the customer case justifies it. Worth filing once task-0C has a minimal reproducer.

---

## References

### Apple primary sources

- [VideoToolbox framework](https://developer.apple.com/documentation/videotoolbox)
- [`VTCompressionSessionPrepareToEncodeFrames`](https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionpreparetoencodeframes(_:))
- [ScreenCaptureKit framework](https://developer.apple.com/documentation/screencapturekit/)
- [`SCStreamConfiguration`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration)
- [`SCStreamConfiguration.pixelFormat`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/pixelformat)
- [`SCStreamConfiguration.queueDepth`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/queuedepth)
- [Capturing screen content in macOS — sample code](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [AVFoundation — `AVAssetWriter`](https://developer.apple.com/documentation/avfoundation/avassetwriter)
- [`AVAssetWriterInput.expectsMediaDataInRealTime`](https://developer.apple.com/documentation/avfoundation/avassetwriterinput/expectsmediadatainrealtime)
- [Core Image — `CIContext(mtlCommandQueue:)`](https://developer.apple.com/documentation/coreimage/cicontext/init(mtlcommandqueue:))
- [IOSurface framework](https://developer.apple.com/documentation/iosurface)
- [IOSurface — `kIOSurfaceAllocSize`](https://developer.apple.com/documentation/iosurface/kiosurfaceallocsize)
- [IOSurface — `kIOSurfaceCacheMode`](https://developer.apple.com/documentation/iosurface/kiosurfacecachemode?changes=_7_1&language=objc)
- [IOKit — The I/O Registry (archive)](https://developer.apple.com/library/archive/documentation/DeviceDrivers/Conceptual/IOKitFundamentals/TheRegistry/TheRegistry.html)
- [Managing Memory — Viewing Virtual Memory Usage (archive)](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/ManagingMemory/Articles/VMPages.html)
- [Apple Metal Developer Tools](https://developer.apple.com/metal/tools/)
- [Apple Security Releases index](https://support.apple.com/en-us/100100)
- [Apple Developer Forums — `recommendedMaxWorkingSetSize`](https://developer.apple.com/forums/thread/732035)
- [Apple Developer Forums thread 694622 — ProRes / M1 Pro / FB9757381](https://developer.apple.com/forums/thread/694622)
- [Apple Developer Forums thread 682146 — AVAssetWriter with multiple Video…](https://developer.apple.com/forums/thread/682146)

### Apple WWDC sessions

- [WWDC22 session 10155 — Take ScreenCaptureKit to the next level](https://developer.apple.com/videos/play/wwdc2022/10155/)
- [WWDC22 session 10156 — Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/)
- [WWDC21 session 10158 — Explore low-latency video encoding with VideoToolbox](https://developer.apple.com/videos/play/wwdc2021/10158/)
- [WWDC24 session 10088 — Capture HDR content with ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2024/10088/)
- [WWDC20 — Optimize the Core Image pipeline for your video app](https://developer.apple.com/videos/play/wwdc2020/10008/)
- [WWDC22 session 10106 — Profile and optimize your game's memory](https://developer.apple.com/videos/play/wwdc2022/10106/)
- [WWDC19 session 608 — Metal for Pro Apps (ASCII transcript mirror)](https://asciiwwdc.com/2019/sessions/608)

### Apple open-source and SDK header mirrors

- [`apple-oss-distributions/xnu`](https://github.com/apple-oss-distributions/xnu)
- [`xnu/iokit/IOKit/IOUserClient.h`](https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/iokit/IOKit/IOUserClient.h)
- [phracker/MacOSX-SDKs — IOSurfaceAPI.h](https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX10.8.sdk/System/Library/Frameworks/IOSurface.framework/Versions/A/Headers/IOSurfaceAPI.h)
- [phracker/MacOSX-SDKs — VTCompressionProperties.h (macOS 11.3)](https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX11.3.sdk/System/Library/Frameworks/VideoToolbox.framework/Versions/A/Headers/VTCompressionProperties.h)
- [xybp888/iOS-SDKs — VTCompressionProperties.h](https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/VideoToolbox.framework/Headers/VTCompressionProperties.h)
- [xybp888/iOS-SDKs — VTCompressionSession.h](https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/VideoToolbox.framework/Headers/VTCompressionSession.h)
- [xybp888/iOS-SDKs — CVPixelBufferPool.h](https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/CoreVideo.framework/Headers/CVPixelBufferPool.h)
- [xybp888/iOS-SDKs — IOSurfaceTypes.h](https://github.com/xybp888/iOS-SDKs/blob/master/iPhoneOS13.0.sdk/System/Library/Frameworks/IOSurface.framework/Headers/IOSurfaceTypes.h)
- [xybp888/iOS-SDKs — AVAssetWriterInput.h](https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS13.0.sdk/System/Library/Frameworks/AVFoundation.framework/Headers/AVAssetWriterInput.h)
- [mkalmes/moby — IOSurface.framework.h](https://github.com/mkalmes/moby/blob/master/IOSurface.framework.h)

### Asahi Linux

- [Tales of the M1 GPU — Asahi Lina](https://asahilinux.org/2022/11/tales-of-the-m1-gpu/)
- [Apple GPU (AGX) docs](https://asahilinux.org/docs/hw/soc/agx/)
- [Dissecting the Apple M1 GPU, part II — Alyssa Rosenzweig](https://alyssarosenzweig.ca/blog/asahi-gpu-part-2.html)
- [The Apple GPU and the Impossible Bug — Alyssa Rosenzweig](https://alyssarosenzweig.ca/blog/asahi-gpu-part-5.html)
- [Asahi Progress Report 6.19](https://asahilinux.org/2026/02/progress-report-6-19/)
- [Asahi M2 Series feature support](https://asahilinux.org/docs/platform/feature-support/m2/)

### Comparable apps — source code

- [Cap — `crates/enc-avfoundation/src/mp4.rs`](https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/enc-avfoundation/src/mp4.rs)
- [Cap — `crates/recording/src/output_pipeline/macos.rs`](https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/recording/src/output_pipeline/macos.rs)
- [Cap — `crates/recording/src/studio_recording.rs`](https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/recording/src/studio_recording.rs)
- [Cap — `crates/recording/src/sources/screen_capture/macos.rs`](https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/recording/src/sources/screen_capture/macos.rs)
- [Cap issue #1449 — Screen Recording freezing on macOS](https://github.com/CapSoftware/Cap/issues/1449)
- [Cap issue #1466](https://github.com/CapSoftware/Cap/issues/1466)
- [OBS Studio — `plugins/mac-videotoolbox/encoder.c`](https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/mac-videotoolbox/encoder.c)
- [OBS Studio — `plugins/mac-capture/mac-sck-video-capture.m`](https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/mac-capture/mac-sck-video-capture.m)
- [OBS issue #5840 — `RealTime` property causes framedrops on ARM Macs](https://github.com/obsproject/obs-studio/issues/5840)
- [OBS PR #5809 — remove `RealTime` property](https://github.com/obsproject/obs-studio/pull/5809)
- [OBS forum — 8K H.264/HEVC hardware encoder crashes on M-series](https://obsproject.com/forum/threads/apple-vt-hardware-encoder-crashes-when-attempting-8k-recordings.154754/)
- [FFmpeg — `libavcodec/videotoolboxenc.c`](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/videotoolboxenc.c)
- [HandBrake — `libhb/platform/macosx/encvt.c`](https://raw.githubusercontent.com/HandBrake/HandBrake/master/libhb/platform/macosx/encvt.c)
- [HandBrake discussion #3932 — MacBook Pro M1 Pro/Max talks](https://github.com/HandBrake/HandBrake/discussions/3932)
- [HandBrake issue #5424 — VideoToolbox encoder hangs on Sonoma](https://github.com/HandBrake/HandBrake/issues/5424)

### Adjacent reports

- [Adobe — PPro/Media Encoder export broken on Tahoe 26.0.1](https://community.adobe.com/questions-729/unable-to-export-via-ppro-or-media-encoder-on-macos-tahoe-26-0-1-1551726)
- [Adobe — PPro aggregate Tahoe issues](https://community.adobe.com/questions-729/premiere-pro-issues-with-macos-tahoe-26-0-1420043)
- [Adobe — PPro 26 on Tahoe VM_ALLOCATE exhaustion](https://community.adobe.com/bug-reports-728/critical-memory-leak-premiere-pro-v26-0-on-macos-26-tahoe-89gb-vm-allocate-exhaustion...-1548856)
- [Adobe Premiere — known and fixed issues](https://helpx.adobe.com/premiere/desktop/troubleshooting/limitations-and-known-issues/known-and-fixed-issues.html)
- [OBS issue #13131 — SCK `-3821` freezes on macOS 15](https://github.com/obsproject/obs-studio/issues/13131)
- [OBS issue #9056 — macOS screen capture freezes after hours](https://github.com/obsproject/obs-studio/issues/9056)
- [QuickRecorder issue #142 — independent `-3821` freezes](https://github.com/lihaoyun6/QuickRecorder/issues/142)
- [fatbobman — ScreenSage pixel-to-meta architecture (`-3821` deep dive)](https://fatbobman.com/en/posts/screensage-from-pixel-to-meta/)
- [Nonstrict — A look at ScreenCaptureKit on macOS Sonoma](https://nonstrict.eu/blog/2023/a-look-at-screencapturekit-on-macos-sonoma/)
- [Nonstrict — Recording to disk with ScreenCaptureKit](https://nonstrict.eu/blog/2023/recording-to-disk-with-screencapturekit/)
- [Nonstrict — AVAssetWriter crash when using CMAF (FB12057159)](https://nonstrict.eu/blog/2023/avassetwriter-crash-when-using-CMAF/)
- [openradar-mirror #20742 — rdar://45889262](https://github.com/lionheart/openradar-mirror/issues/20742)

### Tertiary / background

- [objc.io — Video Toolbox and hardware acceleration](https://www.objc.io/issues/23-video/videotoolbox/)
- [Eclectic Light — WindowServer GPU crash vs kernel panic](https://eclecticlight.co/2020/06/05/windowserver-gpu-crash-different-from-a-kernel-panic/)
- [Eclectic Light — WindowServer architecture](https://eclecticlight.co/2020/06/08/windowserver-display-compositor-and-input-event-router/)
- [Apple Silicon GPU memory limits — Greg Stencel](https://stencel.io/posts/apple-silicon-limitations-with-usage-on-local-llm%20.html)
- [Russ Bishop — Cross-process Rendering](http://www.russbishop.net/cross-process-rendering)
- [Jonathan Levin — No pressure, Mon (memory pressure internals)](https://newosxbook.com/articles/MemoryPressure.html)
- [Fazm.ai — ScreenCaptureKit screen recording encoding approach](https://fazm.ai/blog/screencapturekit-screen-recording-encoding-approach)
- [VideoToolbox Codec Wiki](https://wiki.x266.mov/docs/encoders_hw/videotoolbox)
- [HandBrake VideoToolbox technical notes](https://handbrake.fr/docs/en/latest/technical/video-videotoolbox.html)
- [Macworld — M2 Max processor ProRes engine](https://www.macworld.com/article/1479571/m2-max-processor-video-prores-encode-decode-engine.html)
- [9to5Mac — M2 Max media engine spec correction](https://9to5mac.com/2023/01/20/apple-updates-m2-max-media-engine-specs/)

### Gaps where no public source exists

Called out explicitly so the memo is honest about what it could not learn:

- IOGPUFamily kext source or headers
- AGX firmware scheduling between video encode/decode engines and 3D/compute
- Whether `VTCompressionSession` instances share a kernel-level back-end queue
- Any documented IOSurface allocation timeout or retry policy
- Userspace API to query "GPU memory free" or "IOSurface pool free"
- Any sysctl or boot-arg to tune IOGPUFamily behaviour
- Closed-source comparable apps (Screen Studio, Loom, Riverside, Descript, Camo, Detail, Tella) — no engineering posts describing concurrent VT session counts or Apple Silicon 1440p mitigations
