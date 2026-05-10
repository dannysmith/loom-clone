import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// Coordinates the full recording pipeline: capture → composite → encode → upload.
actor RecordingActor {
    // MARK: - Capture Sources

    let screenCapture = ScreenCaptureManager()
    let cameraCapture = CameraCaptureManager()
    let micCapture = MicrophoneCaptureManager()

    // MARK: - Pipeline

    let composition = CompositionActor()
    let writer = WriterActor()
    let upload = UploadActor()

    // MARK: - Raw Stream Writers

    //
    // High-quality master files written locally alongside the composited HLS
    // segments. Created in `prepareRecording` for whichever sources the user
    // has selected. Each writer consumes its source's frames at native rate
    // (not metronome-paced) and writes to its own MP4 / M4A.

    var screenRawWriter: RawStreamWriter?
    var cameraRawWriter: RawStreamWriter?
    var audioRawWriter: RawStreamWriter?

    /// Captured at prepare time so we can populate the timeline `rawStreams`
    /// block after `finish()`. Avoids re-resolving devices at stop time.
    /// Screen has no bitrate field — the raw screen writer uses ProRes
    /// 422 Proxy, which is roughly CBR-per-frame and has no target-bitrate
    /// setting. The observed average is computed from final bytes on disk
    /// ÷ logical duration at timeline-population time.
    var rawScreenDims: (width: Int, height: Int)?
    var rawCameraDims: (width: Int, height: Int, bitrate: Int)?
    var rawAudioConfig: (bitrate: Int, sampleRate: Int, channels: Int)?

    // MARK: - State

    var mode: RecordingMode = .screenAndCamera
    var pipPosition: PipPosition = .bottomRight
    var preset: OutputPreset = .default
    var isRecording = false
    /// Set true in the stop flow before `cancelMetronome()`. When true,
    /// `handleCompositionFailure` skips the rebuild + timeout — the context
    /// is about to be torn down anyway.
    var isStopping = false
    var localSavePath: URL?
    /// Tracks which raw writers have already had a mid-recording failure
    /// reported to the timeline, to avoid duplicate events.
    var rawWriterFailureReported: Set<String> = []

    // MARK: - App Exclusion

    /// Bundle IDs the user selected for exclusion. Stored so the health check
    /// can detect when the focused window belongs to a hidden app, and so
    /// mid-recording filter updates can re-resolve the full set.
    var excludedBundleIDs: Set<String> = []

    /// Whether Finder's desktop icon windows are excluded.
    var hideDesktopIcons: Bool = false

    /// Tracks the bundle ID of the last hidden app we warned about, so we
    /// can update the warning message when focus moves between hidden apps.
    var lastFocusedHiddenBundleID: String?

    /// Counter for the health check timer. Used to throttle periodic filter
    /// refreshes (Finder browser window re-enumeration) to every ~5 seconds.
    var filterRefreshCounter: Int = 0

    // MARK: - Source Health Tracking

    /// Host-clock seconds when the last frame/sample was received from each source.
    /// Updated by the frame handlers, read by the health check on each metronome tick.
    var lastScreenFrameHostTime: Double?
    var lastCameraFrameHostTime: Double?
    var lastAudioSampleHostTime: Double?

    /// Which source health warnings are currently active. Used for dedup — a
    /// warning fires once, clears if the source recovers, then can re-fire.
    var activeSourceWarnings: Set<RecordingWarning.Kind> = []

    /// Callback to notify the coordinator of warning changes. The Bool is true
    /// for add, false for remove.
    var onWarningChanged: (@Sendable (RecordingWarning, Bool) async -> Void)?

    func setWarningCallback(_ callback: @escaping @Sendable (RecordingWarning, Bool) async -> Void) {
        onWarningChanged = callback
    }

    /// True when the camera's AVCaptureSession includes the mic, so audio
    /// samples from the shared session feed the HLS writer (instead of the
    /// standalone mic). Set during `startCaptureSources` based on whether
    /// CameraCaptureManager successfully added the mic to its session.
    var sharedSessionAudioActive = false

    /// HAL-reported input latency for the selected mic, in seconds. Queried
    /// once during `prepareRecording` and stored in `recording.json` for
    /// diagnostics. Not applied as a PTS correction — testing showed that
    /// AVFoundation already partially compensates for HAL latency internally,
    /// so subtracting the full value overcorrects.
    var audioInputLatency: Double = 0

    /// Structured account of the recording — metadata + events + segments.
    /// Written to `recording.json` alongside the segments and uploaded to the
    /// server as part of the complete payload.
    var timeline = RecordingTimelineBuilder()

    /// Set when the first audio sample arrives from the mic.
    /// Used to ensure audio hardware is active before starting the writer,
    /// so the init segment includes both video and audio tracks.
    var audioHasArrived = false

    /// Resumed once when the first audio sample arrives. `waitForFirstAudio`
    /// installs this from prepare; the audio handler resumes it on receipt.
    /// Single-shot — nilled out after resume.
    var audioReadyContinuation: CheckedContinuation<Void, Never>?

    /// Called from audio handlers on every sample. Sets the boolean flag and
    /// resumes a parked `waitForFirstAudio` waiter on the first sample.
    func markAudioArrived() {
        let firstSample = !audioHasArrived
        audioHasArrived = true
        if firstSample, let continuation = audioReadyContinuation {
            audioReadyContinuation = nil
            continuation.resume()
        }
    }

    // MARK: - Overlay Frame Callback

    /// Set by the coordinator to receive raw camera sample buffers for the
    /// on-screen overlay window. Fired directly from the camera capture queue
    /// (BEFORE entering this actor) so the overlay isn't blocked by metronome
    /// scheduling. Stored as a nonisolated property so the camera capture
    /// callback can read it without an actor hop.
    nonisolated(unsafe) var onCameraSampleForOverlay: (@Sendable (CMSampleBuffer) -> Void)?

    func setOverlayCallback(_ callback: @escaping @Sendable (CMSampleBuffer) -> Void) {
        onCameraSampleForOverlay = callback
    }

    // MARK: - Terminal Error Callback

    //
    // Fired when the compositor reports a render failure that rebuild can't
    // recover from. The coordinator uses this to surface a user-visible alert
    // and trigger a clean stop flow from outside the actor. Not a normal event
    // on the recording timeline — we only ever fire this at most once per
    // recording, and only on the unhappy path.

    var onTerminalError: (@Sendable (String) async -> Void)?

    /// Set by the coordinator before `commitRecording`. When invoked the
    /// coordinator should tear down the recording via `stopRecording()` and
    /// show the provided message to the user.
    func setTerminalErrorCallback(_ callback: @escaping @Sendable (String) async -> Void) {
        onTerminalError = callback
    }

    /// Guard so we only fire the terminal-error callback once per recording,
    /// even if multiple metronome ticks observe the same failure before the
    /// stop flow lands.
    var terminalErrorFired = false

    /// Forward the shared camera-adjustments box into the compositor so its
    /// camera-frame path picks up slider moves on the next tick. Called once
    /// during `startRecording` — the box is reference-typed so mutations flow
    /// through without needing to re-invoke this.
    func setCameraAdjustmentsState(_ state: CameraAdjustmentsState) async {
        await composition.setCameraAdjustmentsState(state)
    }

    // MARK: - The Recording Clock

    //
    // There is exactly one clock that anchors the recording timeline:
    // `recordingStartTime`. It is set in `commitRecording()` after every
    // capture source is confirmed running, just before the writer starts.
    //
    // Both audio and video derive their PTS from the same formula:
    //   PTS = primingOffset + (sampleHostTime - recordingStartTime) - pauseAccumulator
    //
    // Audio uses each sample's own host-clock PTS. Video (from the metronome)
    // uses the capture PTS of the cached source frame it composites. Both
    // therefore stamp content at the moment it hit the hardware, which keeps
    // audio and video aligned regardless of capture pipeline latency.

    /// Host clock time at which `frameIdx = 0` on the recording timeline.
    /// nil until `commitRecording()` runs.
    var recordingStartTime: CMTime?

    /// Total wall-clock time spent paused. Subtracted from elapsed wall time
    /// for both audio and video, so the recording timeline is continuous
    /// across pauses. Updated by pause/resume.
    var pauseAccumulator: CMTime = .zero

    /// Host clock time when the current pause started. Used by `resume()`.
    var pauseStartHostTime: CMTime?

    /// Strictly-monotonic guard for video PTS. Prevents same-PTS appends
    /// across pause/resume edge cases (which AVAssetWriter rejects).
    var lastEmittedVideoPTS: CMTime = .invalid

    // MARK: - Frame Cache

    /// A cached source frame with the sample buffer's original presentation
    /// timestamp preserved. The metronome stamps composited frames with
    /// `capturePTS` so the emitted video PTS reflects when the visible
    /// content was actually captured — not when the metronome happened to
    /// emit. This keeps video aligned with audio (whose PTS is likewise the
    /// hardware capture time).
    struct CachedFrame {
        let pixelBuffer: CVPixelBuffer
        let capturePTS: CMTime
    }

    /// Latest valid screen frame received from ScreenCaptureKit.
    /// The metronome reads this on every tick — so an idle screen produces
    /// correctly-encoded static frames at the configured rate instead of gaps.
    var latestScreenFrame: CachedFrame?

    /// Bounded FIFO of camera frames. A single-slot cache previously lost
    /// frames whenever the camera delivered faster than the metronome
    /// consumed (measured: ~25% of frames dropped on a 30fps camera). The
    /// queue lets bursts wait instead of being overwritten. Drop-oldest
    /// keeps memory bounded if the metronome stalls.
    ///
    /// - `cameraOnly`: the metronome pops one frame per emit, so every
    ///   captured frame lands in the output in order. When the target fps
    ///   exceeds the camera's delivery rate (e.g. 60fps metronome with a
    ///   30fps camera), the most-recently-popped frame is re-emitted on
    ///   empty ticks — see `lastPoppedCameraFrame`.
    /// - `screenAndCamera`: the metronome peeks the most recent frame as
    ///   the PiP backdrop without popping; older entries age out via the
    ///   capacity cap.
    /// - `screenOnly`: queue unused.
    var cameraFrameQueue: [CachedFrame] = []
    static let cameraFrameQueueCapacity = 8

    /// Most recently popped camera frame from the FIFO. Used for the
    /// peek-with-repeat policy in `cameraOnly` mode when the metronome
    /// ticks faster than the camera delivers (e.g. 60fps target with a
    /// 30fps camera). Re-emitting this frame on empty ticks fills the
    /// timeline with repeated frames that compress to nearly nothing
    /// in H.264, while preserving the guarantee that every original
    /// camera frame reaches the output exactly once.
    var lastPoppedCameraFrame: CachedFrame?

    // MARK: - Metronome

    /// Target frame rate for the output video timeline, set at recording
    /// start from the user's FrameRate selection. The encoder's keyframe
    /// interval (2s) and segment interval (4s) are duration-based and
    /// fps-agnostic.
    var targetFrameRate: Int32 = FrameRate.thirtyFPS.rawValue
    var frameDuration: CMTime {
        CMTime(value: 1, timescale: targetFrameRate)
    }

    /// Drives the encoding cadence. Emits a composited frame every
    /// `frameDuration` regardless of how fast the underlying sources
    /// are delivering.
    var metronomeTask: Task<Void, Never>?

    /// Separate timer for source health checks. Runs at ~2Hz — far slower
    /// than the metronome — and is completely decoupled from the encode
    /// cadence so it can never introduce timing jitter.
    var healthCheckTask: Task<Void, Never>?

    /// Tick counter used only for drift-corrected sleep scheduling. The
    /// encoder PTS comes from wall clock at emit time, not from this counter.
    /// Resets to 0 when the metronome (re)starts after pause.
    var metronomeTickIdx: Int64 = 0

    // MARK: - Stop

    /// What the stop flow hands back to the coordinator. `url` drives the
    /// clipboard copy; the rest lets HealAgent pick up any segments the
    /// server didn't have at stop time without blocking the foreground flow.
    struct StopResult {
        let url: String
        let videoId: String
        let slug: String
        let title: String?
        let visibility: String
        let localDir: URL
        let timelineData: Data
        let missing: [String]
    }

    /// Finish results for the three raw writers, collected in parallel.
    struct RawFinishResults {
        var screen: RawStreamWriter.FinishResult?
        var camera: RawStreamWriter.FinishResult?
        var audio: RawStreamWriter.FinishResult?
    }

    /// Stop a committed recording. Cancels the metronome, stops captures,
    /// finishes the writer, completes the upload session.
    func stopRecording() async -> StopResult? {
        isRecording = false
        isStopping = true

        // Finalise the timeline BEFORE finishing the writer so the stop event
        // is timestamped at the user-visible stop moment, not after the
        // (potentially slow) finishWriting completion.
        let logicalDuration = logicalElapsedSeconds()
        timeline.markStopped(logicalDuration: logicalDuration)

        // Stop the metronome first so no more frames get appended
        Log.recording.log("Stopping metronome...")
        await cancelMetronome()
        Log.recording.log("Metronome stopped")

        // Stop captures (each await waits for stopRunning() to actually return)
        Log.recording.log("Stopping captures...")
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        Log.recording.log("Captures stopped")

        // Kick off raw writer finishes in the background, in parallel with
        // the composited writer's finish flow. Each raw writer is independent
        // — finalising one doesn't block the others. We await them all
        // together below before snapshotting the timeline.
        let screenW = screenRawWriter
        let cameraW = cameraRawWriter
        let audioW = audioRawWriter

        let rawFinishTask = Task { [screenW, cameraW, audioW] in
            await withTaskGroup(of: (String, RawStreamWriter.FinishResult).self) { group -> RawFinishResults in
                if let w = screenW { group.addTask { await ("screen", w.finish()) } }
                if let w = cameraW { group.addTask { await ("camera", w.finish()) } }
                if let w = audioW { group.addTask { await ("audio", w.finish()) } }
                var results = RawFinishResults()
                for await (key, result) in group {
                    switch key {
                    case "screen": results.screen = result
                    case "camera": results.camera = result
                    case "audio": results.audio = result
                    default: break
                    }
                }
                return results
            }
        }

        // Finish writer. Blocks until every trailing segment has been fully
        // processed by the writer's consumer — i.e. recorded in the timeline
        // and enqueued for upload. After this line, no more segments can
        // appear from the encoder.
        Log.recording.log("Finishing composited writer...")
        await writer.finish()
        Log.recording.log("Composited writer done")

        // Drain the upload queue, but only up to a grace window. With Phase 3's
        // unbounded retry policy, waiting forever here would hang the stop flow
        // for the entire duration of a network outage. After the window,
        // anything still pending is left on local disk and Phase 2's healing
        // reconciles it silently in the background.
        await upload.drainQueue(timeoutSeconds: 10)

        // Wait for raw writers to finish flushing. They've been running in
        // parallel with the composited finish; this is the join point.
        let rawResults = await rawFinishTask.value

        // Record timeline events for any raw writer that failed.
        recordRawWriterFailures(rawResults)

        finalizeRawWriterMetadata(logicalDuration: logicalDuration, rawResults: rawResults)

        // NOW the builder is fully up-to-date: all segments, all pauses,
        // all mode switches, all upload results. Snapshot it.
        let builtTimeline = timeline.build()
        let timelineData = encodeTimeline(builtTimeline)

        if let localDir = localSavePath, let data = timelineData {
            let path = localDir.appendingPathComponent("recording.json")
            do {
                try data.write(to: path)
            } catch {
                Log.recording.log("Failed to write local timeline: \(error)")
            }
        }

        // Complete upload (includes the timeline in the payload)
        do {
            let result = try await upload.complete(timeline: timelineData)
            Log.recording.log("Stopped, URL: \(result.url) (missing=\(result.missing.count))")
            guard let videoId = await upload.videoId,
                  let localDir = localSavePath
            else {
                // No way to schedule healing without these — still return the URL.
                return StopResult(
                    url: result.url,
                    videoId: "",
                    slug: result.slug,
                    title: result.title,
                    visibility: result.visibility,
                    localDir: URL(fileURLWithPath: "/"),
                    timelineData: timelineData ?? Data(),
                    missing: []
                )
            }
            return StopResult(
                url: result.url,
                videoId: videoId,
                slug: result.slug,
                title: result.title,
                visibility: result.visibility,
                localDir: localDir,
                timelineData: timelineData ?? Data(),
                missing: result.missing
            )
        } catch {
            Log.recording.log("Complete failed: \(error)")
            return nil
        }
    }

    /// Emit a `raw.writer.failed` timeline event for each raw writer that
    /// entered `.failed` state during the recording.
    private func recordRawWriterFailures(_ results: RawFinishResults) {
        let t = timeline.now()
        if case let .failed(error) = results.screen {
            timeline.recordRawWriterFailed(file: "screen.mov", error: error, t: t)
        }
        if case let .failed(error) = results.camera {
            timeline.recordRawWriterFailed(file: "camera.mp4", error: error, t: t)
        }
        if case let .failed(error) = results.audio {
            timeline.recordRawWriterFailed(file: "audio.m4a", error: error, t: t)
        }
    }

    /// Populate timeline raw stream metadata from the finished writers, then
    /// nil them out. Called once at the end of `stopRecording` after all raw
    /// writers have flushed.
    private func finalizeRawWriterMetadata(logicalDuration: Double, rawResults: RawFinishResults) {
        if let dims = rawScreenDims, let w = screenRawWriter {
            // ProRes is roughly CBR-per-frame with no target-bitrate setting,
            // so compute the observed average from actual bytes ÷ logical
            // duration rather than parroting a fictitious target. Guard
            // against tiny durations to avoid division blowups on a recording
            // that stopped almost immediately.
            let bytes = w.bytesOnDisk() ?? 0
            let observedBitrate = logicalDuration > 0.1
                ? Int(Double(bytes) * 8.0 / logicalDuration)
                : 0
            let screenFailed = if case .failed = rawResults.screen { true } else { false }
            timeline.setRawScreen(
                filename: w.url.lastPathComponent,
                width: dims.width,
                height: dims.height,
                codec: "prores422proxy",
                bitrate: observedBitrate,
                bytes: bytes,
                failed: screenFailed
            )
        }
        if let dims = rawCameraDims, let w = cameraRawWriter {
            let cameraFailed = if case .failed = rawResults.camera { true } else { false }
            timeline.setRawCamera(
                filename: w.url.lastPathComponent,
                width: dims.width,
                height: dims.height,
                codec: "h264",
                bitrate: dims.bitrate,
                bytes: w.bytesOnDisk() ?? 0,
                failed: cameraFailed
            )
        }
        if let cfg = rawAudioConfig, let w = audioRawWriter {
            let audioFailed = if case .failed = rawResults.audio { true } else { false }
            timeline.setRawAudio(
                filename: w.url.lastPathComponent,
                codec: "aac-lc",
                bitrate: cfg.bitrate,
                sampleRate: cfg.sampleRate,
                channels: cfg.channels,
                bytes: w.bytesOnDisk() ?? 0,
                failed: audioFailed
            )
        }
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil
    }

    /// Check each raw writer for mid-recording failure and emit a timeline
    /// event the first time one is detected. Called at each segment boundary.
    private func checkRawWriterStatus() async {
        let t = logicalElapsedSeconds()
        if let w = screenRawWriter, await w.hasFailed, !rawWriterFailureReported.contains("screen") {
            rawWriterFailureReported.insert("screen")
            timeline.recordRawWriterFailed(file: "screen.mov", error: "detected at segment boundary", t: t)
        }
        if let w = cameraRawWriter, await w.hasFailed, !rawWriterFailureReported.contains("camera") {
            rawWriterFailureReported.insert("camera")
            timeline.recordRawWriterFailed(file: "camera.mp4", error: "detected at segment boundary", t: t)
        }
        if let w = audioRawWriter, await w.hasFailed, !rawWriterFailureReported.contains("audio") {
            rawWriterFailureReported.insert("audio")
            timeline.recordRawWriterFailed(file: "audio.m4a", error: "detected at segment boundary", t: t)
        }
    }

    private func encodeTimeline(_ timeline: RecordingTimeline) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            return try encoder.encode(timeline)
        } catch {
            Log.recording.log("Failed to encode timeline: \(error)")
            return nil
        }
    }

    /// Cancel a committed recording. Tears down the pipeline like stop(),
    /// but discards the result: tells the server to delete the video and
    /// removes the local safety-net copy.
    func cancelRecording() async {
        isRecording = false
        // Mirror `stopRecording`: composition failures during teardown should
        // short-circuit recovery (no point in a 2s GPU rebuild when we're
        // about to discard the output anyway).
        isStopping = true

        await cancelMetronome()
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        await writer.finish()

        // Finalise raw writers so their AVAssetWriters release cleanly
        // before the local dir is removed below. The files themselves are
        // about to be deleted along with the rest of the session dir.
        await screenRawWriter?.finish()
        await cameraRawWriter?.finish()
        await audioRawWriter?.finish()
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil

        await upload.cancel()

        if let localDir = localSavePath {
            try? FileManager.default.removeItem(at: localDir)
        }
        localSavePath = nil

        Log.recording.log("Cancelled")
    }

    /// Cancel during prepare/countdown — captures may be running but the
    /// writer was never started. Tear down without trying to finalise.
    func cancelPreparation() async {
        isRecording = false
        await cancelMetronome()
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        await writer.finish() // no-op when hasStartedSession == false

        // Same for raw writers — they were configured but never started.
        // RawStreamWriter.finish() handles the unstarted case by removing
        // the empty file and bailing.
        await screenRawWriter?.finish()
        await cameraRawWriter?.finish()
        await audioRawWriter?.finish()
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil

        Log.recording.log("Preparation cancelled")
    }

    // MARK: - Pause / Resume

    func pause() async {
        await cancelMetronome()
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        pauseStartHostTime = now

        timeline.recordPaused(t: logicalElapsedSeconds())

        // The writer flips an internal `isPaused` flag for defence-in-depth;
        // all PTS math now lives on the actor (single pauseAccumulator), so
        // the writer is a pure sink.
        await writer.pause(at: now)
    }

    func resume() async {
        let now = CMClockGetTime(CMClockGetHostTimeClock())

        // Add the pause duration to our accumulator so subsequent video frames
        // continue from the same logical time as the last pre-pause frame.
        var pauseSeconds: Double = 0
        if let pauseStart = pauseStartHostTime {
            let pauseDuration = now - pauseStart
            pauseAccumulator = pauseAccumulator + pauseDuration // swiftlint:disable:this shorthand_operator
            pauseSeconds = pauseDuration.seconds
        }
        pauseStartHostTime = nil

        // Drop any camera frames that arrived during the pause. In cameraOnly
        // the metronome pops the *oldest* queued frame; without this drain it
        // would pop frames whose capturePTS predates the resume moment, and
        // their elapsedLogical = (capturePTS - start) - pauseAccumulator
        // works out to ~queue-depth × frame-interval *before* the last
        // pre-pause emitted PTS — the strict-monotonic guard then rejects
        // them silently. screenAndCamera peeks the latest frame so it's
        // less affected, but draining keeps semantics consistent.
        cameraFrameQueue.removeAll(keepingCapacity: true)

        timeline.recordResumed(t: logicalElapsedSeconds(), pauseDuration: pauseSeconds)

        await writer.resume(at: now)
        startMetronome()
    }

    /// Logical recording time in seconds (wall elapsed minus time spent paused).
    /// Returns 0 before commit. Used for timeline event timestamps so events on
    /// the timeline line up with segment PTS values.
    func logicalElapsedSeconds() -> Double {
        guard let start = recordingStartTime else { return 0 }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        return ((now - start) - pauseAccumulator).seconds
    }

    /// Called from the upload actor callback to fold upload results into the
    /// timeline. `t` is captured at the moment the callback fires.
    func recordUploadResult(filename: String, success: Bool, error: String?) {
        timeline.recordUploadResult(
            filename: filename,
            success: success,
            error: error,
            t: logicalElapsedSeconds()
        )
    }

    // MARK: - Mode Switch

    func switchMode(to newMode: RecordingMode) {
        let previous = mode
        mode = newMode
        timeline.recordModeSwitch(from: previous, to: newMode, t: timeline.now())
        Log.recording.log("Mode switched to: \(newMode)")
    }

    func switchPipPosition(to newPosition: PipPosition) {
        let previous = pipPosition
        guard newPosition != previous else { return }
        pipPosition = newPosition
        if isRecording {
            timeline.recordPipPositionChanged(from: previous, to: newPosition, t: timeline.now())
        }
        Log.recording.log("PiP position switched to: \(newPosition)")
    }

    // MARK: - App Exclusion Updates

    /// Re-resolve excluded apps from SCShareableContent and update the live
    /// stream filter. Called when an excluded app launches mid-recording, or
    /// periodically to refresh Finder browser window exceptions.
    func updateExcludedApps() async {
        guard modeUsesScreen else { return }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            Log.exclusion.log("SCShareableContent query failed: \(error)")
            return
        }

        var appsToExclude: [SCRunningApplication] = []

        // Always exclude our own app
        if let ourApp = content.applications.first(where: {
            $0.processID == ProcessInfo.processInfo.processIdentifier
        }) {
            appsToExclude.append(ourApp)
        }

        // User-selected apps
        for app in content.applications where excludedBundleIDs.contains(app.bundleIdentifier) {
            appsToExclude.append(app)
        }

        var exceptingWindows: [SCWindow] = []

        // Desktop icons: exclude Finder, but re-include its browser windows
        if hideDesktopIcons {
            if let finder = content.applications.first(where: { $0.bundleIdentifier == "com.apple.finder" }) {
                if !appsToExclude.contains(where: { $0.processID == finder.processID }) {
                    appsToExclude.append(finder)
                }
                // Re-include Finder windows at normal window level (browser windows).
                // Desktop icon windows are at kCGDesktopIconWindowLevel and stay excluded.
                exceptingWindows = content.windows.filter {
                    $0.owningApplication?.processID == finder.processID && $0.windowLayer == 0
                }
            }
        }

        do {
            try await screenCapture.updateFilter(
                excludingApps: appsToExclude,
                exceptingWindows: exceptingWindows
            )
        } catch {
            Log.exclusion.log("Filter update failed: \(error)")
        }
    }

    // MARK: - Segment Handling

    func handleSegment(_ emission: WriterActor.Emission) async {
        // Record in the timeline before uploading so the emit event is
        // definitely ordered before any upload result event.
        if emission.type == .media {
            timeline.recordSegment(
                index: emission.index,
                filename: emission.filename,
                bytes: emission.data.count,
                duration: emission.duration,
                emittedAt: logicalElapsedSeconds()
            )

            // Probe raw writers for mid-recording failures. This surfaces the
            // failure in the timeline at the first segment boundary after it
            // occurs, rather than waiting until finish().
            await checkRawWriterStatus()

            // Check HLS writer health. Unlike raw writer failures (which are
            // recoverable), an HLS writer failure is terminal.
            await checkHLSWriterHealth()
        }

        // Write to local disk FIRST — the upload path reads bytes from this
        // file on every attempt, so the file must exist before enqueuing.
        // The local copy is also the safety net that Phase 2 healing relies on.
        guard let localDir = localSavePath else {
            Log.recording.log("No local dir, dropping segment \(emission.filename)")
            return
        }
        let filePath = localDir.appendingPathComponent(emission.filename)
        do {
            try emission.data.write(to: filePath)
        } catch {
            Log.recording.log("Failed to save local segment \(emission.filename): \(error)")
            return
        }

        let segment = VideoSegment(
            index: emission.index,
            filename: emission.filename,
            localURL: filePath,
            duration: emission.duration,
            type: emission.type
        )
        await upload.enqueue(segment)
    }

    // MARK: - Helpers

    func createSampleBuffer(
        from pixelBuffer: CVPixelBuffer,
        pts: CMTime,
        duration: CMTime
    ) -> CMSampleBuffer? {
        var formatDescription: CMFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard let formatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )

        var sampleBuffer: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDescription,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )

        return sampleBuffer
    }
}

// MARK: - WriterActor Extension for Callback

extension WriterActor {
    func setOnSegmentReady(_ handler: @escaping @Sendable (Emission) async -> Void) {
        onSegmentReady = handler
    }
}
