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

    // MARK: - State

    private var mode: RecordingMode = .screenAndCamera
    private var isRecording = false
    private var localSavePath: URL?

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
        displayID: CGDirectDisplayID,
        cameraID: String?,
        microphoneID: String?,
        mode: RecordingMode
    ) async throws -> (id: String, slug: String) {
        self.mode = mode
        isRecording = false  // not recording yet — set true in commit
        recordingStartTime = nil
        pauseAccumulator = .zero
        pauseStartHostTime = nil
        lastEmittedVideoPTS = .invalid
        latestScreenFrame = nil
        latestCameraFrame = nil
        metronomeTickIdx = 0

        // Resolve devices from identifiers
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw RecordingError.displayNotFound
        }

        // Find our own application to exclude our windows (recording panel, camera overlay) from capture
        let ourApp = content.applications.first {
            $0.processID == ProcessInfo.processInfo.processIdentifier
        }

        let camera: AVCaptureDevice? = cameraID.flatMap { AVCaptureDevice(uniqueID: $0) }
        let microphone: AVCaptureDevice? = microphoneID.flatMap { AVCaptureDevice(uniqueID: $0) }

        // 1. Create server session
        let session = try await upload.createSession()

        // 2. Set up local safety net directory
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let localDir = appSupport.appendingPathComponent("LoomClone/recordings/\(session.id)")
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)
        localSavePath = localDir

        // 3. Configure writer (but don't start yet — commit() does that)
        try await writer.configure()
        await writer.setOnSegmentReady { [weak self] segment in
            guard let self else { return }
            Task { await self.handleSegment(segment) }
        }

        // 4. Wire capture callbacks. Frames that arrive now will populate the
        // caches but won't be encoded — the metronome only starts in commit()
        // and `recordingStartTime` is still nil so audio samples are dropped.
        screenCapture.onScreenFrame = { [weak self] buffer in
            guard let self else { return }
            Task { await self.handleScreenFrame(buffer) }
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

        // 5. Start captures and AWAIT each session's hardware coming online.
        // The capture managers now actually wait for `startRunning()` to
        // complete before returning, so by the time these awaits resolve every
        // source is genuinely live.
        audioHasArrived = false
        try await screenCapture.startCapture(display: display, excludingApp: ourApp)
        if let camera {
            await cameraCapture.startCapture(device: camera)
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

        // Open the writer session
        await writer.startWriting()

        // Start the 30fps metronome — emits frames from the cache regardless
        // of what the underlying sources are doing.
        startMetronome()

        print("[recording] Committed at \(recordingStartTime?.seconds ?? 0)")
    }

    enum RecordingError: Error {
        case displayNotFound
    }

    // MARK: - Stop

    /// Stop a committed recording. Cancels the metronome, stops captures,
    /// finishes the writer, completes the upload session.
    func stopRecording() async -> String? {
        isRecording = false

        // Stop the metronome first so no more frames get appended
        await cancelMetronome()

        // Stop captures (each await waits for stopRunning() to actually return)
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()

        // Finish writer
        await writer.finish()

        // Complete upload
        do {
            let url = try await upload.complete()
            print("[recording] Stopped, URL: \(url)")
            return url
        } catch {
            print("[recording] Complete failed: \(error)")
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
        print("[recording] Preparation cancelled")
    }

    // MARK: - Pause / Resume

    func pause() async {
        await cancelMetronome()
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        pauseStartHostTime = now

        // The audio path also tracks pauses (in TimestampAdjuster) so post-resume
        // mic samples retime correctly. Both accumulators must advance together.
        await writer.pause(at: now)
    }

    func resume() async {
        let now = CMClockGetTime(CMClockGetHostTimeClock())

        // Add the pause duration to our accumulator so subsequent video frames
        // continue from the same logical time as the last pre-pause frame.
        if let pauseStart = pauseStartHostTime {
            let pauseDuration = now - pauseStart
            pauseAccumulator = pauseAccumulator + pauseDuration
        }
        pauseStartHostTime = nil

        await writer.resume(at: now)
        startMetronome()
    }

    // MARK: - Mode Switch

    func switchMode(to newMode: RecordingMode) {
        mode = newMode
        print("[recording] Mode switched to: \(newMode)")
    }

    // MARK: - Frame Handling

    /// Screen frames are cached, not directly encoded. The metronome reads
    /// the cache on every tick. Frames may arrive during prepare (before
    /// commit) — we still cache them so the metronome has fresh content the
    /// instant it starts.
    private func handleScreenFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestScreenFrame = pixelBuffer
    }

    /// Camera frames are cached for the metronome and forwarded to the
    /// composition actor. The on-screen overlay is fed separately, directly
    /// from the camera capture queue (see `onCameraSampleForOverlay`), so
    /// it doesn't wait on the actor.
    private func handleCameraFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestCameraFrame = pixelBuffer
        await composition.updateCameraFrame(pixelBuffer)
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

        let output: CVPixelBuffer?
        switch mode {
        case .screenOnly:
            guard let screen = latestScreenFrame else { return false }
            output = await composition.compositeFrame(screenBuffer: screen, mode: .screenOnly)
        case .screenAndCamera:
            guard let screen = latestScreenFrame else { return false }
            output = await composition.compositeFrame(screenBuffer: screen, mode: .screenAndCamera)
        case .cameraOnly:
            guard latestCameraFrame != nil else { return false }
            output = await composition.compositeFrame(screenBuffer: nil, mode: .cameraOnly)
        }

        guard let output else { return false }

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

    // MARK: - Segment Handling

    private func handleSegment(_ segment: VideoSegment) async {
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
    func setOnSegmentReady(_ handler: @escaping @Sendable (VideoSegment) -> Void) {
        onSegmentReady = handler
    }
}
