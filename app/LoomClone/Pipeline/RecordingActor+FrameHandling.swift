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
            // Defence-in-depth (#30): a single backward / duplicate PTS makes
            // AVAssetWriter reject the sample, fail the writer, and leave an
            // unplayable camera.mp4 (`-16364`). Drop any frame whose retimed PTS
            // doesn't strictly advance past the last appended one, so a corrupt
            // feed leaves the raw master truncated-but-playable instead of dead.
            // The rate-unlock (no fabricated frames) means this rarely fires; we
            // do NOT repair or re-stamp PTS — that would be its own desync.
            let pts = CMSampleBufferGetPresentationTimeStamp(retimed)
            if !lastRawCameraAppendedPTS.isValid || pts > lastRawCameraAppendedPTS {
                lastRawCameraAppendedPTS = pts
                await cameraRawWriter.append(retimed)
            } else {
                diagnostics.cameraRawFramesSkipped += 1
            }
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
        guard (originalPTS - startTime) >= .zero else { return }
        // Captured during a pause that has since ended: its logical PTS would
        // land behind the last pre-pause sample now the pause is folded into
        // the accumulator, and a backward PTS fails the writer input outright.
        guard !RecordingClock.predatesResume(
            capturePTS: originalPTS,
            lastResumeHostTime: lastResumeHostTime
        ) else { return }

        let duration = CMSampleBufferGetDuration(sampleBuffer)
        let logicalPTS = RecordingClock.logicalPTS(
            capturePTS: originalPTS,
            start: startTime,
            pauseAccumulator: pauseAccumulator
        )

        // HLS path: skip while paused. The writer also guards isPaused as
        // defence-in-depth, but short-circuiting here avoids an unnecessary
        // sample buffer copy.
        if pauseStartHostTime == nil, logicalPTS >= .zero {
            let hlsPTS = RecordingClock.encoderPTS(logical: logicalPTS)
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

    /// Retime a sample buffer onto the recording's logical timeline so it
    /// can be appended to a raw writer. Returns nil if the recording isn't
    /// committed yet, the recording is paused, or the sample was captured
    /// before the recording start anchor or the most recent resume.
    ///
    /// Raw writers get the logical PTS with no priming offset — priming is an
    /// HLS-only concern.
    func retimedSampleForRawWriter(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard isRecording,
              pauseStartHostTime == nil,
              let startTime = recordingStartTime else { return nil }

        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard originalPTS.isValid else { return nil }
        guard !RecordingClock.predatesResume(
            capturePTS: originalPTS,
            lastResumeHostTime: lastResumeHostTime
        ) else { return nil }

        let relPTS = RecordingClock.logicalPTS(
            capturePTS: originalPTS,
            start: startTime,
            pauseAccumulator: pauseAccumulator
        )
        guard relPTS >= .zero else { return nil }

        return retimedCopy(
            of: sampleBuffer,
            pts: relPTS,
            duration: CMSampleBufferGetDuration(sampleBuffer),
            label: "raw writer"
        )
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
        var branch: CompositeBranch
        var queueDepthBefore: Int
        var compositeS: Double
        var compositionFailed: Bool
    }

    /// Per-mode composite result. Each `composite<Mode>` helper returns one
    /// of these so `compositeForCurrentMode` can assemble the final decision
    /// without growing past the per-function-body line cap.
    struct ModeCompositeStep {
        let result: Result<CVPixelBuffer, CompositionError>?
        let sourcePTS: CMTime
        let branch: CompositeBranch
        let compositeS: Double
    }

    /// Acquire source frames for the current mode, composite them, and return
    /// a decision record. Always returns — the caller inspects `output`,
    /// `compositionFailed`, and `branch` to decide whether to emit.
    ///
    /// Source-PTS freshness is enforced in the per-mode helpers: a tick whose
    /// source frame is not strictly newer than `lastEmittedSourcePTS` returns
    /// with `branch = .skipStale` and no composition is performed. This
    /// replaces the encoder-level monotonicity rejection that previously
    /// fired on every static-screen tick and on every cameraOnly tick where
    /// the metronome over-ran the camera's delivery rate.
    private func compositeForCurrentMode() async -> CompositeDecision {
        let queueDepthBefore = cameraFrameQueue.count
        let step: ModeCompositeStep = switch mode {
        case .screenOnly:
            await compositeScreenOnly()
        case .screenAndCamera:
            await compositeScreenAndCamera()
        case .cameraOnly:
            await compositeCameraOnly(queueDepthBefore: queueDepthBefore)
        }

        var decision = CompositeDecision(
            output: nil,
            sourcePTS: step.sourcePTS,
            branch: step.branch,
            queueDepthBefore: queueDepthBefore,
            compositeS: step.compositeS,
            compositionFailed: false
        )

        MetronomeDiagnostics.bumpHistogram(
            &diagnostics.compositeHist,
            edges: MetronomeDiagnostics.compositeEdgesMs,
            valueMs: decision.compositeS * 1000
        )

        guard let result = step.result else {
            if decision.branch == .notApplicable { decision.branch = .noSource }
            return decision
        }
        switch result {
        case let .success(buffer):
            decision.output = buffer
        case let .failure(compositionError):
            decision.compositionFailed = true
            // Counter incremented inside handleCompositionFailure so it
            // skips the stop-time race that's benign (final metronome tick
            // racing teardown). Otherwise `compFails=1` shows up on every
            // recording even though nothing actually failed.
            await handleCompositionFailure(compositionError)
        }
        return decision
    }

    private func compositeScreenOnly() async -> ModeCompositeStep {
        guard let screen = latestScreenFrame else {
            return ModeCompositeStep(result: nil, sourcePTS: .invalid, branch: .noSource, compositeS: 0)
        }
        if isStaleSource(screen.capturePTS) {
            return ModeCompositeStep(result: nil, sourcePTS: screen.capturePTS, branch: .skipStale, compositeS: 0)
        }
        let startedAt = Date()
        let result = await composition.compositeFrame(
            screenBuffer: screen.pixelBuffer,
            cameraBuffer: nil,
            mode: .screenOnly
        )
        return ModeCompositeStep(
            result: result,
            sourcePTS: screen.capturePTS,
            branch: .notApplicable,
            compositeS: -startedAt.timeIntervalSinceNow
        )
    }

    private func compositeScreenAndCamera() async -> ModeCompositeStep {
        guard let screen = latestScreenFrame else {
            return ModeCompositeStep(result: nil, sourcePTS: .invalid, branch: .noSource, compositeS: 0)
        }
        // Timing follows whichever of the two composited sources captured
        // most recently. The screen is the primary content and usually wins
        // — but when nothing on the display is changing, the camera's PiP is
        // the only moving content in the frame. Without it the whole
        // composite, face included, holds at the keep-alive's 1fps until the
        // display next changes.
        let camera = pipCameraFrame
        let sourcePTS = RecordingClock.newestSourcePTS(
            primary: screen.capturePTS,
            secondary: camera?.capturePTS,
            now: CMClockGetTime(CMClockGetHostTimeClock())
        )
        if isStaleSource(sourcePTS) {
            return ModeCompositeStep(result: nil, sourcePTS: sourcePTS, branch: .skipStale, compositeS: 0)
        }
        let startedAt = Date()
        let result = await compositeScreenWithPiP(screen: screen, camera: camera)
        return ModeCompositeStep(
            result: result,
            sourcePTS: sourcePTS,
            branch: .notApplicable,
            compositeS: -startedAt.timeIntervalSinceNow
        )
    }

    /// The most recent camera frame peeked (not popped) from the FIFO, or nil
    /// when the camera isn't fit to render. Resolved once per tick so the
    /// timing decision and the composite agree on what's in the frame.
    var pipCameraFrame: CachedFrame? {
        sourceHealth.cameraIsUnusable ? nil : cameraFrameQueue.last
    }

    /// Composite a screen frame with a camera frame as the PiP overlay,
    /// falling back to screen-only when there's no camera frame to use.
    /// Shared by the metronome's `screenAndCamera` branch and the keep-alive
    /// path, which must produce a visually identical frame.
    func compositeScreenWithPiP(
        screen: CachedFrame,
        camera: CachedFrame?
    ) async -> Result<CVPixelBuffer, CompositionError>? {
        guard let camera else {
            return await composition.compositeFrame(
                screenBuffer: screen.pixelBuffer,
                cameraBuffer: nil,
                mode: .screenOnly
            )
        }
        return await composition.compositeFrame(
            screenBuffer: screen.pixelBuffer,
            cameraBuffer: camera.pixelBuffer,
            mode: .screenAndCamera,
            pipPosition: pipPosition
        )
    }

    private func compositeCameraOnly(queueDepthBefore: Int) async -> ModeCompositeStep {
        // Pop the next camera frame if available. Output cadence tracks the
        // camera's actual delivery rate — empty ticks become no-ops rather
        // than synthesising host-clock PTS values (which was the bug where
        // synthetic PTS landed ahead of the next real frame's capturePTS,
        // causing the encoder to reject every newly-arrived real frame).
        guard !cameraFrameQueue.isEmpty else {
            diagnostics.cameraOnlyNoSourceBranch += 1
            return ModeCompositeStep(result: nil, sourcePTS: .invalid, branch: .noSource, compositeS: 0)
        }
        let popped = cameraFrameQueue.removeFirst()
        lastPoppedCameraFrame = popped
        if isStaleSource(popped.capturePTS) {
            // Pause/resume drop-through (camera frames captured during a
            // pause survive in the FIFO past the drain on a tight race) or
            // mode switch into cameraOnly (FIFO inherits stale frames from
            // screen-mode emits). Drop silently and wait for the next tick.
            return ModeCompositeStep(result: nil, sourcePTS: popped.capturePTS, branch: .skipStale, compositeS: 0)
        }
        diagnostics.cameraOnlyPopBranch += 1
        MetronomeDiagnostics.bumpHistogram(
            &diagnostics.queueDepthHist,
            edges: MetronomeDiagnostics.queueDepthEdges,
            value: queueDepthBefore
        )
        let startedAt = Date()
        let result = await composition.compositeFrame(
            screenBuffer: nil,
            cameraBuffer: popped.pixelBuffer,
            mode: .cameraOnly
        )
        return ModeCompositeStep(
            result: result,
            sourcePTS: popped.capturePTS,
            branch: .pop,
            compositeS: -startedAt.timeIntervalSinceNow
        )
    }

    /// True when the source's capturePTS can't produce an emittable frame —
    /// it predates the anchor, or it wouldn't advance past what we last
    /// emitted. Used by the per-mode branches of `compositeForCurrentMode` to
    /// skip a tick before spending GPU time compositing content the encoder
    /// would only reject downstream.
    private func isStaleSource(_ capturePTS: CMTime) -> Bool {
        guard let start = recordingStartTime else { return true }
        return RecordingClock.isStaleSource(
            capturePTS: capturePTS,
            lastEmittedSourcePTS: lastEmittedSourcePTS,
            lastEmittedVideoPTS: lastEmittedVideoPTS,
            start: start,
            pauseAccumulator: pauseAccumulator
        )
    }

    /// Compose and append a single metronome frame. Returns true if a frame
    /// was actually appended (source available, fresh, composition succeeded,
    /// PTS strictly monotonic).
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
            recordTickRejection(
                iterIdx: iterIdx,
                action: .notRecording,
                decision: nil,
                ptsLogical: nil,
                lastEmitLogical: nil
            )
            return false
        }
        guard let start = recordingStartTime else {
            recordTickRejection(iterIdx: iterIdx, action: .noStart, decision: nil, ptsLogical: nil, lastEmitLogical: nil)
            return false
        }

        // `sourcePTS` is the capture time of the visible content. We stamp
        // the emitted video frame with this (not wall-clock-now) so audio
        // and video share the same notion of "when the content was at the
        // hardware."
        let decision = await compositeForCurrentMode()

        // Drift / sleep are bookkept by the outer loop; this rejects the
        // various ways `emitMetronomeFrame` can fail to produce a sample.
        let lastEmitLogical = RecordingClock.logicalSeconds(fromEncoderPTS: lastEmittedVideoPTS)

        if decision.compositionFailed {
            recordTickRejection(
                iterIdx: iterIdx,
                action: .compositionFail,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
        guard let output = decision.output else {
            return await handleEmptyComposite(
                iterIdx: iterIdx,
                decision: decision,
                start: start,
                lastEmitLogical: lastEmitLogical
            )
        }
        let sourcePTS = decision.sourcePTS
        guard let timing = emitTiming(
            for: decision,
            iterIdx: iterIdx,
            start: start,
            lastEmitLogical: lastEmitLogical
        ) else { return false }
        let elapsedLogical = timing.logical
        let pts = timing.encoder

        lastEmittedVideoPTS = pts
        lastEmittedSourcePTS = sourcePTS
        lastEmitHostTime = CMClockGetTime(CMClockGetHostTimeClock())
        // Fresh source content ends any in-progress keep-alive run, so
        // the next static run will re-emit a `keepalive.emitted` event.
        keepAliveEventFiredForCurrentStaleRun = false

        guard let outputSample = createSampleBuffer(
            from: output,
            pts: pts,
            duration: frameDuration
        ) else {
            diagnostics.rejectSampleBuild += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: .rejectSampleBuild,
                decision: decision,
                ptsLogical: elapsedLogical.seconds,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }

        recordSuccessfulEmit(
            iterIdx: iterIdx,
            decision: decision,
            sourcePTS: sourcePTS,
            start: start,
            elapsedLogical: elapsedLogical,
            lastEmitLogical: lastEmitLogical
        )

        await writer.appendVideo(outputSample)
        return true
    }

    /// A tick's PTS in both domains: `logical` for the timeline and trace
    /// rows, `encoder` (logical + priming offset) for the HLS writer.
    private struct EmitTiming {
        let logical: CMTime
        let encoder: CMTime
    }

    /// Derive a tick's PTS from its composited source frame, or reject the
    /// tick. Returns nil — having already recorded which rejection it was —
    /// when the source PTS is invalid, predates the recording anchor, or
    /// would break strict monotonicity at the encoder.
    private func emitTiming(
        for decision: CompositeDecision,
        iterIdx: Int64,
        start: CMTime,
        lastEmitLogical: Double?
    ) -> EmitTiming? {
        guard decision.sourcePTS.isValid else {
            diagnostics.rejectInvalidPTS += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: .rejectInvalidPTS,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
            return nil
        }
        let logical = RecordingClock.logicalPTS(
            capturePTS: decision.sourcePTS,
            start: start,
            pauseAccumulator: pauseAccumulator
        )
        guard logical >= .zero else {
            diagnostics.rejectNegElapsed += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: .rejectNegElapsed,
                decision: decision,
                ptsLogical: logical.seconds,
                lastEmitLogical: lastEmitLogical
            )
            return nil
        }
        let encoder = RecordingClock.encoderPTS(logical: logical)
        guard !RecordingClock.breaksMonotonicity(pts: encoder, lastEmittedVideoPTS: lastEmittedVideoPTS) else {
            handleMonotonicityRejection(
                iterIdx: iterIdx,
                pts: encoder,
                decision: decision,
                elapsedLogical: logical,
                lastEmitLogical: lastEmitLogical
            )
            return nil
        }
        return EmitTiming(logical: logical, encoder: encoder)
    }

    /// Bookkeep a successful metronome emit: bump the inter-emit cadence
    /// histogram, advance the cadence anchor, and append a trace row.
    private func recordSuccessfulEmit(
        iterIdx: Int64,
        decision: CompositeDecision,
        sourcePTS: CMTime,
        start: CMTime,
        elapsedLogical: CMTime,
        lastEmitLogical: Double?
    ) {
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
    }

    /// Handle the no-composited-frame branches of `emitMetronomeFrame`.
    /// `skipStale` first tries a keep-alive emit; both branches fall back
    /// to a rejection trace row.
    private func handleEmptyComposite(
        iterIdx: Int64,
        decision: CompositeDecision,
        start: CMTime,
        lastEmitLogical: Double?
    ) async -> Bool {
        // Distinguish the two reasons so diagnostics can tell "static
        // screen / metronome over-ran camera" (skipStale, expected in
        // normal operation) from "no source ever arrived" (noSource,
        // real problem).
        if decision.branch == .skipStale {
            // Emit a synthetic-PTS repeat of the last cached source, so a
            // static run doesn't show AVAssetWriter's segment cutter >4s of
            // dead air — and so a recording that starts static still has a
            // picture from the first tick.
            if await tryEmitKeepAlive(
                iterIdx: iterIdx,
                start: start,
                lastEmitLogical: lastEmitLogical
            ) {
                return true
            }
            diagnostics.skipsStale += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: .skipStale,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
        } else {
            diagnostics.noSourceTicks += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: .noSource,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
        }
        return false
    }

    /// Encoder-level monotonicity safety net. Post task-21 Phases 1+2 this
    /// should never fire on the happy path — the source-PTS freshness check
    /// in `compositeForCurrentMode` is the primary defence. A fire here is a
    /// real bug; surface it on the timeline so it shows up in recording.json
    /// forensics.
    ///
    /// Timeline events are rate-limited to avoid ballooning recording.json
    /// under a regression scenario: first N fire normally, the (N+1)th fires
    /// a one-shot suppression sentinel, subsequent fires only update the
    /// aggregate counter + histogram (which already carry the full totals).
    private func handleMonotonicityRejection(
        iterIdx: Int64,
        pts: CMTime,
        decision: CompositeDecision,
        elapsedLogical: CMTime,
        lastEmitLogical: Double?
    ) {
        diagnostics.rejectMonotonicity += 1
        let deltaMs = (lastEmittedVideoPTS - pts).seconds * 1000
        MetronomeDiagnostics.bumpHistogram(
            &diagnostics.monoRejectHist,
            edges: MetronomeDiagnostics.monoRejectEdgesMs,
            valueMs: deltaMs
        )
        if diagnostics.rejectMonotonicity <= Self.monoRejectEventCap {
            timeline.recordMonotonicityRejected(
                deltaMs: deltaMs,
                branch: decision.branch.rawValue,
                t: logicalElapsedSeconds()
            )
        } else if diagnostics.rejectMonotonicity == Self.monoRejectEventCap + 1 {
            timeline.recordMonotonicityRejectedSuppressed(
                cap: Self.monoRejectEventCap,
                branch: decision.branch.rawValue,
                t: logicalElapsedSeconds()
            )
        }
        recordTickRejection(
            iterIdx: iterIdx,
            action: .rejectMonotonicity,
            decision: decision,
            ptsLogical: elapsedLogical.seconds,
            lastEmitLogical: lastEmitLogical
        )
    }
}
