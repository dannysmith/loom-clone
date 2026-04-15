import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// Coordinates the full recording pipeline: capture → composite → encode → upload.
actor RecordingActor {

    // MARK: - Capture Sources

    private let screenCapture = ScreenCaptureManager()
    private let cameraCapture = CameraCaptureManager()
    private let micCapture = MicrophoneCaptureManager()

    // MARK: - Pipeline

    private let composition = CompositionActor()
    private let writer = WriterActor()
    private let upload = UploadActor()

    // MARK: - Raw Stream Writers
    //
    // High-quality master files written locally alongside the composited HLS
    // segments. Created in `prepareRecording` for whichever sources the user
    // has selected. Each writer consumes its source's frames at native rate
    // (not metronome-paced) and writes to its own MP4 / M4A.

    private var screenRawWriter: RawStreamWriter?
    private var cameraRawWriter: RawStreamWriter?
    private var audioRawWriter: RawStreamWriter?

    /// Captured at prepare time so we can populate the timeline `rawStreams`
    /// block after `finish()`. Avoids re-resolving devices at stop time.
    /// Screen has no bitrate field — the raw screen writer uses ProRes
    /// 422 Proxy (task-0A Phase 2), which is roughly CBR-per-frame and has
    /// no target-bitrate setting. The observed average is computed from
    /// final bytes on disk ÷ logical duration at timeline-population time.
    private var rawScreenDims: (width: Int, height: Int)?
    private var rawCameraDims: (width: Int, height: Int, bitrate: Int)?
    private var rawAudioConfig: (bitrate: Int, sampleRate: Int, channels: Int)?

    // MARK: - State

    private var mode: RecordingMode = .screenAndCamera
    private var preset: OutputPreset = .default
    private var isRecording = false
    private var localSavePath: URL?

    /// Structured account of the recording — metadata + events + segments.
    /// Written to `recording.json` alongside the segments and uploaded to the
    /// server as part of the complete payload.
    private var timeline = RecordingTimelineBuilder()

    /// Set when the first audio sample arrives from the mic.
    /// Used to ensure audio hardware is active before starting the writer,
    /// so the init segment includes both video and audio tracks.
    private var audioHasArrived = false

    // MARK: - Overlay Frame Callback

    /// Set by the coordinator to receive raw camera sample buffers for the
    /// on-screen overlay window. Fired directly from the camera capture queue
    /// (BEFORE entering this actor) so the overlay isn't blocked by metronome
    /// scheduling. Stored as a nonisolated property so the camera capture
    /// callback can read it without an actor hop.
    nonisolated(unsafe) private var onCameraSampleForOverlay: (@Sendable (CMSampleBuffer) -> Void)?

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

    private var onTerminalError: (@Sendable (String) async -> Void)?

    /// Set by the coordinator before `commitRecording`. When invoked the
    /// coordinator should tear down the recording via `stopRecording()` and
    /// show the provided message to the user.
    func setTerminalErrorCallback(_ callback: @escaping @Sendable (String) async -> Void) {
        onTerminalError = callback
    }

    /// Guard so we only fire the terminal-error callback once per recording,
    /// even if multiple metronome ticks observe the same failure before the
    /// stop flow lands.
    private var terminalErrorFired = false

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
    // uses wall-clock-now at the moment of emit. Because they share the same
    // anchor and the same accumulator, they cannot be out of sync with each
    // other regardless of when each source's hardware comes online.

    /// Host clock time at which `frameIdx = 0` on the recording timeline.
    /// nil until `commitRecording()` runs.
    private var recordingStartTime: CMTime?

    /// Total wall-clock time spent paused. Subtracted from elapsed wall time
    /// for both audio and video, so the recording timeline is continuous
    /// across pauses. Updated by pause/resume.
    private var pauseAccumulator: CMTime = .zero

    /// Host clock time when the current pause started. Used by `resume()`.
    private var pauseStartHostTime: CMTime?

    /// Strictly-monotonic guard for video PTS. Prevents same-PTS appends
    /// across pause/resume edge cases (which AVAssetWriter rejects).
    private var lastEmittedVideoPTS: CMTime = .invalid

    // MARK: - Frame Cache

    /// Latest valid screen frame received from ScreenCaptureKit.
    /// The metronome reads this on every tick — so an idle screen produces
    /// correctly-encoded static frames at 30fps instead of gaps.
    private var latestScreenFrame: CVPixelBuffer?

    /// Latest camera frame received from AVCaptureSession.
    private var latestCameraFrame: CVPixelBuffer?

    // MARK: - Metronome

    /// Target frame rate for the output video timeline. The encoder's keyframe
    /// interval (2s) and segment interval (4s) are sized to this.
    private static let targetFrameRate: Int32 = 30
    private static let frameDuration = CMTime(value: 1, timescale: targetFrameRate)

    /// Drives the encoding cadence. Emits a composited frame every 1/30s
    /// regardless of how fast the underlying sources are delivering.
    private var metronomeTask: Task<Void, Never>?

    /// Tick counter used only for drift-corrected sleep scheduling. The
    /// encoder PTS comes from wall clock at emit time, not from this counter.
    /// Resets to 0 when the metronome (re)starts after pause.
    private var metronomeTickIdx: Int64 = 0

    // MARK: - Two-Phase Start
    //
    // Recording start is split into prepare + commit so the coordinator can run
    // the slow setup (server session, capture hardware coming online, audio
    // wait) in parallel with a user-facing countdown. By the time `commit` is
    // called, every source is confirmed running and the recording clock can be
    // anchored cleanly.

    /// Phase 1: do all the slow setup. After this returns, every capture
    /// source's hardware is actually running and frames are flowing into the
    /// caches — but no PTS values have been assigned yet and the writer
    /// session is not yet open.
    func prepareRecording(
        displayID: CGDirectDisplayID?,
        cameraID: String?,
        microphoneID: String?,
        mode: RecordingMode,
        preset: OutputPreset
    ) async throws -> (id: String, slug: String) {
        self.mode = mode
        self.preset = preset
        isRecording = false  // not recording yet — set true in commit
        recordingStartTime = nil
        pauseAccumulator = .zero
        pauseStartHostTime = nil
        lastEmittedVideoPTS = .invalid
        latestScreenFrame = nil
        latestCameraFrame = nil
        metronomeTickIdx = 0
        terminalErrorFired = false
        timeline = RecordingTimelineBuilder()

        // Resolve devices from identifiers. SCShareableContent is only needed
        // when there's actually a display to capture — fetching it requires
        // screen recording permission, which the user shouldn't need to grant
        // for a camera-only recording.
        var display: SCDisplay?
        var ourApp: SCRunningApplication?
        if let displayID {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let resolved = content.displays.first(where: { $0.displayID == displayID }) else {
                throw RecordingError.displayNotFound
            }
            display = resolved
            // Find our own application to exclude our windows (recording panel, camera overlay) from capture
            ourApp = content.applications.first {
                $0.processID == ProcessInfo.processInfo.processIdentifier
            }
        }

        let camera: AVCaptureDevice? = cameraID.flatMap { AVCaptureDevice(uniqueID: $0) }
        let microphone: AVCaptureDevice? = microphoneID.flatMap { AVCaptureDevice(uniqueID: $0) }

        // 1. Create server session
        let session = try await upload.createSession()

        // Populate timeline session + inputs now that we've resolved devices.
        timeline.setSession(id: session.id, slug: session.slug, initialMode: mode)
        timeline.setPreset(preset)
        timeline.setInputs(
            display: display.map {
                .init(
                    id: UInt32($0.displayID),
                    width: $0.width,
                    height: $0.height
                )
            },
            camera: camera.map {
                .init(uniqueID: $0.uniqueID, name: $0.localizedName)
            },
            microphone: microphone.map {
                .init(uniqueID: $0.uniqueID, name: $0.localizedName)
            }
        )

        // Wire upload-result callback into the timeline. This fires on the
        // upload actor and hops back into us to record the result.
        await upload.setOnUploadResult { [weak self] filename, success, error in
            guard let self else { return }
            Task { await self.recordUploadResult(filename: filename, success: success, error: error) }
        }

        // 2. Set up local safety net directory
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let localDir = appSupport.appendingPathComponent("LoomClone/recordings/\(session.id)")
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)
        localSavePath = localDir

        // 3. Configure writer and compositor for this preset.
        await composition.configure(preset: preset)
        try await writer.configure(preset: preset)

        // 3a. Configure raw stream writers — one per selected source.
        // These write native-resolution master files into the local session
        // dir alongside the HLS segments. Done before the composited writer
        // starts so they're ready for the first frame.
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil
        rawScreenDims = nil
        rawCameraDims = nil
        rawAudioConfig = nil

        if let display, let localDir = localSavePath {
            let nativeSize = ScreenCaptureManager.nativePixelSize(for: display)
            let width = Int(nativeSize.width)
            let height = Int(nativeSize.height)
            // ProRes 422 Proxy on the hardware ProRes engine — offloads the
            // heaviest stream off the H.264 media engine so the composited
            // HLS writer and the raw camera writer have the H.264 engine
            // to themselves. See task-0A Phase 2 (architectural rationale
            // in the Background section).
            let url = localDir.appendingPathComponent("screen.mov")
            let w = RawStreamWriter(url: url, kind: .videoProRes(width: width, height: height))
            do {
                try await w.configure()
                screenRawWriter = w
                rawScreenDims = (width, height)
                print("[recording] Raw screen writer: ProRes 422 Proxy at \(width)x\(height) (hardware ProRes engine)")
            } catch {
                print("[recording] Failed to configure raw screen writer: \(error)")
            }
        }

        // The camera raw writer is configured AFTER cameraCapture.startCapture
        // returns (further down) so we can read the actual delivered dims
        // from the running session, not guess them via bestFormat.

        if microphone != nil, let localDir = localSavePath {
            let bitrate = 192_000
            let sampleRate = 48_000
            let channels = 2
            let url = localDir.appendingPathComponent("audio.m4a")
            let w = RawStreamWriter(url: url, kind: .audio(bitrate: bitrate, sampleRate: sampleRate, channels: channels))
            do {
                try await w.configure()
                audioRawWriter = w
                rawAudioConfig = (bitrate, sampleRate, channels)
                print("[recording] Raw audio writer: AAC \(bitrate / 1000) kbps")
            } catch {
                print("[recording] Failed to configure raw audio writer: \(error)")
            }
        }
        // Await the downstream handling synchronously so that
        // `writer.finish()` can wait for every trailing segment to be
        // fully recorded in the timeline and enqueued for upload before
        // it returns. This is what prevents the stop-flow race.
        await writer.setOnSegmentReady { [weak self] segment in
            await self?.handleSegment(segment)
        }

        // 4. Task-1 tuning 2: warm up writers BEFORE opening any capture source.
        // `AVAssetWriter.startWriting()` → `startSession(atSourceTime:)` internally
        // calls `VTCompressionSessionPrepareToEncodeFrames`, which allocates the
        // encoder's IOSurface working set through IOGPUFamily. Doing that while
        // SCStream is already allocating its own IOSurfaces is exactly the race
        // failure mode 4's spindump captured (`videotoolbox.preparationQueue`
        // stuck inside IOGPUFamily kext during early-recording). Warming up here
        // means all three warmable writers' allocations happen in a quiet
        // window, before SCK starts competing for the same kernel resource.
        //
        // The camera raw writer is intentionally NOT warmed up here — it's
        // constructed further down, after `cameraCapture.startCapture()` returns
        // and we can read the delivered dimensions from `device.activeFormat`.
        // It warms up at its own construction point, which is still before
        // `commitRecording` anchors the clock and starts the metronome.
        //
        // Safety: `handleScreenFrame` and `handleCameraFrame` guard their raw-
        // writer appends through `retimedSampleForRawWriter`, which returns
        // nil unless `isRecording == true` — so frames that arrive during the
        // capture-startup window below go into caches only, not into the
        // warmed-up writers. The HLS writer is only fed by the metronome,
        // which doesn't start until `commitRecording`. The init segment that
        // fires out of the HLS writer's delegate during this `startWriting()`
        // is handled by `handleSegment`, which tolerates a pre-commit state
        // (`timeline.recordSegment` is only called for `.media` segments;
        // `logicalElapsedSeconds()` returns 0 before commit).
        await writer.startWriting()
        await screenRawWriter?.startWriting()
        await audioRawWriter?.startWriting()

        // 5. Wire capture callbacks. Frames that arrive now will populate the
        // caches but won't be encoded — the metronome only starts in commit()
        // and `recordingStartTime` is still nil so audio samples are dropped.
        if display != nil {
            screenCapture.onScreenFrame = { [weak self] buffer in
                guard let self else { return }
                Task { await self.handleScreenFrame(buffer) }
            }
        }

        if camera != nil {
            cameraCapture.onCameraFrame = { [weak self] buffer in
                guard let self else { return }
                // Fire the overlay callback FIRST, directly from the capture
                // queue. This bypasses the actor entirely so the on-screen
                // overlay updates at full camera framerate even when the
                // metronome is busy.
                self.onCameraSampleForOverlay?(buffer)
                // Then enter the actor for the recording-side caching work.
                Task { await self.handleCameraFrame(buffer) }
            }
        }

        if microphone != nil {
            micCapture.onAudioSample = { [weak self] buffer in
                guard let self else { return }
                Task { await self.handleAudioSample(buffer) }
            }
        }

        // 6. Start captures and AWAIT each session's hardware coming online.
        // The capture managers now actually wait for `startRunning()` to
        // complete before returning, so by the time these awaits resolve every
        // source is genuinely live.
        //
        // If `screenCapture.startCapture` throws here, the warmed-up writers
        // from step 4 have open `AVAssetWriter` sessions that must be torn
        // down cleanly before re-throwing — otherwise the next prepare
        // attempt would leak the old instances.
        audioHasArrived = false
        if let display {
            do {
                try await screenCapture.startCapture(display: display, excludingApp: ourApp)
            } catch {
                await tearDownWarmedUpWritersOnPrepareFailure()
                throw error
            }
        }
        if let camera {
            // Cap camera capture at the preset height. No point decoding a 4K
            // camera stream just to downscale to 1080p in the compositor.
            await cameraCapture.startCapture(device: camera, maxHeight: preset.height)

            // Now that the camera session is running, read its actual
            // delivered dimensions and configure the raw camera writer
            // with them. Doing this *after* startCapture means we don't
            // depend on `bestFormat` to predict the dims — we read them
            // from the truth (the device's activeFormat). Some cameras
            // (e.g. ZV-1 over USB) return nil from bestFormat but still
            // deliver fine via the .high preset fallback.
            if let localDir = localSavePath {
                let nativeSize = cameraCapture.nativePixelSize
                let width = Int(nativeSize.width)
                let height = Int(nativeSize.height)
                if width > 0 && height > 0 {
                    let bitrate = 12_000_000
                    let url = localDir.appendingPathComponent("camera.mp4")
                    let w = RawStreamWriter(url: url, kind: .videoH264(width: width, height: height, bitrate: bitrate))
                    do {
                        try await w.configure()
                        cameraRawWriter = w
                        rawCameraDims = (width, height, bitrate)
                        print("[recording] Raw camera writer: \(width)x\(height) @ \(bitrate / 1_000_000) Mbps")
                    } catch {
                        print("[recording] Failed to configure raw camera writer: \(error)")
                    }
                } else {
                    print("[recording] Camera nativePixelSize is zero — skipping raw camera writer")
                }
            }
        }
        if let microphone {
            await micCapture.startCapture(device: microphone)
        }

        // 6. Safety net: wait briefly for the first audio sample to actually
        // arrive in our handler. The session is running but the first sample
        // can take an extra 50-200ms.
        if microphone != nil {
            for _ in 0..<100 {
                if audioHasArrived { break }
                try? await Task.sleep(for: .milliseconds(10))
            }
            print("[recording] Audio \(audioHasArrived ? "ready" : "timeout, proceeding anyway")")
        }

        print("[recording] Prepared: mode=\(mode), id=\(session.id)")
        return session
    }

    /// Phase 2: anchor the recording clock and start the encoder.
    /// All capture hardware is already live; this is the moment T = 0.
    func commitRecording() async {
        // Anchor the recording clock to NOW. Every audio and video PTS from
        // this point on is computed relative to this single host-clock value.
        recordingStartTime = CMClockGetTime(CMClockGetHostTimeClock())
        pauseAccumulator = .zero
        pauseStartHostTime = nil
        lastEmittedVideoPTS = .invalid
        isRecording = true

        // Anchor the timeline at the same moment.
        timeline.markStarted()

        // The HLS, raw-screen, and raw-audio writers were already warmed up
        // in `prepareRecording` (task-1 tuning 2). Only the camera raw writer
        // still warms up here, because it's constructed after
        // `cameraCapture.startCapture()` returns with the delivered dims from
        // `device.activeFormat`. It's still warmed up serially, still before
        // the metronome feeds any frames.
        await cameraRawWriter?.startWriting()

        // Start the 30fps metronome — emits frames from the cache regardless
        // of what the underlying sources are doing.
        startMetronome()

        print("[recording] Committed at \(recordingStartTime?.seconds ?? 0)")
    }

    /// Cleanup path for `prepareRecording` failing after the HLS / screen-raw /
    /// audio-raw writers have been warmed up (task-1 tuning 2). Called only
    /// from the error path; on the happy path the writers are owned through
    /// to `stopRecording`.
    private func tearDownWarmedUpWritersOnPrepareFailure() async {
        await writer.finish()
        if let w = screenRawWriter {
            await w.finish()
            screenRawWriter = nil
            rawScreenDims = nil
        }
        if let w = audioRawWriter {
            await w.finish()
            audioRawWriter = nil
            rawAudioConfig = nil
        }
        print("[recording] Tore down warmed-up writers after prepare failure")
    }

    enum RecordingError: Error {
        case displayNotFound
    }

    // MARK: - Stop

    /// Stop a committed recording. Cancels the metronome, stops captures,
    /// finishes the writer, completes the upload session.
    func stopRecording() async -> String? {
        isRecording = false

        // Finalise the timeline BEFORE finishing the writer so the stop event
        // is timestamped at the user-visible stop moment, not after the
        // (potentially slow) finishWriting completion.
        let logicalDuration = logicalElapsedSeconds()
        timeline.markStopped(logicalDuration: logicalDuration)

        // Stop the metronome first so no more frames get appended
        print("[recording] Stopping metronome...")
        await cancelMetronome()
        print("[recording] Metronome stopped")

        // Stop captures (each await waits for stopRunning() to actually return)
        print("[recording] Stopping captures...")
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        print("[recording] Captures stopped")

        // Kick off raw writer finishes in the background, in parallel with
        // the composited writer's finish flow. Each raw writer is independent
        // — finalising one doesn't block the others. We await them all
        // together below before snapshotting the timeline.
        let screenW = screenRawWriter
        let cameraW = cameraRawWriter
        let audioW = audioRawWriter
        let rawFinishTask = Task { [screenW, cameraW, audioW] in
            await withTaskGroup(of: Void.self) { group in
                if let w = screenW { group.addTask { await w.finish() } }
                if let w = cameraW { group.addTask { await w.finish() } }
                if let w = audioW { group.addTask { await w.finish() } }
            }
        }

        // Finish writer. Blocks until every trailing segment has been fully
        // processed by the writer's consumer — i.e. recorded in the timeline
        // and enqueued for upload. After this line, no more segments can
        // appear from the encoder.
        print("[recording] Finishing composited writer...")
        await writer.finish()
        print("[recording] Composited writer done")

        // Drain the upload queue so every segment's upload result (success
        // or final failure) has fired its callback and updated the timeline
        // builder. Without this, trailing segments would be snapshotted as
        // `uploaded: false` before they'd actually had a chance to upload.
        await upload.drainQueue()

        // Wait for raw writers to finish flushing. They've been running in
        // parallel with the composited finish; this is the join point.
        await rawFinishTask.value

        // Populate timeline raw stream metadata now that the files are on
        // disk and we can read their final byte sizes.
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
            timeline.setRawScreen(
                filename: w.url.lastPathComponent,
                width: dims.width,
                height: dims.height,
                codec: "prores422proxy",
                bitrate: observedBitrate,
                bytes: bytes
            )
        }
        if let dims = rawCameraDims, let w = cameraRawWriter {
            timeline.setRawCamera(
                filename: w.url.lastPathComponent,
                width: dims.width,
                height: dims.height,
                codec: "h264",
                bitrate: dims.bitrate,
                bytes: w.bytesOnDisk() ?? 0
            )
        }
        if let cfg = rawAudioConfig, let w = audioRawWriter {
            timeline.setRawAudio(
                filename: w.url.lastPathComponent,
                codec: "aac-lc",
                bitrate: cfg.bitrate,
                sampleRate: cfg.sampleRate,
                channels: cfg.channels,
                bytes: w.bytesOnDisk() ?? 0
            )
        }
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil

        // NOW the builder is fully up-to-date: all segments, all pauses,
        // all mode switches, all upload results. Snapshot it.
        let builtTimeline = timeline.build()
        let timelineData = encodeTimeline(builtTimeline)

        if let localDir = localSavePath, let data = timelineData {
            let path = localDir.appendingPathComponent("recording.json")
            do {
                try data.write(to: path)
            } catch {
                print("[recording] Failed to write local timeline: \(error)")
            }
        }

        // Complete upload (includes the timeline in the payload)
        do {
            let url = try await upload.complete(timeline: timelineData)
            print("[recording] Stopped, URL: \(url)")
            return url
        } catch {
            print("[recording] Complete failed: \(error)")
            return nil
        }
    }

    private func encodeTimeline(_ timeline: RecordingTimeline) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            return try encoder.encode(timeline)
        } catch {
            print("[recording] Failed to encode timeline: \(error)")
            return nil
        }
    }

    /// Cancel a committed recording. Tears down the pipeline like stop(),
    /// but discards the result: tells the server to delete the video and
    /// removes the local safety-net copy.
    func cancelRecording() async {
        isRecording = false

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

        print("[recording] Cancelled")
    }

    /// Cancel during prepare/countdown — captures may be running but the
    /// writer was never started. Tear down without trying to finalise.
    func cancelPreparation() async {
        isRecording = false
        await cancelMetronome()
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        await writer.finish()  // no-op when hasStartedSession == false

        // Same for raw writers — they were configured but never started.
        // RawStreamWriter.finish() handles the unstarted case by removing
        // the empty file and bailing.
        await screenRawWriter?.finish()
        await cameraRawWriter?.finish()
        await audioRawWriter?.finish()
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil

        print("[recording] Preparation cancelled")
    }

    // MARK: - Pause / Resume

    func pause() async {
        await cancelMetronome()
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        pauseStartHostTime = now

        timeline.recordPaused(t: logicalElapsedSeconds())

        // The audio path also tracks pauses (in TimestampAdjuster) so post-resume
        // mic samples retime correctly. Both accumulators must advance together.
        await writer.pause(at: now)
    }

    func resume() async {
        let now = CMClockGetTime(CMClockGetHostTimeClock())

        // Add the pause duration to our accumulator so subsequent video frames
        // continue from the same logical time as the last pre-pause frame.
        var pauseSeconds: Double = 0
        if let pauseStart = pauseStartHostTime {
            let pauseDuration = now - pauseStart
            pauseAccumulator = pauseAccumulator + pauseDuration
            pauseSeconds = pauseDuration.seconds
        }
        pauseStartHostTime = nil

        timeline.recordResumed(t: logicalElapsedSeconds(), pauseDuration: pauseSeconds)

        await writer.resume(at: now)
        startMetronome()
    }

    /// Logical recording time in seconds (wall elapsed minus time spent paused).
    /// Returns 0 before commit. Used for timeline event timestamps so events on
    /// the timeline line up with segment PTS values.
    private func logicalElapsedSeconds() -> Double {
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
        print("[recording] Mode switched to: \(newMode)")
    }

    // MARK: - Frame Handling

    /// Screen frames are cached for the metronome (composited HLS path)
    /// AND retimed + appended to the raw screen writer at native cadence.
    /// Frames may arrive during prepare (before commit) — we still cache
    /// them so the metronome has fresh content the instant it starts, but
    /// raw writes are gated on `isRecording` so pre-commit frames don't
    /// reach the raw file.
    private func handleScreenFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestScreenFrame = pixelBuffer

        if let screenRawWriter,
           let retimed = retimedSampleForRawWriter(sampleBuffer) {
            await screenRawWriter.append(retimed)
        }
    }

    /// Camera frames are cached for the metronome, forwarded to the
    /// composition actor, AND retimed + appended to the raw camera writer.
    /// The on-screen overlay is fed separately from the capture queue
    /// itself (see `onCameraSampleForOverlay`).
    private func handleCameraFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestCameraFrame = pixelBuffer
        await composition.updateCameraFrame(pixelBuffer)

        if let cameraRawWriter,
           let retimed = retimedSampleForRawWriter(sampleBuffer) {
            await cameraRawWriter.append(retimed)
        }
    }

    /// Retime a sample buffer onto the recording's logical timeline so it
    /// can be appended to a raw writer. Returns nil if the recording isn't
    /// committed yet, the recording is paused, or the sample's PTS is
    /// before the recording start anchor.
    ///
    /// Both raw video and raw audio writers use this — same single-anchor
    /// formula the metronome uses for the composited path.
    private func retimedSampleForRawWriter(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard isRecording,
              pauseStartHostTime == nil,
              let startTime = recordingStartTime else { return nil }

        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard originalPTS.isValid else { return nil }

        let relPTS = (originalPTS - startTime) - pauseAccumulator
        guard relPTS >= .zero else { return nil }

        let duration = CMSampleBufferGetDuration(sampleBuffer)
        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: relPTS,
            decodeTimeStamp: .invalid
        )
        var out: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &out
        )
        return out
    }

    private func handleAudioSample(_ sampleBuffer: CMSampleBuffer) async {
        audioHasArrived = true
        guard isRecording else { return }
        guard let startTime = recordingStartTime else { return }

        // Audio uses the same single-anchor formula as the metronome:
        //   PTS = primingOffset + (originalHostPTS - recordingStartTime) - pauseAccumulator
        // Both audio and video derive their PTS from this formula, so they
        // are anchored to exactly the same point on the host clock.
        // The TimestampAdjuster in WriterActor adds the priming offset and
        // applies its parallel pause accumulator — both accumulators advance
        // together via pause/resume so they stay in lockstep.
        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard originalPTS.isValid else { return }
        let relativePTS = originalPTS - startTime

        // Drop samples captured before the recording was committed.
        // These can occur briefly during the prepare→commit transition.
        guard relativePTS >= .zero else { return }

        let duration = CMSampleBufferGetDuration(sampleBuffer)

        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: relativePTS,
            decodeTimeStamp: .invalid
        )

        var retimed: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &retimed
        )

        guard let retimed else { return }
        await writer.appendAudio(retimed)

        // Raw audio path: independent retiming using RecordingActor's
        // pauseAccumulator (no priming offset — that's an HLS-only concern).
        // The pause check is the same gate the composited path uses inside
        // WriterActor.appendAudio.
        if let audioRawWriter, pauseStartHostTime == nil {
            let rawAudioPTS = relativePTS - pauseAccumulator
            if rawAudioPTS >= .zero {
                var rawTiming = CMSampleTimingInfo(
                    duration: duration,
                    presentationTimeStamp: rawAudioPTS,
                    decodeTimeStamp: .invalid
                )
                var rawOut: CMSampleBuffer?
                CMSampleBufferCreateCopyWithNewTiming(
                    allocator: kCFAllocatorDefault,
                    sampleBuffer: sampleBuffer,
                    sampleTimingEntryCount: 1,
                    sampleTimingArray: &rawTiming,
                    sampleBufferOut: &rawOut
                )
                if let rawOut {
                    await audioRawWriter.append(rawOut)
                }
            }
        }
    }

    // MARK: - Metronome

    /// Starts the metronome loop. Safe to call only when `metronomeTask` is nil.
    private func startMetronome() {
        metronomeTickIdx = 0
        metronomeTask = Task { [weak self] in
            await self?.metronomeLoop()
        }
    }

    /// Cancels the metronome task and awaits its completion so the caller can
    /// be sure no more frames will be appended before it proceeds.
    private func cancelMetronome() async {
        guard let task = metronomeTask else { return }
        task.cancel()
        _ = await task.value
        metronomeTask = nil
    }

    /// The 30fps encoding loop. On each tick: compose a frame from the latest
    /// cached buffers and append with `pts = primingOffset + elapsedLogical`,
    /// where `elapsedLogical = (now - recordingStartTime) - pauseAccumulator`.
    ///
    /// PTS is derived from wall-clock-now at emit time, not from a frame
    /// counter, so the metronome shares its clock with the audio path and
    /// A/V cannot drift apart.
    ///
    /// The sleep schedule is drift-corrected against `recordingStartTime` so
    /// ticks fire at steady 1/30s intervals (with small wiggle from sleep
    /// imprecision, which is invisible because PTS comes from wall clock).
    private func metronomeLoop() async {
        while !Task.isCancelled && isRecording {
            let emitted = await emitMetronomeFrame()

            if !emitted {
                // Source for the current mode hasn't delivered its first frame
                // yet. Poll briefly and retry.
                try? await Task.sleep(for: .nanoseconds(33_333_333))
                continue
            }

            metronomeTickIdx += 1

            // Drift-corrected sleep: tick N fires at
            //   recordingStartTime + pauseAccumulator + N × (1/30)
            // (`pauseAccumulator` is read for the current iteration only —
            // pause/resume cancels and restarts the loop with tickIdx=0.)
            guard let start = recordingStartTime else { continue }
            let nextTarget = start
                + pauseAccumulator
                + CMTime(value: metronomeTickIdx, timescale: Self.targetFrameRate)
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            let sleepSeconds = (nextTarget - now).seconds
            if sleepSeconds > 0 {
                try? await Task.sleep(for: .seconds(sleepSeconds))
            }
            // If sleepSeconds <= 0 we're behind schedule — burst-emit until
            // we catch up. Each catch-up frame uses the same cached content;
            // since wall-clock advances each iteration, PTS still advances.
        }
    }

    /// Compose and append a single metronome frame. Returns true if a frame
    /// was actually appended (source available, composition succeeded, PTS
    /// strictly monotonic).
    private func emitMetronomeFrame() async -> Bool {
        guard let start = recordingStartTime else { return false }

        let result: Result<CVPixelBuffer, CompositionError>?
        switch mode {
        case .screenOnly:
            guard let screen = latestScreenFrame else { return false }
            result = await composition.compositeFrame(screenBuffer: screen, mode: .screenOnly)
        case .screenAndCamera:
            guard let screen = latestScreenFrame else { return false }
            result = await composition.compositeFrame(screenBuffer: screen, mode: .screenAndCamera)
        case .cameraOnly:
            guard latestCameraFrame != nil else { return false }
            result = await composition.compositeFrame(screenBuffer: nil, mode: .cameraOnly)
        }

        // nil = transient (source raced, output pool miss). Skip, retry next tick.
        guard let result else { return false }

        let output: CVPixelBuffer
        switch result {
        case .success(let buffer):
            output = buffer
        case .failure(let compositionError):
            await handleCompositionFailure(compositionError)
            return false
        }

        // Wall-clock-derived PTS using the single recording clock.
        // Same formula as audio: primingOffset + elapsedLogical.
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let elapsedLogical = (now - start) - pauseAccumulator
        let pts = TimestampAdjuster.defaultPrimingOffset + elapsedLogical

        // Strict monotonicity guard. Wall clock is monotonic but the
        // pause-accumulator update could in theory produce a duplicate PTS at
        // the exact instant of resume — drop those.
        if lastEmittedVideoPTS.isValid, pts <= lastEmittedVideoPTS { return false }
        lastEmittedVideoPTS = pts

        guard let outputSample = createSampleBuffer(
            from: output,
            pts: pts,
            duration: Self.frameDuration
        ) else { return false }

        await writer.appendVideo(outputSample)
        return true
    }

    // MARK: - Composition Failure Recovery
    //
    // task-5 Phase 1: when `CompositionActor.compositeFrame` surfaces a render
    // error or a stall, we:
    //   1. Record the failure + counter in the timeline.
    //   2. Ask the compositor to rebuild its CIContext + MTLCommandQueue so
    //      the next tick renders against a fresh command queue (the old one is
    //      assumed poisoned after the first GPU-timeout cascade — see failure
    //      modes 1/3 in docs/m2-pro-video-pipeline-failures.md).
    //   3. If rebuild itself fails, fire the terminal-error callback so the
    //      coordinator can stop the recording cleanly and alert the user.
    //
    // The metronome returns false on any failure so this tick is skipped. The
    // next tick runs with a fresh context (on success) or finds `isRecording`
    // flipped false (on terminal failure, once the coordinator's stopRecording
    // lands).

    private func handleCompositionFailure(_ error: CompositionError) async {
        let t = logicalElapsedSeconds()
        let kind: String
        let detail: String
        switch error {
        case .renderFailed(let underlying):
            kind = "renderError"
            detail = (underlying as NSError).localizedDescription
        case .stallTimeout:
            kind = "stallTimeout"
            detail = "waitUntilCompleted exceeded 2s"
        }
        timeline.recordCompositionFailure(kind: kind, t: t, detail: detail)
        print("[recording] Composition failure: \(kind) — \(detail). Attempting rebuild.")

        let rebuilt = await composition.rebuildContext()
        if rebuilt {
            timeline.recordCompositionRebuilt(t: logicalElapsedSeconds())
            print("[recording] Rebuild succeeded, recording continues")
            return
        }

        // Rebuild failed — escalate.
        print("[recording] Rebuild failed; escalating to terminal stop")
        await escalateCompositionTerminalFailure(detail: "Rebuild failed after \(kind)")
    }

    private func escalateCompositionTerminalFailure(detail: String) async {
        guard !terminalErrorFired else { return }
        terminalErrorFired = true

        timeline.recordCompositionTerminalFailure(
            t: logicalElapsedSeconds(),
            detail: detail
        )

        let message = "Recording stopped: the GPU became unresponsive. Your recording has been saved up to this point."

        // Fire the callback on a detached task so we don't deadlock — the
        // coordinator's response will call back into stopRecording(), which
        // awaits cancelMetronome(), which awaits the metronome task we're
        // currently running inside.
        if let callback = onTerminalError {
            Task { await callback(message) }
        } else {
            print("[recording] WARN: terminal composition failure but no onTerminalError callback wired")
        }
    }

    // MARK: - Segment Handling

    private func handleSegment(_ segment: VideoSegment) async {
        // Record in the timeline before uploading so the emit event is
        // definitely ordered before any upload result event.
        if segment.type == .media {
            timeline.recordSegment(
                index: segment.index,
                filename: segment.filename,
                bytes: segment.data.count,
                duration: segment.duration,
                emittedAt: logicalElapsedSeconds()
            )
        }

        // Upload to server
        await upload.enqueue(segment)

        // Save locally as safety net
        if let localDir = localSavePath {
            let filePath = localDir.appendingPathComponent(segment.filename)
            do {
                try segment.data.write(to: filePath)
            } catch {
                print("[recording] Failed to save local segment: \(error)")
            }
        }
    }

    // MARK: - Helpers

    private func createSampleBuffer(
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
    func setOnSegmentReady(_ handler: @escaping @Sendable (VideoSegment) async -> Void) {
        onSegmentReady = handler
    }
}
