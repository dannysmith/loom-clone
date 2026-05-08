import AVFoundation
import CoreMedia

extension RecordingActor {
    // MARK: - Frame Handling

    /// Screen frames are cached for the metronome (composited HLS path)
    /// AND retimed + appended to the raw screen writer at native cadence.
    /// Frames may arrive during prepare (before commit) — we still cache
    /// them so the metronome has fresh content the instant it starts, but
    /// raw writes are gated on `isRecording` so pre-commit frames don't
    /// reach the raw file.
    func handleScreenFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let capturePTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        latestScreenFrame = CachedFrame(pixelBuffer: pixelBuffer, capturePTS: capturePTS)
        markScreenFrameReceived()

        if let screenRawWriter,
           let retimed = retimedSampleForRawWriter(sampleBuffer)
        {
            await screenRawWriter.append(retimed)
        }
    }

    /// Camera frames are enqueued for the metronome to consume, AND
    /// retimed + appended to the raw camera writer. The on-screen overlay
    /// is fed separately from the capture queue itself (see
    /// `onCameraSampleForOverlay`).
    func handleCameraFrame(_ sampleBuffer: CMSampleBuffer) async {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let capturePTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        cameraFrameQueue.append(CachedFrame(pixelBuffer: pixelBuffer, capturePTS: capturePTS))
        markCameraFrameReceived()
        if cameraFrameQueue.count > Self.cameraFrameQueueCapacity {
            cameraFrameQueue.removeFirst()
        }

        if let cameraRawWriter,
           let retimed = retimedSampleForRawWriter(sampleBuffer)
        {
            await cameraRawWriter.append(retimed)
        }
    }

    /// Audio samples go to the HLS writer (via TimestampAdjuster) and a raw
    /// writer. When `sharedSessionAudioActive` is true this is called from
    /// the camera's shared session and the raw copy goes to camera.mp4's
    /// audio track. Otherwise it's called from the standalone mic and the
    /// raw copy goes to audio.m4a.
    func handleAudioSample(_ sampleBuffer: CMSampleBuffer) async {
        audioHasArrived = true
        markAudioSampleReceived()
        guard isRecording else { return }
        guard let startTime = recordingStartTime else { return }

        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard originalPTS.isValid else { return }
        let relativePTS = originalPTS - startTime

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
        // Routes to camera.mp4 audio when shared session is active, or
        // audio.m4a when the standalone mic feeds the HLS writer.
        if pauseStartHostTime == nil {
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
                    if sharedSessionAudioActive {
                        await cameraRawWriter?.appendAudio(rawOut)
                    } else {
                        await audioRawWriter?.append(rawOut)
                    }
                }
            }
        }
    }

    /// Audio from the standalone mic session. When the camera's shared session
    /// is the primary audio source for HLS, standalone mic audio only feeds
    /// audio.m4a. When no camera is present, delegates to `handleAudioSample`
    /// which feeds both HLS and audio.m4a.
    func handleMicAudioSample(_ sampleBuffer: CMSampleBuffer) async {
        if sharedSessionAudioActive {
            await handleStandaloneAudioSample(sampleBuffer)
        } else {
            await handleAudioSample(sampleBuffer)
        }
    }

    /// Audio that only goes to the standalone audio.m4a raw writer. Used for
    /// the standalone mic session when camera + mic share a session (so the
    /// shared session's audio is the one feeding HLS).
    func handleStandaloneAudioSample(_ sampleBuffer: CMSampleBuffer) async {
        audioHasArrived = true
        markAudioSampleReceived()
        guard let audioRawWriter,
              let retimed = retimedSampleForRawWriter(sampleBuffer) else { return }
        await audioRawWriter.append(retimed)
    }

    // MARK: - Metronome Frame Emission

    /// Acquire source frames for the current mode, composite them, and return
    /// the rendered buffer along with the source capture PTS. Returns nil when
    /// source frames aren't available or composition fails.
    private func compositeForCurrentMode() async -> (CVPixelBuffer, CMTime)? {
        let result: Result<CVPixelBuffer, CompositionError>?
        let sourcePTS: CMTime
        switch mode {
        case .screenOnly:
            guard let screen = latestScreenFrame else { return nil }
            sourcePTS = screen.capturePTS
            result = await composition.compositeFrame(
                screenBuffer: screen.pixelBuffer,
                cameraBuffer: nil,
                mode: .screenOnly
            )
        case .screenAndCamera:
            guard let screen = latestScreenFrame else { return nil }
            let camera = cameraFrameQueue.last
            // Screen drives timing in screenAndCamera mode — it's the
            // primary content, camera is just a PiP overlay. Using
            // screen PTS ensures the output advances at the screen's
            // delivery rate (60fps when configured). Using camera PTS
            // would throttle to the camera's rate when it's slower
            // (e.g. 30fps camera + 60fps screen), causing the
            // monotonicity check to reject every other tick.
            sourcePTS = screen.capturePTS
            let cameraAvailable = camera != nil
                && !activeSourceWarnings.contains(.cameraFailed)
                && !activeSourceWarnings.contains(.cameraStale)
            if cameraAvailable, let camera {
                result = await composition.compositeFrame(
                    screenBuffer: screen.pixelBuffer,
                    cameraBuffer: camera.pixelBuffer,
                    mode: .screenAndCamera,
                    pipPosition: pipPosition
                )
            } else {
                result = await composition.compositeFrame(
                    screenBuffer: screen.pixelBuffer,
                    cameraBuffer: nil,
                    mode: .screenOnly
                )
            }
        case .cameraOnly:
            // Pop a fresh frame if available; otherwise re-emit the most
            // recently popped frame (peek-with-repeat). This handles the
            // case where the metronome ticks at 60fps but the camera only
            // delivers at 30fps — every other tick has an empty FIFO.
            // Repeated frames compress to nearly nothing in H.264.
            let camera: CachedFrame
            if !cameraFrameQueue.isEmpty {
                let popped = cameraFrameQueue.removeFirst()
                lastPoppedCameraFrame = popped
                camera = popped
            } else if let last = lastPoppedCameraFrame {
                camera = last
            } else {
                return nil
            }
            sourcePTS = camera.capturePTS
            result = await composition.compositeFrame(
                screenBuffer: nil,
                cameraBuffer: camera.pixelBuffer,
                mode: .cameraOnly
            )
        }

        guard let result else { return nil }
        switch result {
        case let .success(buffer):
            return (buffer, sourcePTS)
        case let .failure(compositionError):
            await handleCompositionFailure(compositionError)
            return nil
        }
    }

    /// Compose and append a single metronome frame. Returns true if a frame
    /// was actually appended (source available, composition succeeded, PTS
    /// strictly monotonic).
    func emitMetronomeFrame() async -> Bool {
        // Bail immediately if the stop flow has already fired. The metronome
        // loop's `while` guard may have passed before `isRecording` flipped,
        // but by the time we enter here the stop is in progress — submitting
        // a render task now just races against teardown.
        guard isRecording else { return false }
        guard let start = recordingStartTime else { return false }

        // `sourcePTS` is the capture time of the visible content. We stamp
        // the emitted video frame with this (not wall-clock-now) so audio
        // and video share the same notion of "when the content was at the
        // hardware."
        guard let (output, sourcePTS) = await compositeForCurrentMode() else { return false }

        guard sourcePTS.isValid else { return false }
        let elapsedLogical = (sourcePTS - start) - pauseAccumulator
        guard elapsedLogical >= .zero else { return false }
        let pts = TimestampAdjuster.defaultPrimingOffset + elapsedLogical

        if lastEmittedVideoPTS.isValid, pts <= lastEmittedVideoPTS { return false }
        lastEmittedVideoPTS = pts

        guard let outputSample = createSampleBuffer(
            from: output,
            pts: pts,
            duration: frameDuration
        ) else { return false }

        await writer.appendVideo(outputSample)
        return true
    }

    // MARK: - PTS Helpers

    /// Retime a sample buffer onto the recording's logical timeline so it
    /// can be appended to a raw writer. Returns nil if the recording isn't
    /// committed yet, the recording is paused, or the sample's PTS is
    /// before the recording start anchor.
    func retimedSampleForRawWriter(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
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
}
