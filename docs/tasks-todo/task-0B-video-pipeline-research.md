# Task 0B — M2 Pro Video Pipeline Research

This is a research task, not a coding task. The deliverable is a written document summarising what was found, what remains open, and what concrete hypotheses the follow-up work should test. **Do not modify any Swift code in this task.** If you find something that suggests a specific code change, record it as a hypothesis with a citation — do not implement it.

## Context

While implementing `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md`, we hit a series of failures on M2 Pro hardware that took the whole system down twice (hard power-cycle required). The failures are described in detail in `docs/m2-pro-video-pipeline-failures.md` — **read that doc in full before starting this research**. It is the primary source for everything below.

The short version: we're running a live recording pipeline on M2 Pro that combines up to four concurrent video/audio writers (composited HLS via H.264, raw screen via ProRes 422 Proxy on the separate ProRes engine, raw camera via H.264, raw audio via AAC) plus a CIContext compositor. Phase 2 of task-0A moved raw screen to ProRes specifically to avoid loading three streams on the single M2 Pro H.264 engine. That fix worked at 1080p output preset but caused a kernel-level hang at 1440p output preset. The diagnostic evidence points at the IOGPUFamily kernel extension as a shared resource between both hardware video engines — which our prior research did not anticipate.

Our mental model of the system's limits has failed us multiple times this session. We need to rebuild it with better information before touching the code again.

## Goal

Answer as many of the open research questions in `docs/m2-pro-video-pipeline-failures.md` as possible, and write up the findings as a new research document with citations. Generate a list of specific, testable hypotheses for the isolation test harness work (task-0C) to validate empirically.

## Out of scope

- **Do not modify Swift code.** Any proposed fix gets written down as a hypothesis to test.
- **Do not re-diagnose the failure modes.** The spindump analysis is already done; `docs/m2-pro-video-pipeline-failures.md` has it. Trust that doc and build on it.
- **Do not propose architectural changes** to the existing recording pipeline beyond what the research justifies. If the research turns up "Apple recommends doing X instead of Y", flag it with a citation and leave the decision to later work.
- **Do not try to reproduce the failures yourself.** The failures are reproducible on the target hardware but we don't want to hang the developer's Mac again. Reproduction is the job of task-0C (isolation test harness).

## Research areas

These are four investigations that can be done in parallel or sequentially. Each has its own questions, recommended sources, and success criteria.

### Area 1 — The failure mode 4 kernel signature

**Question:** Has anyone else reported a kernel-level IOGPUFamily deadlock with the specific signature we observed in failure mode 4 of the failure modes doc? If yes, what did they find out about the cause and any workarounds?

**The specific signature to search for:**

- `videotoolbox.preparationQueue` thread blocked inside `IOGPUFamily` kernel extension
- WindowServer watchdog timeout (`bug_type 409`) with LoomClone-style pipeline (multiple AVAssetWriters + CIContext)
- ProRes 422 Proxy writer running concurrently with H.264 writers causing WindowServer hang
- `VTEncoderXPCService.ProResFrameReceiver` thread parked for tens of seconds during a recording
- Importance donations from `VTEncoderXPCService` and `replayd` stacking up without progress

**Where to look:**

- **Apple Developer Forums** (https://developer.apple.com/forums/) — search for `IOGPUFamily deadlock`, `videotoolbox.preparationQueue stuck`, `AVAssetWriter concurrent hang`, `ProRes H264 concurrent`, `WindowServer watchdog recording`. The Video Toolbox and AVFoundation forums are the obvious places but don't skip the Metal, ScreenCaptureKit, and Media Technologies forums either.
- **OpenRadar** (https://openradar.appspot.com/) — search for `IOGPUFamily`, `VTEncoderXPCService`, `ProRes concurrent`. OpenRadar is community-sourced so coverage is uneven but sometimes has detailed bug reports with reproducers.
- **Feedback Assistant public threads** — Apple's newer bug tracker. Less searchable but occasionally indexed by Google.
- **Apple developer mailing list archives** (coreimage-dev, quicktime-api, ios-developer) — older but sometimes has deep technical threads.
- **GitHub issues** on projects that run multiple hardware video sessions: search terms like `M2 Pro AVAssetWriter hang`, `ProRes concurrent hang`, `IOGPUFamily`, `videotoolbox preparationQueue`. Projects worth searching:
  - OBS Studio (https://github.com/obsproject/obs-studio)
  - Screen Studio (closed-source, but their blog and changelog)
  - Cap (https://github.com/CapSoftware/Cap)
  - Sunshine (https://github.com/LizardByte/Sunshine)
  - HandBrake (https://github.com/HandBrake/HandBrake)
  - FFmpeg's Apple hardware acceleration issues (https://trac.ffmpeg.org and its GitHub mirror)
  - Moonlight, Parsec (closed-source but their forums)
- **Stack Overflow** — secondary source but sometimes has real engineer answers tagged with `avfoundation`, `videotoolbox`, `metal`, `avassetwriter`.
- **Hacker News / Lobste.rs archives** for posts about Apple Silicon video encoding — search the HN Algolia search.

**What a successful outcome looks like:**

- Zero to several concrete reports of the same or similar signature, with analysis of what the other reporters found
- If found: was it fixed in a specific macOS version? Is there a documented workaround? Did Apple respond?
- If not found: explicit note that we appear to be the first public report of this signature, which matters because it means we should capture our evidence well for a Feedback Assistant report later

### Area 2 — VideoToolbox best practices we're not using

**Question:** What VideoToolbox configuration practices, API surfaces, or session-tuning patterns are we NOT currently using that might affect concurrent-encode behaviour on single-media-engine Apple Silicon? The previous research pass covered the architectural question ("use ProRes to offload one stream") but didn't go deep on the tuning knobs within each session.

**Specific things to investigate:**

1. **`VTCompressionSession` / `VTCompressionSessionSetProperty` keys** — catalogue the ones that affect concurrency, scheduling, and resource allocation:
   - `kVTCompressionPropertyKey_RealTime` — what does it actually do? Does setting it to `true` make the encoder more or less aggressive about IOSurface allocation?
   - `kVTCompressionPropertyKey_MaxFrameDelayCount` — does reducing this lower the working IOSurface set?
   - `kVTCompressionPropertyKey_MaximizePowerEfficiency` — does it trade off speed for resource pressure?
   - `kVTCompressionPropertyKey_AllowFrameReordering` — does disabling reduce encoder state?
   - `kVTCompressionPropertyKey_Priority` or any priority-hint property — is there a way to tell one session to yield to another?
   - `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder` (read-only) — confirms hardware path
   - `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder` — forces hardware
   - `kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder` — allows fallback
   - `kVTCompressionPropertyKey_NumberOfPendingFrames` (read-only) — is there a corresponding settable limit?

2. **`VTCompressionSessionPrepareToEncodeFrames`** — we don't currently call this. The docs suggest it pre-allocates resources. Does it pre-allocate IOSurfaces? Is it the recommended pattern for pipelines that will immediately start producing frames at high rate?

3. **Pixel buffer pool sizing:**
   - `kCVPixelBufferPoolMinimumBufferCountKey` — does setting it explicitly affect IOGPUFamily allocation behaviour?
   - `kCVPixelBufferPoolMaximumBufferAgeKey` — does it help with IOSurface recycling pressure?
   - `CVPixelBufferPoolGetPixelBufferAttributes` — are there attributes we're missing?

4. **In-process vs out-of-process (XPC) encoding** — the spindump shows `VTEncoderXPCService` as a separate process doing the actual encoding. We saw `ProResFrameReceiver` parked in that process. Is there a way to force in-process encoding? If so, does it change the failure mode? What are the tradeoffs Apple themselves recommend?

5. **ScreenCaptureKit configuration knobs we aren't using:**
   - `SCStreamConfiguration.pixelFormat` — we currently default to BGRA. What about 420v (YCbCr)? Does it reduce IOSurface memory pressure?
   - `SCStreamConfiguration.minimumFrameInterval` — can we request lower framerates to reduce encoder load?
   - `SCStreamConfiguration.width/height` — can we configure ScreenCaptureKit to deliver at a lower resolution than display-native, which would drastically reduce per-frame IOSurface size?
   - `SCStreamConfiguration.queueDepth` — affects IOSurface pool sizing
   - `SCStreamConfiguration.capturesAudio` — not directly relevant but worth noting for context
   - `SCStreamConfiguration.showsCursor` — trivial but worth confirming doesn't change anything material

6. **AVAssetWriter pixel buffer adaptor tuning:**
   - `AVAssetWriterInputPixelBufferAdaptor` source pixel buffer attributes
   - `kCVPixelBufferPoolAllocatorContext` — is there a way to share an IOSurface pool between writers to reduce pressure?

**Where to look:**

- **Apple developer documentation:**
  - https://developer.apple.com/documentation/videotoolbox
  - https://developer.apple.com/documentation/avfoundation/avassetwriter
  - https://developer.apple.com/documentation/screencapturekit
  - https://developer.apple.com/documentation/corevideo/cvpixelbufferpool
  - The header files themselves (VTCompressionProperties.h, CVPixelBuffer.h) are sometimes more detailed than the online docs
- **WWDC session videos and transcripts:**
  - WWDC21 "Explore low-latency video encoding with VideoToolbox" (session 10158)
  - WWDC22 "Meet ScreenCaptureKit" (10156) and "Take ScreenCaptureKit to the next level" (10155)
  - WWDC24 "Capture HDR content with ScreenCaptureKit" (10088)
  - WWDC22/23/24 "Explore media performance tools" sessions (if they exist)
  - Anything from WWDC on "AVFoundation performance" or "Apple Silicon media pipeline"
- **Technical Notes and Q&As:**
  - TN2227: Video Color Management in AV Foundation
  - QA1839: Specifying color space information for pixel buffers
  - Look for any TN/QA with "VideoToolbox", "multi-stream", "concurrent"
- **Sample code:**
  - Apple's VideoToolbox sample code (if any)
  - Apple's "Capturing HDR video" sample
  - Apple's ScreenCaptureKit sample (https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
  - RosyWriter and similar

**What a successful outcome looks like:**

- A list of every `VTCompressionSession`, `CVPixelBufferPool`, and `SCStreamConfiguration` property we don't currently set, with a one-sentence "what this does" and "whether it might help us" for each
- Explicit answers about `VTCompressionSessionPrepareToEncodeFrames` — is it the recommended warm-up pattern?
- An answer about whether in-process encoding is possible and whether it would help
- A list of Apple sample code demonstrating any pattern close to ours (or a definitive "Apple does not ship any sample code running more than N concurrent sessions")

### Area 3 — IOGPUFamily and IOSurface resource management

**Question:** What is publicly documented (or indirectly visible through reverse-engineering) about IOGPUFamily's behaviour and IOSurface resource management on Apple Silicon? This is the layer the failure mode 4 spindump points at, and the layer where our previous research had the biggest gap.

**Specific things to investigate:**

1. **IOGPUFamily itself:**
   - Is there any public documentation about how IOGPUFamily arbitrates IOSurface allocation between competing userspace clients?
   - Are there tunable resource limits? (likely no, but worth checking)
   - Are the kext sources or headers publicly available? (IOKit headers in the XNU source tree at https://github.com/apple-oss-distributions may have relevant interfaces, though the kext itself is closed)
   - Are there any Apple Silicon GPU architecture documents that discuss the IOSurface pool shared between display compositing and hardware video encode?

2. **IOSurface:**
   - Documented IOSurface attributes we might not be using: `kIOSurfacePurgeable`, `kIOSurfaceElementSize`, `kIOSurfaceAllocSize`, pool hints
   - Is there a way to query IOSurface resource pressure? (`vm_stat` has some relevant counters, `ioreg` exposes IOGPUFamily state)
   - What does a "stuck in IOGPUFamily" thread look like when it eventually recovers or gets killed — is there a timeout, or can it really hang indefinitely?

3. **Command buffer arbitration:**
   - Metal command queues vs IOKit command-buffer queues: what's the relationship? Our earlier research said they arbitrate through the same IOKit layer. What's the evidence for that beyond forum posts?
   - Does `CIContext(mtlCommandQueue:)` actually give CIContext an independent command queue, or does Core Image internally route everything through a shared queue anyway?
   - Is there a way to see IOKit command buffer queue state from userspace (e.g. via `ioreg`)?

4. **Shared memory pressure on unified-memory architecture:**
   - M2 Pro has 32 GB unified memory; how much of that is available to IOGPUFamily?
   - What's the relationship between IOSurface memory and general virtual memory pressure? Is there a "GPU memory exhausted" state that we could detect?
   - `vm_stat` counters, `hostinfo`, `sysctl` keys worth capturing during a test run

**Where to look:**

- **Apple's open-source XNU and IOKit components** at https://github.com/apple-oss-distributions (formerly opensource.apple.com) — IOSurface headers, IOKit framework headers. The kext sources are not there but the public interfaces are.
- **Apple developer documentation** for IOSurface and IOKit
- **WWDC sessions** on Metal performance, unified memory, GPU profiling with Instruments
- **Instruments documentation** — what can the Metal System Trace, GPU frame-capture, and IOActivity instruments tell us about IOGPUFamily pressure?
- **Reverse-engineering / blog posts** — Asahi Linux's work on Apple Silicon GPU reverse engineering (https://asahilinux.org/) has the most public detail about GPU internals of any Apple Silicon chip. They may have documented IOGPUFamily's role. This is a legitimate and well-cited source.
- **Hector Martin's and Lina's writeups** on Apple Silicon GPU architecture (they did the Asahi GPU driver)
- **CVE databases** — if IOGPUFamily has had published security issues, the advisories sometimes reveal behaviour
- **Pre-submitted WWDC session talks** and Apple tech blog posts

**What a successful outcome looks like:**

- A clearer picture of where IOGPUFamily sits in the macOS stack and what it's responsible for
- Any public documentation or reverse-engineered understanding of its resource allocation strategy
- A concrete list of what to capture during a test run to observe IOGPUFamily state (ioreg nodes, vm_stat counters, log predicates)
- An honest assessment: is it realistic for us to understand this layer well enough to predict behaviour, or do we need to treat it as a black box and validate empirically?

### Area 4 — How comparable apps handle concurrent writers

**Question:** How do other apps that run multiple concurrent hardware video sessions on Apple Silicon actually do it? What patterns do they use that we're not using, and what patterns do they explicitly avoid?

**Targets, in rough order of value:**

1. **Cap (https://github.com/CapSoftware/Cap)** — open source, Rust + Swift, similar use case to ours, actively maintained. **Clone it and read the capture/encoder code directly.** We already have a research doc about Cap at `docs/research/03-cap-codebase-analysis.md` from the original research phase — start there and focus on what we DIDN'T cover: how do they handle multiple simultaneous writers? Do they run raw screen + composited output? Do they ever use ProRes? Have they had issues with concurrent H.264 sessions on M2 Pro-class hardware? Check their issue tracker for anything resembling our failure modes.

2. **OBS Studio** (https://github.com/obsproject/obs-studio) — open source. OBS on macOS is the community gold standard for "multi-writer Apple Silicon encoding." Their forum has multiple threads about 4K H.264 overload on M-series chips. Find:
   - Their macOS-specific encoder setup code (search for `VTCompressionSession`, `videotoolbox`, `prores`)
   - Any pool sizing or warm-up patterns
   - Bug reports from users about "OBS hangs my Mac" or "Metal command buffer errors"
   - Forum threads about the recommended configuration for 2–3 concurrent encode streams

3. **FFmpeg's VideoToolbox backend** (https://github.com/FFmpeg/FFmpeg) — not a comparable app but the reference implementation for most third-party VideoToolbox use. See `libavcodec/videotoolboxenc.c`. Patterns for session creation, property setting, and pool management are all worth cataloguing.

4. **Screen Studio** (closed source) — watch their changelog, blog, and any Twitter/Mastodon posts from their team about how they handle concurrent writers on Apple Silicon. They're known for high polish on M-series Macs.

5. **Loom desktop app** (closed source) — reverse engineering is out of scope, but if their engineering blog or any WWDC lab discussion touches on their architecture, that's fair game.

6. **Riverside, Descript, Camo, Detail, Tella** — all do some form of multi-source Mac capture. Any of them with open-source components or engineering blogs worth checking.

**What a successful outcome looks like:**

- Concrete code patterns from Cap, OBS, and FFmpeg for how to set up a VideoToolbox encode session with the tuning we discussed in Area 2
- A "known-stable recipe" from at least one production-grade app that runs multiple concurrent writers on M2 Pro-class hardware
- Confirmed information about whether any of these apps have hit our failure modes and what they did about it
- A list of things those apps DON'T do that we currently DO (e.g. do any of them run three concurrent writers? If not, we know we're out on a limb)

## Deliverable

**Output file:** `docs/research/11-m2-pro-video-pipeline-deep-dive.md` (or next available number in `docs/research/` — check the existing files first and use the next sequential number).

**Structure of the output:**

1. **Summary** — 300-500 word executive summary of what was learned, written so that someone who only has 2 minutes can still make informed decisions.
2. **Area 1 findings** — kernel signature research with citations
3. **Area 2 findings** — VideoToolbox best practices catalogue with citations
4. **Area 3 findings** — IOGPUFamily / IOSurface understanding with citations
5. **Area 4 findings** — comparable apps analysis with specific code references
6. **Updated answers to the open research questions** from `docs/m2-pro-video-pipeline-failures.md` — go through each of the eight open questions in that doc's "Open research questions" section and update them with findings. If a question remains open, say so explicitly and note why.
7. **Hypotheses to test in the isolation harness (task-0C)** — concrete, falsifiable statements the test harness can validate. For example:
   - "Setting `kVTCompressionPropertyKey_RealTime = true` on all three writers reduces IOSurface allocation pressure and prevents the failure mode 4 deadlock at 1440p preset."
   - "Configuring ScreenCaptureKit with `SCStreamConfiguration.pixelFormat = 420v` reduces screen IOSurface size by 50% and is sufficient to make 1440p stable."
   - Each hypothesis needs enough specificity that the harness can set up a test, run it, and report pass/fail.
8. **Unanswered questions and recommendations for follow-up** — what the research couldn't determine, and what would be needed to answer it (e.g. "This would require either running a specific Instruments trace during a stable recording at 1080p and comparing it to a deadlocked recording at 1440p, or filing a DTS ticket with Apple.").
9. **References** — full list of sources cited, with URLs, session titles, and (where applicable) direct quotes or line references in source code.

**Writing style:**

- Cite everything. "Apple says X" → include the URL. "OBS does X" → include the file path and line numbers.
- Be explicit about confidence. Don't present interpretations as settled fact.
- Flag anything that contradicts the previous research pass (see `docs/research/` for existing docs and `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` Background section for the previous research summary). Contradictions are valuable data.
- If a source is behind a login wall or otherwise inaccessible, note that explicitly so we know what we're missing.
- No time estimates, no hedging clichés, no "it depends" without a follow-up. Write like a senior engineer producing an internal technical memo.

## Hard constraints

- **Zero code changes.** Not even in a test harness — that's task-0C's job.
- **Do not try to reproduce the failures** on the developer's Mac. We already have the diagnostic evidence; the failure modes doc has it preserved. Re-triggering a system hang to "verify" something is not acceptable during this task.
- **Do not go down rabbit holes that aren't in the four research areas** above. If the research agent finds something fascinating but unrelated (e.g. HDR encoding, Neural Engine stuff), note it as "interesting follow-up" and move on.
- **Budget for depth, not breadth.** It is better to answer three of the open questions definitively than to gesture at all eight.
- **When in doubt, cite and move on.** A research report full of "I found X, it says Y, here's the URL, here's my assessment of relevance" is more useful than one full of original analysis of sources you couldn't verify.

## Handoff

This task feeds directly into task-0C (isolation test harness). The hypotheses section in the deliverable is the primary input to 0C — the harness needs concrete tests to run, and this research is where those tests come from.

The research task and the harness task can run in parallel. The harness doesn't need to wait for research findings to start being built; it can incorporate new hypotheses as they land. But the harness's first useful test runs benefit from having at least some research hypotheses to validate, so there's an implicit coordination: start research first, start harness shortly after, let the research feed hypotheses into the harness as they're discovered.

## Briefing for the research agent

If running this task with a subagent, the briefing should include at minimum:

1. **Read these files in this order:**
   - `docs/m2-pro-video-pipeline-failures.md` (full)
   - `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` (full, especially the Background section and the Outcome subsections for Phase 1 and Phase 2)
   - `docs/research/03-cap-codebase-analysis.md` (the existing research on Cap)
   - `docs/research/01-macos-recording-apis.md` (the existing research on macOS APIs)
2. **Understand the current state** — task-0A Phase 2b is half-done. The 1440p preset has been implemented but triggers failure mode 4. We're not touching the code until we have better information.
3. **Produce the research document** as described in the Deliverable section above.
4. **Do not implement anything.** Do not run the app. Do not try to reproduce failures. Focus on research output only.

An example prompt for the subagent:

> I need you to do deep research into a specific set of questions about the macOS video pipeline on M2 Pro. Read `docs/m2-pro-video-pipeline-failures.md` and `docs/tasks-todo/task-0B-video-pipeline-research.md` in full. Then work through the four research areas in the task doc, producing a single research report at `docs/research/11-m2-pro-video-pipeline-deep-dive.md` following the structure specified in the Deliverable section. Do not modify any Swift code. Do not try to reproduce failures on this machine. Cite all sources with URLs. Your output is a research memo, not an implementation.
