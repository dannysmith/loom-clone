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

        // Diagnostics: record screen frame arrival.
        recordScreenFrameForDiagnostics(capturePTS: capturePTS)

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
        var causedEviction = false
        if cameraFrameQueue.count > Self.cameraFrameQueueCapacity {
            cameraFrameQueue.removeFirst()
            causedEviction = true
            diagnostics.cameraFramesEvicted += 1
        }

        // Diagnostics: record camera frame arrival (after queue update so
        // queueDepthAfter reflects what compositeForCurrentMode will see).
        recordCameraFrameForDiagnostics(capturePTS: capturePTS, causedEviction: causedEviction)

        if let cameraRawWriter,
           let retimed = retimedSampleForRawWriter(sampleBuffer)
        {
            await cameraRawWriter.append(retimed)
        }
    }

    /// Audio samples go to the HLS writer and a raw writer. When
    /// `sharedSessionAudioActive` is true this is called from the camera's
    /// shared session and the raw copy goes to camera.mp4's audio track.
    /// Otherwise it's called from the standalone mic and the raw copy goes
    /// to audio.m4a.
    ///
    /// All retiming happens here against the actor's `pauseAccumulator` so
    /// the writer is a pure sink. The HLS path adds the AAC priming offset;
    /// the raw path doesn't (priming is an HLS-only concern).
    func handleAudioSample(_ sampleBuffer: CMSampleBuffer) async {
        markAudioArrived()
        markAudioSampleReceived()
        diagnostics.audioSamplesReceived += 1
        guard isRecording else { return }
        guard let startTime = recordingStartTime else { return }

        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard originalPTS.isValid else { return }
        let relativePTS = originalPTS - startTime

        guard relativePTS >= .zero else { return }

        let duration = CMSampleBufferGetDuration(sampleBuffer)
        let logicalPTS = relativePTS - pauseAccumulator

        // HLS path: skip while paused. The writer also guards isPaused as
        // defence-in-depth, but short-circuiting here avoids an unnecessary
        // sample buffer copy.
        if pauseStartHostTime == nil, logicalPTS >= .zero {
            let hlsPTS = TimestampAdjuster.defaultPrimingOffset + logicalPTS
            if let hlsOut = retimedCopy(of: sampleBuffer, pts: hlsPTS, duration: duration, label: "hls audio") {
                await writer.appendAudio(hlsOut)
            }
        }

        // Raw audio path: routes to camera.mp4 audio when shared session is
        // active, or audio.m4a when the standalone mic feeds the HLS writer.
        if pauseStartHostTime == nil, logicalPTS >= .zero {
            if let rawOut = retimedCopy(of: sampleBuffer, pts: logicalPTS, duration: duration, label: "raw audio") {
                if sharedSessionAudioActive {
                    await cameraRawWriter?.appendAudio(rawOut)
                } else {
                    await audioRawWriter?.append(rawOut)
                }
            }
        }
    }

    /// Wrap CMSampleBufferCreateCopyWithNewTiming so failures are logged
    /// rather than silently dropped. The OSStatus is surfaced as a
    /// `[health]` log line with the call's `label` for diagnosis;
    /// callers receive `nil` and skip the append.
    private func retimedCopy(
        of sampleBuffer: CMSampleBuffer,
        pts: CMTime,
        duration: CMTime,
        label: String
    ) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &out
        )
        guard status == noErr else {
            Log.health.log("CMSampleBufferCreateCopyWithNewTiming failed (\(label)): status=\(status)")
            return nil
        }
        return out
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
        markAudioArrived()
        markAudioSampleReceived()
        guard let audioRawWriter,
              let retimed = retimedSampleForRawWriter(sampleBuffer) else { return }
        await audioRawWriter.append(retimed)
    }

    // MARK: - Metronome Frame Emission

    /// Decision record for one tick's composite-for-mode call. Captured for
    /// diagnostics so we can correlate the branch taken (pop / repeat / no
    /// source) with whether the subsequent emit succeeded.
    struct CompositeDecision {
        var output: CVPixelBuffer?
        var sourcePTS: CMTime
        var branch: String // "pop" | "repeat" | "noSource" | "n/a"
        var queueDepthBefore: Int
        var compositeS: Double
        var compositionFailed: Bool
    }

    /// Acquire source frames for the current mode, composite them, and return
    /// a decision record. Always returns — the caller inspects `output` and
    /// `compositionFailed` to decide whether to emit.
    private func compositeForCurrentMode() async -> CompositeDecision {
        var decision = CompositeDecision(
            output: nil,
            sourcePTS: .invalid,
            branch: "n/a",
            queueDepthBefore: cameraFrameQueue.count,
            compositeS: 0,
            compositionFailed: false
        )

        let result: Result<CVPixelBuffer, CompositionError>?
        switch mode {
        case .screenOnly:
            guard let screen = latestScreenFrame else {
                decision.branch = "noSource"
                return decision
            }
            decision.sourcePTS = screen.capturePTS
            let startedAt = Date()
            result = await composition.compositeFrame(
                screenBuffer: screen.pixelBuffer,
                cameraBuffer: nil,
                mode: .screenOnly
            )
            decision.compositeS = -startedAt.timeIntervalSinceNow
        case .screenAndCamera:
            guard let screen = latestScreenFrame else {
                decision.branch = "noSource"
                return decision
            }
            let camera = cameraFrameQueue.last
            // Screen drives timing in screenAndCamera mode — it's the
            // primary content, camera is just a PiP overlay. Using
            // screen PTS ensures the output advances at the screen's
            // delivery rate (60fps when configured). Using camera PTS
            // would throttle to the camera's rate when it's slower
            // (e.g. 30fps camera + 60fps screen), causing the
            // monotonicity check to reject every other tick.
            decision.sourcePTS = screen.capturePTS
            let cameraAvailable = camera != nil
                && !activeSourceWarnings.contains(.cameraFailed)
                && !activeSourceWarnings.contains(.cameraStale)
            let startedAt = Date()
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
            decision.compositeS = -startedAt.timeIntervalSinceNow
        case .cameraOnly:
            // Pop a fresh frame if available; otherwise re-emit the most
            // recently popped frame (peek-with-repeat). This handles the
            // case where the metronome ticks at 60fps but the camera only
            // delivers at 30fps — every other tick has an empty FIFO.
            // Repeated frames compress to nearly nothing in H.264.
            let cameraBuffer: CVPixelBuffer
            if !cameraFrameQueue.isEmpty {
                let popped = cameraFrameQueue.removeFirst()
                lastPoppedCameraFrame = popped
                cameraBuffer = popped.pixelBuffer
                decision.sourcePTS = popped.capturePTS
                decision.branch = "pop"
                diagnostics.cameraOnlyPopBranch += 1
                MetronomeDiagnostics.bumpHistogram(
                    &diagnostics.queueDepthHist,
                    edges: MetronomeDiagnostics.queueDepthEdges,
                    value: decision.queueDepthBefore
                )
            } else if let last = lastPoppedCameraFrame {
                cameraBuffer = last.pixelBuffer
                // Use the current host clock for repeated frames so the
                // PTS advances monotonically. The original capturePTS is
                // stale (same as the previous tick's), which would fail
                // the monotonicity guard and silently drop the frame.
                decision.sourcePTS = CMClockGetTime(CMClockGetHostTimeClock())
                decision.branch = "repeat"
                diagnostics.cameraOnlyRepeatBranch += 1
                if verboseDiagnostics {
                    print(String(
                        format: "[diag] peek-with-repeat fire #%d at hostT=%.4f (queue=0)",
                        diagnostics.cameraOnlyRepeatBranch,
                        logicalElapsedSeconds()
                    ))
                }
            } else {
                decision.branch = "noSource"
                diagnostics.cameraOnlyNoSourceBranch += 1
                return decision
            }
            let startedAt = Date()
            result = await composition.compositeFrame(
                screenBuffer: nil,
                cameraBuffer: cameraBuffer,
                mode: .cameraOnly
            )
            decision.compositeS = -startedAt.timeIntervalSinceNow
        }

        MetronomeDiagnostics.bumpHistogram(
            &diagnostics.compositeHist,
            edges: MetronomeDiagnostics.compositeEdgesMs,
            valueMs: decision.compositeS * 1000
        )

        guard let result else {
            decision.branch = decision.branch == "n/a" ? "noSource" : decision.branch
            return decision
        }
        switch result {
        case let .success(buffer):
            decision.output = buffer
        case let .failure(compositionError):
            decision.compositionFailed = true
            diagnostics.compositionFailures += 1
            await handleCompositionFailure(compositionError)
        }
        return decision
    }

    /// Compose and append a single metronome frame. Returns true if a frame
    /// was actually appended (source available, composition succeeded, PTS
    /// strictly monotonic).
    ///
    /// `iterIdx` is the loop iteration counter, used in the diagnostic trace
    /// row so we can correlate this row with the metronome loop's idea of
    /// "which tick this is" even when the tick was rejected.
    func emitMetronomeFrame(iterIdx: Int64 = 0) async -> Bool {
        // Bail immediately if the stop flow has already fired. The metronome
        // loop's `while` guard may have passed before `isRecording` flipped,
        // but by the time we enter here the stop is in progress — submitting
        // a render task now just races against teardown.
        guard isRecording else {
            recordTickRejection(iterIdx: iterIdx, action: MetronomeTickAction.notRecording, decision: nil, ptsLogical: nil, lastEmitLogical: nil)
            return false
        }
        guard let start = recordingStartTime else {
            recordTickRejection(iterIdx: iterIdx, action: MetronomeTickAction.noStart, decision: nil, ptsLogical: nil, lastEmitLogical: nil)
            return false
        }

        // `sourcePTS` is the capture time of the visible content. We stamp
        // the emitted video frame with this (not wall-clock-now) so audio
        // and video share the same notion of "when the content was at the
        // hardware."
        let decision = await compositeForCurrentMode()

        // Drift / sleep are bookkept by the outer loop; this rejects the
        // various ways `emitMetronomeFrame` can fail to produce a sample.
        let lastEmitLogical: Double? = lastEmittedVideoPTS.isValid
            ? (lastEmittedVideoPTS - TimestampAdjuster.defaultPrimingOffset).seconds
            : nil

        if decision.compositionFailed {
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.compositionFail,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
        guard let output = decision.output else {
            diagnostics.noSourceTicks += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.noSource,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
        let sourcePTS = decision.sourcePTS

        guard sourcePTS.isValid else {
            diagnostics.rejectInvalidPTS += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.rejectInvalidPTS,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
        let elapsedLogical = (sourcePTS - start) - pauseAccumulator
        guard elapsedLogical >= .zero else {
            diagnostics.rejectNegElapsed += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.rejectNegElapsed,
                decision: decision,
                ptsLogical: elapsedLogical.seconds,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
        let pts = TimestampAdjuster.defaultPrimingOffset + elapsedLogical

        if lastEmittedVideoPTS.isValid, pts <= lastEmittedVideoPTS {
            diagnostics.rejectMonotonicity += 1
            let deltaMs = (lastEmittedVideoPTS - pts).seconds * 1000
            MetronomeDiagnostics.bumpHistogram(
                &diagnostics.monoRejectHist,
                edges: MetronomeDiagnostics.monoRejectEdgesMs,
                valueMs: deltaMs
            )
            if verboseDiagnostics {
                print(String(
                    format: "[diag] MONO REJECT #%d branch=%@ delta=%.3fms sourcePTS=%.4f lastEmit=%.4f",
                    diagnostics.rejectMonotonicity,
                    decision.branch,
                    deltaMs,
                    elapsedLogical.seconds,
                    lastEmitLogical ?? -1
                ))
            }
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.rejectMonotonicity,
                decision: decision,
                ptsLogical: elapsedLogical.seconds,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
        lastEmittedVideoPTS = pts

        guard let outputSample = createSampleBuffer(
            from: output,
            pts: pts,
            duration: frameDuration
        ) else {
            diagnostics.rejectSampleBuild += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.rejectSampleBuild,
                decision: decision,
                ptsLogical: elapsedLogical.seconds,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }

        // Successful emit. Record cadence + trace row.
        let logicalSec = elapsedLogical.seconds
        if lastEmitLogicalSeconds >= 0 {
            let gapMs = (logicalSec - lastEmitLogicalSeconds) * 1000
            MetronomeDiagnostics.bumpHistogram(
                &diagnostics.emitGapHist,
                edges: MetronomeDiagnostics.emitGapEdgesMs,
                valueMs: gapMs
            )
        }
        lastEmitLogicalSeconds = logicalSec
        diagnostics.emitOK += 1
        recordTickRow(
            iterIdx: iterIdx,
            decision: decision,
            sourceLogical: (sourcePTS - start).seconds,
            elapsedLogical: logicalSec,
            emitLogical: logicalSec,
            lastEmitLogical: lastEmitLogical,
            action: MetronomeTickAction.emit
        )

        await writer.appendVideo(outputSample)
        return true
    }

    /// Compact trace-row writer for the non-rejection (emit) path.
    private func recordTickRow(
        iterIdx: Int64,
        decision: CompositeDecision,
        sourceLogical: Double?,
        elapsedLogical: Double?,
        emitLogical: Double?,
        lastEmitLogical: Double?,
        action: String
    ) {
        let host = logicalElapsedSeconds()
        let entry = MetronomeTickEntry(
            iter: iterIdx,
            emittedTickIdx: metronomeTickIdx,
            hostT: host,
            queueDepthBefore: decision.queueDepthBefore,
            cameraBranch: decision.branch,
            sourcePTS: sourceLogical,
            elapsedLogical: elapsedLogical,
            emitPTS: emitLogical,
            lastEmitPTS: lastEmitLogical,
            compositeS: decision.compositeS,
            action: action,
            driftS: 0, // filled by metronomeLoop after the call if desired
            sleepS: 0
        )
        diagnostics.pushTick(entry)
    }

    /// Trace-row writer for rejection paths. `decision` may be nil if we
    /// rejected before composition ran (e.g. notRecording / noStart).
    private func recordTickRejection(
        iterIdx: Int64,
        action: String,
        decision: CompositeDecision?,
        ptsLogical: Double?,
        lastEmitLogical: Double?
    ) {
        let host = logicalElapsedSeconds()
        let entry = MetronomeTickEntry(
            iter: iterIdx,
            emittedTickIdx: metronomeTickIdx,
            hostT: host,
            queueDepthBefore: decision?.queueDepthBefore ?? cameraFrameQueue.count,
            cameraBranch: decision?.branch ?? "n/a",
            sourcePTS: decision.flatMap { d in d.sourcePTS.isValid ? d.sourcePTS.seconds : nil },
            elapsedLogical: ptsLogical,
            emitPTS: nil,
            lastEmitPTS: lastEmitLogical,
            compositeS: decision?.compositeS ?? 0,
            action: action,
            driftS: 0,
            sleepS: 0
        )
        diagnostics.pushTick(entry)
    }

    // MARK: - Source Frame Diagnostics

    /// Record per-camera-frame timing details for the first N frames, plus
    /// aggregate histogram for all frames. Called from `handleCameraFrame`
    /// after the queue update.
    func recordCameraFrameForDiagnostics(capturePTS: CMTime, causedEviction: Bool) {
        diagnostics.cameraFramesReceived += 1
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let logicalHost: Double = recordingStartTime.map { (hostNow - $0).seconds } ?? -1
        let logicalCap: Double = recordingStartTime.map { (capturePTS - $0).seconds } ?? -1
        let captureLagS = (hostNow - capturePTS).seconds

        // Interval-from-previous histogram (in seconds, converted to ms).
        var gapMs: Double?
        if lastCameraCapturePTS.isValid {
            let g = (capturePTS - lastCameraCapturePTS).seconds
            gapMs = g * 1000
            MetronomeDiagnostics.bumpHistogram(
                &diagnostics.cameraIntervalHist,
                edges: MetronomeDiagnostics.cameraIntervalEdgesMs,
                valueMs: g * 1000
            )
        }
        lastCameraCapturePTS = capturePTS

        // Capture-lag histogram.
        if captureLagS >= 0 {
            MetronomeDiagnostics.bumpHistogram(
                &diagnostics.captureLagHist,
                edges: MetronomeDiagnostics.captureLagEdgesMs,
                valueMs: captureLagS * 1000
            )
        }

        // First-N detailed trace.
        if diagnostics.cameraTrace.count < MetronomeDiagnostics.cameraTraceCapacity {
            let entry = CameraFrameTraceEntry(
                n: diagnostics.cameraFramesReceived,
                hostT: logicalHost,
                capturePTS: logicalCap,
                captureLagS: captureLagS,
                gapFromPreviousS: gapMs.map { $0 / 1000 },
                queueDepthAfter: cameraFrameQueue.count,
                causedEviction: causedEviction
            )
            diagnostics.pushCameraFrame(entry)
        }
    }

    /// Same for screen frames. Lighter — we don't need to confirm screen is
    /// well-behaved, but it's useful to have parity for cross-source
    /// comparison.
    func recordScreenFrameForDiagnostics(capturePTS: CMTime) {
        diagnostics.screenFramesReceived += 1
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let logicalHost: Double = recordingStartTime.map { (hostNow - $0).seconds } ?? -1
        let logicalCap: Double = recordingStartTime.map { (capturePTS - $0).seconds } ?? -1
        let captureLagS = (hostNow - capturePTS).seconds

        var gapMs: Double?
        if lastScreenCapturePTS.isValid {
            let g = (capturePTS - lastScreenCapturePTS).seconds
            gapMs = g * 1000
            MetronomeDiagnostics.bumpHistogram(
                &diagnostics.screenIntervalHist,
                edges: MetronomeDiagnostics.screenIntervalEdgesMs,
                valueMs: g * 1000
            )
        }
        lastScreenCapturePTS = capturePTS

        if diagnostics.screenTrace.count < MetronomeDiagnostics.screenTraceCapacity {
            let entry = ScreenFrameTraceEntry(
                n: diagnostics.screenFramesReceived,
                hostT: logicalHost,
                capturePTS: logicalCap,
                captureLagS: captureLagS,
                gapFromPreviousS: gapMs.map { $0 / 1000 }
            )
            diagnostics.pushScreenFrame(entry)
        }
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
