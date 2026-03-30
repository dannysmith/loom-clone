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

    // MARK: - Timing

    /// Host clock time when recording started. All video PTS are relative to this.
    /// Using a single clock source avoids timestamp discontinuities when switching
    /// between screen-driven and camera-driven modes.
    private var recordingStartTime: CMTime?

    /// Last video PTS appended to the writer. Used to ensure strict monotonicity.
    private var lastVideoPTS: CMTime = .zero

    /// Fixed frame duration for 30fps video.
    private let frameDuration = CMTime(value: 1, timescale: 30)

    // MARK: - Start Recording

    func startRecording(
        displayID: CGDirectDisplayID,
        cameraID: String?,
        microphoneID: String?,
        mode: RecordingMode
    ) async throws -> (id: String, slug: String) {
        self.mode = mode
        isRecording = true
        recordingStartTime = CMClockGetTime(CMClockGetHostTimeClock())
        lastVideoPTS = .zero

        // Resolve devices from identifiers
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw RecordingError.displayNotFound
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

        // 3. Configure and start writer
        try await writer.configure()
        await writer.setOnSegmentReady { [weak self] segment in
            guard let self else { return }
            Task { await self.handleSegment(segment) }
        }
        await writer.startWriting()

        // 4. Wire capture callbacks
        screenCapture.onScreenFrame = { [weak self] buffer in
            guard let self else { return }
            Task { await self.handleScreenFrame(buffer) }
        }

        if camera != nil {
            cameraCapture.onCameraFrame = { [weak self] buffer in
                guard let self else { return }
                Task { await self.handleCameraFrame(buffer) }
            }
        }

        if microphone != nil {
            micCapture.onAudioSample = { [weak self] buffer in
                guard let self else { return }
                Task { await self.handleAudioSample(buffer) }
            }
        }

        // 5. Start captures
        try await screenCapture.startCapture(display: display)
        if let camera {
            await cameraCapture.startCapture(device: camera)
        }
        if let microphone {
            await micCapture.startCapture(device: microphone)
        }

        print("[recording] Started: mode=\(mode), id=\(session.id)")
        return session
    }

    enum RecordingError: Error {
        case displayNotFound
    }

    // MARK: - Stop

    func stopRecording() async -> String? {
        isRecording = false

        // Stop captures
        await screenCapture.stopCapture()
        cameraCapture.stopCapture()
        micCapture.stopCapture()

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

    // MARK: - Pause / Resume

    func pause() async {
        let time = CMClockGetTime(CMClockGetHostTimeClock())
        await writer.pause(at: time)
    }

    func resume() async {
        let time = CMClockGetTime(CMClockGetHostTimeClock())
        await writer.resume(at: time)
    }

    // MARK: - Mode Switch

    func switchMode(to newMode: RecordingMode) {
        mode = newMode
        print("[recording] Mode switched to: \(newMode)")
    }

    // MARK: - Frame Handling

    /// Compute a monotonically increasing PTS for video frames using the host clock.
    /// This avoids timestamp discontinuities when switching between screen and camera sources.
    private func nextVideoPTS() -> CMTime {
        guard let start = recordingStartTime else { return .zero }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        var pts = now - start

        // Ensure strict monotonicity
        if pts <= lastVideoPTS {
            pts = lastVideoPTS + CMTime(value: 1, timescale: 600) // tiny increment
        }
        lastVideoPTS = pts
        return pts
    }

    private func handleScreenFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard isRecording else { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let output: CVPixelBuffer?

        switch mode {
        case .screenOnly:
            output = await composition.compositeFrame(screenBuffer: pixelBuffer, mode: .screenOnly)
        case .screenAndCamera:
            output = await composition.compositeFrame(screenBuffer: pixelBuffer, mode: .screenAndCamera)
        case .cameraOnly:
            return
        }

        guard let output else { return }

        let pts = nextVideoPTS()
        let outputSample = createSampleBuffer(from: output, pts: pts, duration: frameDuration)

        guard let outputSample else { return }
        await writer.appendVideo(outputSample)
    }

    private func handleCameraFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard isRecording else { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Always update the latest camera frame for the compositor
        await composition.updateCameraFrame(pixelBuffer)

        // In cameraOnly mode, the camera drives the encoding pipeline
        if mode == .cameraOnly {
            let output = await composition.compositeFrame(screenBuffer: nil, mode: .cameraOnly)
            guard let output else { return }

            let pts = nextVideoPTS()
            let outputSample = createSampleBuffer(from: output, pts: pts, duration: frameDuration)

            guard let outputSample else { return }
            await writer.appendVideo(outputSample)
        }
    }

    private func handleAudioSample(_ sampleBuffer: CMSampleBuffer) async {
        guard isRecording else { return }
        await writer.appendAudio(sampleBuffer)
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
