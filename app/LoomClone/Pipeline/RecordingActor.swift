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

    /// HAL-reported input latency for the selected mic, in seconds. Stored
    /// in `recording.json` for diagnostics; not applied as a PTS correction
    /// (AVFoundation partially compensates internally, so the full value
    /// overcorrects).
    var audioInputLatency: Double = 0

    /// Structured account of the recording — metadata + events + segments.
    /// Written to `recording.json` alongside the segments and uploaded to the
    /// server as part of the complete payload.
    var timeline = RecordingTimelineBuilder()

    /// First-audio-sample flag and the parked waiter `waitForFirstAudio`
    /// installs. `markAudioArrived` (+Prepare) sets the flag and resumes
    /// the continuation once (single-shot, nilled after resume).
    var audioHasArrived = false
    var audioReadyContinuation: CheckedContinuation<Void, Never>?

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
    /// across pause/resume edge cases (which AVAssetWriter rejects). Post
    /// task-21 this is a safety net — the source-PTS freshness check below
    /// is the primary defence; this only fires on real bugs.
    var lastEmittedVideoPTS: CMTime = .invalid

    /// Last source-capture PTS that produced a successful emit. Tracked in
    /// the source-capture clock domain (NOT the encoder/priming-offset
    /// domain that `lastEmittedVideoPTS` lives in) so the
    /// `compositeForCurrentMode` freshness check can compare directly
    /// against incoming frames' `capturePTS`. Bumped on every real emit;
    /// keep-alive emits intentionally do not update it (so a fresh frame
    /// arriving after a static period still passes the check).
    var lastEmittedSourcePTS: CMTime = .invalid

    /// Host clock at the last successful emit — real or keep-alive. Used
    /// by `tryEmitKeepAlive` to decide whether enough wall-clock time has
    /// elapsed since the last frame to warrant a keep-alive emit (default
    /// threshold: 1s, see `keepAliveThresholdSeconds`).
    var lastEmitHostTime: CMTime = .invalid

    /// Phase 3 debounce: when a keep-alive fires during a static-source
    /// run, we emit one `keepalive.emitted` timeline event for the run.
    /// Cleared when a real (fresh-source) emit happens, so the next
    /// static run starts a new event.
    var keepAliveEventFiredForCurrentStaleRun: Bool = false

    /// How long the source must have been static before a keep-alive emit
    /// fires. Picked at 1s as a balance: much greater than the metronome
    /// tick interval (so we don't constantly re-emit duplicates), much
    /// less than AVAssetWriter's 4s segment interval (so segments never
    /// see >4s of dead air and start producing empty / zero-duration
    /// segments).
    static let keepAliveThresholdSeconds: Double = 1.0

    /// Cap on per-recording `monotonicity.rejected` timeline events.
    /// Post task-21 the encoder-level safety net should never fire on
    /// the happy path — but if a regression makes it fire continuously,
    /// `recording.json` would balloon with one event per rejected tick.
    /// First N fire normally; the (N+1)th fires a single
    /// `monotonicity.rejected.suppressed` sentinel; subsequent fires
    /// only update the aggregate counter + histogram (which are the
    /// authoritative totals anyway).
    static let monoRejectEventCap: Int64 = 32

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
    /// - `cameraOnly`: the metronome pops one frame per emit. Output rate
    ///   tracks the camera's actual delivery rate — if the metronome ticks
    ///   faster than the camera delivers, empty ticks become no-ops and
    ///   the encoder receives frames at the camera's native cadence.
    /// - `screenAndCamera`: the metronome peeks the most recent frame as
    ///   the PiP backdrop without popping; older entries age out via the
    ///   capacity cap.
    /// - `screenOnly`: queue unused.
    var cameraFrameQueue: [CachedFrame] = []
    static let cameraFrameQueueCapacity = 8

    /// Most recently popped camera frame from the FIFO. Retained for the
    /// keep-alive path (Phase 3) — when a `cameraOnly` recording goes
    /// >1s with no fresh camera frame (e.g. user covers the lens), the
    /// metronome emits a synthetic-PTS repeat of this frame so the HLS
    /// segment cutter doesn't see dead air.
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

    // MARK: - Diagnostics

    /// Aggregate counters, histograms, and per-tick / per-frame trace
    /// ring-buffers for this recording. Mutated on the hot path; dumped to
    /// `diagnostics.json` at stop. See `RecordingActor+Diagnostics.swift`.
    var diagnostics = MetronomeDiagnostics()

    /// Last camera capturePTS seen — used to compute camera frame intervals
    /// without scanning the trace buffer.
    var lastCameraCapturePTS: CMTime = .invalid
    /// Last screen capturePTS seen — same purpose for screen frames.
    var lastScreenCapturePTS: CMTime = .invalid
    /// Last successful emit PTS (logical seconds since start, stripped of
    /// priming offset). Used to bucket the inter-emit cadence histogram.
    var lastEmitLogicalSeconds: Double = -1
    /// Wall-clock anchor for periodic snapshots — fires roughly every 2s.
    var lastPeriodicSnapshotS: Double = -1

    // The stop and cancel flows live in `RecordingActor+Stop.swift`.

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
        // would walk through pause-period frames one tick at a time
        // (discarded by the freshness check below) before reaching fresh
        // post-resume content. screenAndCamera peeks the latest frame so
        // it's less affected, but draining keeps semantics consistent.
        cameraFrameQueue.removeAll(keepingCapacity: true)

        // Bump the source-PTS watermark forward to `now` so any frame
        // captured during the pause window — `latestScreenFrame` will
        // typically have been overwritten by an SCK update mid-pause — is
        // treated as stale by `compositeForCurrentMode`. Without this, a
        // mid-pause screen frame would pass the freshness check (its
        // capturePTS is newer than the pre-pause emit's), then compute
        // an encoder PTS below `lastEmittedVideoPTS` and trip the
        // monotonicity safety net.
        //
        // The invalid-skip on both bumps below is deliberate: if either
        // watermark is `.invalid`, no real emit has happened yet, so
        // `isStaleSource` already returns false and `tryEmitKeepAlive`
        // already short-circuits — nothing here to fix. We never
        // initialise watermarks from a pause path; that's the first real
        // emit's job.
        if lastEmittedSourcePTS.isValid {
            lastEmittedSourcePTS = max(lastEmittedSourcePTS, now)
        }

        // Restart the keep-alive threshold from resume — long pauses
        // would otherwise look like a static run to `tryEmitKeepAlive`
        // and fire a synthetic frame on the first post-resume tick.
        if lastEmitHostTime.isValid {
            lastEmitHostTime = now
        }
        keepAliveEventFiredForCurrentStaleRun = false

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

    /// Variant of `logicalElapsedSeconds()` that freezes at the moment the
    /// current pause started, so events triggered *during* a pause land on
    /// the timeline at the user-visible (paused) clock time rather than
    /// advancing past it. Falls back to live elapsed when not paused.
    func userVisibleElapsedSeconds() -> Double {
        guard let start = recordingStartTime else { return 0 }
        let when = pauseStartHostTime ?? CMClockGetTime(CMClockGetHostTimeClock())
        return ((when - start) - pauseAccumulator).seconds
    }

    /// Append an anonymous chapter marker to the timeline at the current
    /// logical time (or the frozen pause time if currently paused). The
    /// UUID is generated here so the server can match server-side chapter
    /// records back to the originating press for later AI title updates.
    /// No-op before commit.
    @discardableResult
    func addChapterMarker() -> String? {
        guard recordingStartTime != nil else { return nil }
        let id = UUID().uuidString.lowercased()
        timeline.recordChapterMarker(id: id, t: userVisibleElapsedSeconds())
        return id
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
        // Use logicalElapsedSeconds (CMClock-based, pause-aware) rather than
        // timeline.now() (Date-based). Both anchors are set within
        // microseconds of each other, but using the CMClock derivative keeps
        // every recording event on the same clock domain as segment PTS.
        timeline.recordModeSwitch(from: previous, to: newMode, t: logicalElapsedSeconds())
        Log.recording.log("Mode switched to: \(newMode)")
    }

    func switchPipPosition(to newPosition: PipPosition) {
        let previous = pipPosition
        guard newPosition != previous else { return }
        pipPosition = newPosition
        if isRecording {
            timeline.recordPipPositionChanged(from: previous, to: newPosition, t: logicalElapsedSeconds())
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
