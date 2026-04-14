import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

// MARK: - HarnessRunner
//
// Orchestrates a single test run. One config in, one result.json out.
// The runner is deliberately linear: set up, start writers, spin a
// metronome that drives frames into the writers for the configured
// duration, stop, finalise. No cancellation UI, no retries.
//
// The metronome is a tight dispatch loop with wall-clock waits
// between frames, NOT a real CADisplayLink/CVDisplayLink. The
// harness doesn't care about matching display refresh — it cares
// about producing frames at ~30 fps with reliable timing metadata.
//
// Tier-1 tests are the first thing this runs, all with synthetic
// frame sources. Tier-4 real-capture support is additive and lives
// behind the "real-screen" / "real-camera" source kinds (not
// implemented yet — bail at configure time if requested).

final class HarnessRunner {

    private let config: HarnessConfig
    private let testRunsRoot: URL
    private let runDirectory: URL
    private let events: EventLog
    private let startDate: Date
    private let watchdog: WatchdogTimer

    private var writers: [HarnessWriter] = []
    private var compositor: HarnessCompositor?
    private var screenSource: HarnessFrameSource?
    private var cameraSource: HarnessFrameSource?

    private var framesSubmitted = 0
    private var framesDropped = 0
    private var firstFrameAt: Double?
    private var lastFrameAt: Double?

    // Generation watermarks — the metronome only feeds the raw-screen /
    // raw-camera writers when the source's `generation` has advanced
    // since the previous feed. Prevents the 30fps metronome from
    // hammering ProRes 4K with 100 copies of a single SCStream frame
    // during periods when real capture is delivering sparsely, which
    // GPU-starved SCStream itself through shared-compositor contention.
    // Composited HLS still gets fed every tick because the compositor's
    // output changes even when the raw screen buffer is stale (camera
    // overlay updates, etc.).
    private var lastFedScreenGen: Int64 = Int64.min
    private var lastFedCameraGen: Int64 = Int64.min

    private var runtimeIssues: [String] = []

    init(config: HarnessConfig, testRunsRoot: String) {
        self.config = config
        self.testRunsRoot = URL(fileURLWithPath: testRunsRoot)

        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd-HHmmss"
        fmt.timeZone = TimeZone(identifier: "UTC")
        let stamp = fmt.string(from: Date())
        let runName = "\(stamp)-\(config.name)"
        self.runDirectory = self.testRunsRoot.appendingPathComponent(runName)
        try? FileManager.default.createDirectory(
            at: self.runDirectory,
            withIntermediateDirectories: true
        )

        self.startDate = Date()

        // Create the event log before anything else so early errors
        // still land in events.jsonl.
        do {
            self.events = try EventLog(runDirectory: self.runDirectory)
        } catch {
            // Can't construct EventLog — fall back to a stub pointed at
            // /dev/null. The run is doomed at this point but we can at
            // least finish cleanly.
            let devNull = URL(fileURLWithPath: "/dev/null")
            self.events = (try? EventLog(runDirectory: devNull.deletingLastPathComponent()))
                ?? (try! EventLog(runDirectory: devNull.deletingLastPathComponent()))
        }

        // Arm the watchdog FIRST, before any AVFoundation work.
        // Deadline is duration + grace. On fire the watchdog exits(40).
        let deadline = config.durationSeconds + config.watchdogGraceSeconds
        self.watchdog = WatchdogTimer(deadlineSeconds: deadline, onFire: {
            // Best-effort final snapshot before exit. Must be cheap and
            // non-blocking — if the system is wedged this will hang
            // forever on its own 2s cleanup budget.
        })
    }

    // MARK: - Run

    func run() async -> HarnessResult {
        events.log("run.start", [
            "name": config.name,
            "duration": config.durationSeconds,
        ])

        // Write the last-known-good marker.
        do {
            try InProgressMarker.write(
                config: config,
                runDirectory: runDirectory,
                testRunsRoot: testRunsRoot
            )
        } catch {
            events.log("run.marker-write-failed", ["error": error.localizedDescription])
        }

        SystemSnapshot.capture(runDirectory: runDirectory, label: "start")

        // Persist the config.json alongside the events log for
        // reproducibility.
        if let data = try? config.encoded() {
            try? data.write(to: runDirectory.appendingPathComponent("config.json"))
        }

        // Arm the watchdog right before we touch AVFoundation.
        watchdog.arm()
        events.log("watchdog.armed", ["deadline": config.durationSeconds + config.watchdogGraceSeconds])

        // Build writers, sources, compositor.
        do {
            try buildFrameSources()
            try buildCompositor()
            try buildWriters()
        } catch {
            events.log("run.setup-failed", ["error": error.localizedDescription])
            return await finalise(outcome: "fail-recorded",
                                  summary: "setup failed: \(error.localizedDescription)")
        }

        // Start the writers. Default is serial — each writer's startWriting()
        // fully completes before the next one begins, matching the main app's
        // prepareRecording ordering after task-1 tuning 2. "parallel" is a
        // Tier 5 priority 7 sweep variant that kicks them off at the same
        // time via a TaskGroup, so we can measure whether serialised warm-up
        // is actually load-bearing.
        events.log("writers.warm-up", ["mode": config.warmUp])
        if config.warmUp == "parallel" {
            await withTaskGroup(of: Void.self) { group in
                for w in writers {
                    group.addTask { w.startWriting() }
                }
            }
        } else {
            for w in writers {
                w.startWriting()
            }
        }

        // Start any real-capture sources (SCStream / AVCaptureSession)
        // AFTER the writers are warmed. This matches the main-app ordering
        // from task-1 tuning 2 — writers are in `.writing` before the
        // capture pipeline starts delivering buffers.
        do {
            try await startRealCaptureSources()
        } catch {
            events.log("run.capture-start-failed", ["error": "\(error)"])
            await stopRealCaptureSources()
            return await finalise(outcome: "fail-recorded",
                                  summary: "capture failed to start: \(error)")
        }

        // Drive the metronome for the configured duration.
        await runMetronome()

        // Stop capture BEFORE stopping writers so no more buffers arrive
        // while finishWriting is draining.
        await stopRealCaptureSources()

        // Stop writers in parallel; each one awaits its finishWriting
        // callback. The watchdog is still armed in case finish hangs.
        events.log("run.stopping-writers")
        await withTaskGroup(of: Void.self) { group in
            for w in writers {
                group.addTask { await w.finish() }
            }
        }
        events.log("run.writers-stopped")

        // Compute outcome and finalise.
        return await finalise(outcome: computeOutcome(), summary: buildSummary())
    }

    // MARK: - Setup

    private func buildFrameSources() throws {
        try constructSource(from: config.source)
        for extra in config.source.additional ?? [] {
            try constructSource(from: extra)
        }
    }

    /// Construct a single source entry (primary or additional) and assign
    /// it to `screenSource` / `cameraSource` based on kind. Synthetic and
    /// real-capture kinds share the same slot — the metronome doesn't
    /// care which a source is, it just calls `makePixelBuffer(index:)`.
    /// Real-capture sources are constructed but NOT started here;
    /// `startRealCaptureSources()` drives the async `start()` path.
    private func constructSource(from src: SourceConfig) throws {
        switch src.kind {
        case "synthetic-screen":
            // Task-1 tuning 1: default synthetic-screen to 420v to match
            // the main-app SCStream pixel path. Use "synthetic-screen-bgra"
            // explicitly for the BGRA exception case.
            screenSource = SyntheticFrameSource(
                kind: .screen420v,
                width: src.width ?? 3840,
                height: src.height ?? 2160,
                pattern: parsePattern(src.pattern),
                colorSpace: parseColorSpace(src.colorSpace)
            )
        case "synthetic-screen-bgra":
            screenSource = SyntheticFrameSource(
                kind: .screenBGRA,
                width: src.width ?? 3840,
                height: src.height ?? 2160,
                pattern: parsePattern(src.pattern),
                colorSpace: parseColorSpace(src.colorSpace)
            )
        case "synthetic-camera":
            cameraSource = SyntheticFrameSource(
                kind: .camera420v,
                width: src.width ?? 1280,
                height: src.height ?? 720,
                pattern: parsePattern(src.pattern),
                colorSpace: parseColorSpace(src.colorSpace)
            )
        case "synthetic-audio":
            // Audio-only; the metronome generates silent PCM on the fly.
            break
        case "real-screen":
            var cfg = CapturedScreenSource.Config()
            cfg.displayID = src.displayID
            cfg.displayName = src.displayName
            cfg.frameRate = config.frameRate
            screenSource = CapturedScreenSource(config: cfg, events: events)
        case "real-camera":
            var cfg = CapturedCameraSource.Config()
            cfg.deviceUniqueID = src.deviceUniqueID
            cfg.deviceName = src.deviceName
            cfg.maxHeight = src.maxHeight ?? Int.max
            cameraSource = CapturedCameraSource(config: cfg, events: events)
        default:
            throw HarnessRunnerError.unsupportedSource(src.kind)
        }
    }

    /// Start any real-capture sources (SCStream / AVCaptureSession) that
    /// need to warm up before the metronome begins pulling frames.
    /// Synthetic sources no-op. Called after the writers are warmed up
    /// but before the metronome — this mirrors the main-app ordering
    /// where the writers are in `.writing` state before the capture
    /// pipeline starts delivering buffers.
    private func startRealCaptureSources() async throws {
        if let s = screenSource {
            try await s.start()
            if let captured = s as? CapturedScreenSource {
                events.log("source.screen-started", [
                    "display": captured.selectedDisplayName,
                    "width": Int(captured.nativePixelSize.width),
                    "height": Int(captured.nativePixelSize.height),
                ])
            }
        }
        if let c = cameraSource {
            try await c.start()
            if let captured = c as? CapturedCameraSource {
                events.log("source.camera-started", [
                    "device": captured.selectedDeviceName,
                    "width": Int(captured.nativePixelSize.width),
                    "height": Int(captured.nativePixelSize.height),
                ])
            }
        }
    }

    private func stopRealCaptureSources() async {
        await screenSource?.stop()
        await cameraSource?.stop()
    }

    private func buildCompositor() throws {
        guard let comp = config.compositor else { return }
        compositor = try HarnessCompositor(
            outputWidth: comp.outputWidth,
            outputHeight: comp.outputHeight,
            useLanczos: comp.useLanczosScaling,
            renderMode: comp.renderMode,
            events: events
        )
        events.log("compositor.built", [
            "output": "\(comp.outputWidth)x\(comp.outputHeight)",
            "mode": comp.renderMode,
            "lanczos": comp.useLanczosScaling,
            "overlay": comp.includeCameraOverlay,
        ])
    }

    private func buildWriters() throws {
        for wc in config.writers {
            let w = try makeWriter(from: wc)
            try w.configure()
            writers.append(w)
        }
    }

    private func makeWriter(from wc: WriterConfig) throws -> HarnessWriter {
        let outputsDir = runDirectory.appendingPathComponent("outputs")
        try? FileManager.default.createDirectory(
            at: outputsDir, withIntermediateDirectories: true
        )

        switch wc.kind {
        case "raw-prores":
            let url = outputsDir.appendingPathComponent("\(wc.name).mov")
            return HarnessRawProResWriter(
                name: wc.name,
                width: wc.width ?? 3840,
                height: wc.height ?? 2160,
                outputURL: url,
                tunings: wc.tunings ?? [:],
                events: events
            )
        case "raw-h264":
            let url = outputsDir.appendingPathComponent("\(wc.name).mp4")
            return HarnessRawH264Writer(
                name: wc.name,
                width: wc.width ?? 1920,
                height: wc.height ?? 1080,
                bitrate: wc.bitrate ?? 6_000_000,
                outputURL: url,
                tunings: wc.tunings ?? [:],
                events: events
            )
        case "raw-audio":
            let url = outputsDir.appendingPathComponent("\(wc.name).m4a")
            return HarnessRawAudioWriter(
                name: wc.name,
                sampleRate: wc.sampleRate ?? 48_000,
                channels: wc.channels ?? 2,
                bitrate: wc.bitrate ?? 128_000,
                outputURL: url,
                events: events
            )
        case "composited-hls":
            // HLS writers don't write to a single on-disk file — they
            // publish segments via a delegate. We pass a placeholder URL
            // that's never opened.
            let url = outputsDir.appendingPathComponent("\(wc.name).hls")
            return HarnessCompositedHLSWriter(
                name: wc.name,
                width: wc.width ?? 1920,
                height: wc.height ?? 1080,
                bitrate: wc.bitrate ?? 6_000_000,
                outputURL: url,
                tunings: wc.tunings ?? [:],
                events: events
            )
        default:
            throw HarnessRunnerError.unsupportedWriter(wc.kind)
        }
    }

    private func parsePattern(_ s: String) -> SyntheticFrameSource.Pattern {
        switch s {
        case "solid": return .solid
        case "gradient": return .gradient
        case "noise": return .noise
        default: return .moving
        }
    }

    private func parseColorSpace(_ s: String) -> SyntheticFrameSource.ColorSpaceTag {
        switch s {
        case "p3": return .p3
        case "rec709": return .rec709
        default: return .srgb
        }
    }

    // MARK: - Metronome

    private func runMetronome() async {
        let frameRate = config.frameRate
        let frameDurationSeconds = 1.0 / Double(frameRate)
        let totalFrames = Int(config.durationSeconds * Double(frameRate))
        let audioSamplesPerBuffer = 1024
        let audioBuffersPerFrame = max(1, 48_000 / frameRate / audioSamplesPerBuffer)

        // Does this run have any video path at all? Audio-only configs
        // have no screen or camera source and no compositor — we still
        // run the loop so the audio path gets ticked at a stable rate,
        // but we skip the video work entirely (no fake "no-buffer"
        // events, no spurious dropped-frame counts).
        let hasVideoPath = (screenSource != nil) || (cameraSource != nil) || (compositor != nil)

        events.log("metronome.start", [
            "frameRate": frameRate,
            "totalFrames": totalFrames,
            "hasVideoPath": hasVideoPath,
        ])

        let startTime = Date()

        var audioIndex: Int64 = 0

        for frameIndex in 0..<totalFrames {
            if hasVideoPath {
                // Snapshot source generations before pulling buffers so
                // we can decide whether each source has produced
                // something new since our last tick.
                let screenGen = screenSource?.generation
                let cameraGen = cameraSource?.generation

                // Produce screen frame (if any) — first try the compositor,
                // fall back to the direct source buffer.
                let screenBuffer = screenSource?.makePixelBuffer(index: Int64(frameIndex))
                var cameraFedSomeWriter = false
                if let cs = cameraSource,
                   let cameraBuffer = cs.makePixelBuffer(index: Int64(frameIndex)) {
                    compositor?.updateCameraFrame(cameraBuffer)
                    // Feed the raw camera writer only when the camera
                    // source has produced a new buffer since last feed.
                    // For synthetic sources generation advances every
                    // tick (matching previous behaviour); for real
                    // capture it advances at capture rate.
                    let cameraIsFresh = (cameraGen ?? lastFedCameraGen) != lastFedCameraGen
                    if cameraIsFresh {
                        cameraFedSomeWriter = feedCameraWriters(
                            cameraBuffer,
                            frameIndex: Int64(frameIndex),
                            frameRate: frameRate
                        )
                        lastFedCameraGen = cameraGen ?? lastFedCameraGen
                    }
                }

                // Only do the screen-side work (composite + raw-screen
                // sample build) when the screen source has produced a
                // new buffer since our last feed. Synthetic sources
                // advance generation every tick (matching the previous
                // behaviour exactly), so synthetic runs are unchanged.
                // For real capture this ties the compositor + HLS
                // feed to SCStream's actual delivery rate — same
                // model the main app uses — which keeps GPU load down
                // to what WindowServer's SCStream can schedule around.
                // A 30fps metronome driving a 30fps composite + H.264
                // encode regardless of SCStream's true rate was
                // GPU-starving SCStream itself through shared-
                // compositor contention.
                let screenIsFresh = (screenGen ?? lastFedScreenGen) != lastFedScreenGen
                var rawScreenSample: CMSampleBuffer?
                var compositedSample: CMSampleBuffer?
                if screenIsFresh {
                    lastFedScreenGen = screenGen ?? lastFedScreenGen
                    if let b = screenBuffer {
                        rawScreenSample = Self.makeSampleBuffer(
                            from: b,
                            index: Int64(frameIndex),
                            frameRate: frameRate
                        )
                    }
                    let compositedBuffer: CVPixelBuffer?
                    if let compositor {
                        compositedBuffer = compositor.compositeFrame(
                            screen: screenBuffer,
                            includeCameraOverlay: config.compositor?.includeCameraOverlay ?? false
                        )
                    } else {
                        compositedBuffer = screenBuffer
                    }
                    if compositor != nil {
                        compositedSample = compositedBuffer.flatMap {
                            Self.makeSampleBuffer(
                                from: $0,
                                index: Int64(frameIndex),
                                frameRate: frameRate
                            )
                        }
                    } else {
                        compositedSample = rawScreenSample
                    }
                }

                if rawScreenSample != nil || compositedSample != nil {
                    feedVideoWriters(rawScreen: rawScreenSample,
                                     composited: compositedSample)
                    if firstFrameAt == nil { firstFrameAt = events.elapsed() }
                    lastFrameAt = events.elapsed()
                    framesSubmitted += 1
                } else if cameraFedSomeWriter {
                    // Camera-only run (e.g. T1.5): the camera writer
                    // received a frame, the main video path has no
                    // screen source, so there's no screen-side sample
                    // buffer — that's expected, not a drop.
                    if firstFrameAt == nil { firstFrameAt = events.elapsed() }
                    lastFrameAt = events.elapsed()
                    framesSubmitted += 1
                } else if screenSource != nil {
                    // We had a screen source that failed to produce a
                    // buffer — that IS a drop. Cap the log output so
                    // a persistent failure doesn't flood events.jsonl.
                    framesDropped += 1
                    if framesDropped <= 5 {
                        events.log("metronome.no-buffer", ["frame": frameIndex])
                    }
                }
            }

            // Audio (silent PCM) — emit enough buffers per video frame
            // to roughly match real-time pacing at the target sample rate.
            for _ in 0..<audioBuffersPerFrame {
                if let audioSample = SyntheticFrameSource.makeSilentAudioSampleBuffer(
                    index: audioIndex,
                    samplesPerBuffer: audioSamplesPerBuffer
                ) {
                    feedAudioWriters(audioSample)
                }
                audioIndex += 1
            }

            // Wall-clock pace to ~frameRate. We don't use Task.sleep
            // because its resolution is too coarse for 30fps metering
            // on some macOS builds. usleep at microsecond granularity
            // is fine for a diagnostic tool.
            let target = startTime.addingTimeInterval(Double(frameIndex + 1) * frameDurationSeconds)
            let now = Date()
            if target > now {
                let sleepSeconds = target.timeIntervalSince(now)
                usleep(UInt32(sleepSeconds * 1_000_000))
            }

            if frameIndex % (frameRate * 5) == 0 && frameIndex > 0 {
                events.log("metronome.progress", [
                    "frame": frameIndex,
                    "elapsed": events.elapsed(),
                ])
            }
        }

        events.log("metronome.stop", ["framesSubmitted": framesSubmitted])
    }

    /// Route screen-side writers by kind + name convention:
    ///   - `composited-hls`  → the composited sample (falls back to
    ///     rawScreen when no compositor is configured).
    ///   - `raw-prores`      → the rawScreen sample. Always. Mirrors
    ///     main-app Phase 2 where ProRes records the native SCStream
    ///     output, not the compositor output.
    ///   - `raw-h264` (screen side, i.e. name does NOT contain "camera")
    ///                       → the rawScreen sample.
    ///   - `raw-h264` (camera side) → fed separately via
    ///     `feedCameraWriters`. Ignored here.
    private func feedVideoWriters(rawScreen: CMSampleBuffer?,
                                  composited: CMSampleBuffer?) {
        for w in writers {
            switch w.kind {
            case "composited-hls":
                if let composited { w.appendVideo(composited) }
            case "raw-prores":
                if let rawScreen { w.appendVideo(rawScreen) }
            case "raw-h264":
                if !w.name.lowercased().contains("camera"), let rawScreen {
                    w.appendVideo(rawScreen)
                }
            default:
                break
            }
        }
    }

    /// Raw camera writer path. The config uses name-based convention:
    /// any raw-h264 writer whose name contains "camera" consumes the
    /// camera source directly. This is minimal-ceremony by design —
    /// it keeps the test configs flat.
    ///
    /// Returns true if at least one writer was fed, so the metronome
    /// can account for the frame without double-counting.
    private func feedCameraWriters(_ camera: CVPixelBuffer, frameIndex: Int64, frameRate: Int) -> Bool {
        guard let sample = Self.makeSampleBuffer(from: camera,
                                                 index: frameIndex,
                                                 frameRate: frameRate) else { return false }
        var fedAny = false
        for w in writers where w.kind == "raw-h264" && w.name.lowercased().contains("camera") {
            w.appendVideo(sample)
            fedAny = true
        }
        return fedAny
    }

    private func feedAudioWriters(_ sample: CMSampleBuffer) {
        for w in writers where w.kind == "raw-audio" {
            w.appendAudio(sample)
        }
    }

    private static func makeSampleBuffer(from buffer: CVPixelBuffer,
                                         index: Int64,
                                         frameRate: Int) -> CMSampleBuffer? {
        let scale = CMTimeScale(frameRate * 100)
        let duration = CMTime(value: 100, timescale: scale)
        let pts = CMTime(value: index * 100, timescale: scale)

        var formatDescription: CMFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: buffer,
            formatDescriptionOut: &formatDescription
        )
        guard let fmt = formatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: buffer,
            formatDescription: fmt,
            sampleTiming: &timing,
            sampleBufferOut: &sample
        )
        return sample
    }

    // MARK: - Outcome

    private func computeOutcome() -> String {
        // Note: `writers` may be empty. T1.6 (compositor-alone) is a
        // deliberate example — the metronome ticks and the compositor
        // runs, but no writer consumes the composited output. That's
        // a valid configuration and should report "pass" as long as
        // nothing else went wrong. Don't add a "zero writers" guard
        // here; the loop below simply does nothing and we fall
        // through to the correct outcome.
        var hasFailure = false
        var hasSoftIssue = false

        for w in writers {
            switch w.finalStatus {
            case .completed:
                break
            case .failed, .cancelled:
                hasFailure = true
                runtimeIssues.append("\(w.name): status=\(w.finalStatus.rawValue) error=\(w.finalError?.localizedDescription ?? "nil")")
            default:
                hasSoftIssue = true
                runtimeIssues.append("\(w.name): ended with unexpected status \(w.finalStatus.rawValue)")
            }

            // HLS cadence check
            if w.kind == "composited-hls" {
                if let drift = cadenceDrift(durations: w.segmentDurations) {
                    if drift > 0.10 {
                        hasSoftIssue = true
                        runtimeIssues.append(
                            "\(w.name): segment cadence drift \(String(format: "%.1f%%", drift * 100)) > 10%"
                        )
                    }
                }
            }

            // Output sanity check
            if let bytes = w.bytesOnDisk, bytes == 0 {
                hasSoftIssue = true
                runtimeIssues.append("\(w.name): output file empty")
            }
        }

        if hasFailure { return "fail-recorded" }
        if hasSoftIssue { return "degraded" }
        return "pass"
    }

    /// Returns the max relative drift from the 4s target, ignoring the
    /// first segment (which always has priming variance).
    private func cadenceDrift(durations: [Double]) -> Double? {
        // Drop the init segment (always first, nonstandard length) AND
        // the tail segment (always last, short because the recording
        // ends mid-interval when duration isn't a multiple of the 4 s
        // target). What remains are the interior segments whose
        // durations actually signal cadence stability.
        let interior = durations.dropFirst().dropLast()
        guard !interior.isEmpty else { return nil }
        let target = 4.0
        let worst = interior.map { abs($0 - target) / target }.max() ?? 0
        return worst
    }

    private func buildSummary() -> String {
        let outputs = writers.compactMap { w -> String? in
            if let bytes = w.bytesOnDisk {
                let mb = Double(bytes) / (1024 * 1024)
                return "\(w.name)=\(String(format: "%.1fMB", mb))"
            }
            return nil
        }.joined(separator: " ")
        return "frames=\(framesSubmitted) dropped=\(framesDropped) outputs=[\(outputs)]"
    }

    // MARK: - Finalise

    private func finalise(outcome: String, summary: String) async -> HarnessResult {
        let finishedAt = Date()

        SystemSnapshot.capture(runDirectory: runDirectory, label: "end")

        watchdog.cancel()

        let writerResults = writers.map { w in
            WriterResult(
                name: w.name,
                kind: w.kind,
                status: statusString(w.finalStatus),
                errorDescription: w.finalError?.localizedDescription,
                outputPath: w.outputURL?.path,
                outputSizeBytes: w.bytesOnDisk,
                segmentDurations: w.segmentDurations
            )
        }

        let result = HarnessResult(
            outcome: outcome,
            summary: summary,
            startedAt: ISO8601DateFormatter().string(from: startDate),
            finishedAt: ISO8601DateFormatter().string(from: finishedAt),
            elapsedSeconds: finishedAt.timeIntervalSince(startDate),
            writers: writerResults,
            issues: runtimeIssues,
            frameStats: FrameStats(
                framesSubmitted: framesSubmitted,
                framesDropped: framesDropped,
                firstFrameAt: firstFrameAt,
                lastFrameAt: lastFrameAt
            ),
            config: config
        )

        events.log("run.finalise", [
            "outcome": outcome,
            "summary": summary,
        ])
        events.close()

        if let data = try? result.encoded() {
            try? data.write(to: runDirectory.appendingPathComponent("result.json"))
        }

        // Only clear the last-known-good marker on a non-killed outcome.
        // fail-killed never reaches this path (watchdog calls exit()),
        // so clearing here is always the right thing.
        InProgressMarker.clear(testRunsRoot: testRunsRoot)

        print("[harness] outcome=\(outcome) \(summary)")
        return result
    }

    private func statusString(_ status: AVAssetWriter.Status) -> String {
        switch status {
        case .unknown: return "unknown"
        case .writing: return "writing"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        @unknown default: return "unknown"
        }
    }
}

// MARK: - Errors

enum HarnessRunnerError: Error, LocalizedError {
    case unsupportedSource(String)
    case unsupportedWriter(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedSource(let k): return "unsupported source kind: \(k)"
        case .unsupportedWriter(let k): return "unsupported writer kind: \(k)"
        }
    }
}
