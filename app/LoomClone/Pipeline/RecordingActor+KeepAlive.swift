import AVFoundation
import CoreMedia

extension RecordingActor {
    // MARK: - Keep-Alive

    // The held-frame path. A capture source that isn't changing delivers no
    // frames — ScreenCaptureKit only sends a `.complete` frame on content
    // change — so the freshness gate has nothing to emit and the output would
    // simply stop. This emits a synthetic-PTS repeat of the last cached frame
    // instead, which is what keeps a static-screen recording playable: video
    // holds while audio runs on at its real cadence.

    /// Emit a synthetic-PTS repeat of the last cached source frame when the
    /// freshness gate has nothing emittable — a long static-source run, or a
    /// recording that starts on a source which isn't changing. Called from
    /// `emitMetronomeFrame` after the freshness check skipped a tick;
    /// returns true if a keep-alive was actually appended.
    ///
    /// The keep-alive PTS is wall-clock-anchored
    /// (`primingOffset + (host_now - start) - pauseAccumulator`) — the
    /// same formula real frames use, just substituting host_now for the
    /// source capture time. This keeps A/V aligned through the static
    /// run: audio PTS is also wall-clock-relative-to-start, so audio
    /// continues at its real cadence while video holds the last frame.
    ///
    /// We deliberately do NOT update `lastEmittedSourcePTS` — when a
    /// fresh source frame eventually arrives, its capturePTS should still
    /// be strictly newer than the pre-stale-run real emit, so the
    /// freshness check accepts it.
    func tryEmitKeepAlive(
        iterIdx: Int64,
        start: CMTime,
        lastEmitLogical: Double?
    ) async -> Bool {
        let nowHost = CMClockGetTime(CMClockGetHostTimeClock())
        guard let staleDuration = RecordingClock.keepAliveStaleDuration(
            now: nowHost,
            lastEmitHostTime: lastEmitHostTime,
            lastEmittedVideoPTS: lastEmittedVideoPTS
        ) else { return false }

        // Compose with peek-only access to the cached source frames —
        // cameraOnly uses `lastPoppedCameraFrame` rather than touching
        // the FIFO. The source mode determines content; freshness is
        // irrelevant since the synthetic PTS doesn't reference
        // capturePTS.
        let composedResult: Result<CVPixelBuffer, CompositionError>?
        let compositeStart = Date()
        switch mode {
        case .screenOnly:
            guard let screen = latestScreenFrame else { return false }
            composedResult = await composition.compositeFrame(
                screenBuffer: screen.pixelBuffer,
                cameraBuffer: nil,
                mode: .screenOnly
            )
        case .screenAndCamera:
            guard let screen = latestScreenFrame else { return false }
            composedResult = await compositeScreenWithPiP(screen: screen, camera: pipCameraFrame)
        case .cameraOnly:
            guard let last = lastPoppedCameraFrame else { return false }
            composedResult = await composition.compositeFrame(
                screenBuffer: nil,
                cameraBuffer: last.pixelBuffer,
                mode: .cameraOnly
            )
        }
        let compositeS = -compositeStart.timeIntervalSinceNow

        guard let result = composedResult,
              case let .success(buffer) = result
        else {
            return false
        }

        // Synthetic wall-clock-anchored PTS: `nowHost` stands in for the
        // source capture time the real path would use.
        let elapsedLogical = RecordingClock.logicalPTS(
            capturePTS: nowHost,
            start: start,
            pauseAccumulator: pauseAccumulator
        )
        guard elapsedLogical >= .zero else { return false }
        let pts = RecordingClock.encoderPTS(logical: elapsedLogical)

        // Encoder monotonicity safety net. Host time only advances, so
        // this should always pass in practice — defensive only.
        if RecordingClock.breaksMonotonicity(pts: pts, lastEmittedVideoPTS: lastEmittedVideoPTS) {
            return false
        }

        guard let outputSample = createSampleBuffer(
            from: buffer,
            pts: pts,
            duration: frameDuration
        ) else {
            return false
        }

        lastEmittedVideoPTS = pts
        lastEmitHostTime = nowHost
        // NOTE: lastEmittedSourcePTS deliberately unchanged.
        diagnostics.keepAliveEmits += 1

        // One timeline event per static run.
        if !keepAliveEventFiredForCurrentStaleRun {
            keepAliveEventFiredForCurrentStaleRun = true
            timeline.recordKeepaliveEmitted(
                staleDurationSeconds: staleDuration,
                t: logicalElapsedSeconds()
            )
        }

        // Trace row. `sourcePTS = nil` flags this as synthetic.
        let host = logicalElapsedSeconds()
        let entry = MetronomeTickEntry(
            iter: iterIdx,
            emittedTickIdx: metronomeTickIdx,
            hostT: host,
            queueDepthBefore: cameraFrameQueue.count,
            cameraBranch: CompositeBranch.keepalive.rawValue,
            sourcePTS: nil,
            elapsedLogical: elapsedLogical.seconds,
            emitPTS: elapsedLogical.seconds,
            lastEmitPTS: lastEmitLogical,
            compositeS: compositeS,
            action: MetronomeTickAction.keepalive.rawValue,
            driftS: 0,
            sleepS: 0
        )
        diagnostics.pushTick(entry)

        await writer.appendVideo(outputSample)
        return true
    }
}
