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

    /// Per-mode composite result. Each `composite<Mode>` helper returns one
    /// of these so `compositeForCurrentMode` can assemble the final decision
    /// without growing past the per-function-body line cap.
    struct ModeCompositeStep {
        let result: Result<CVPixelBuffer, CompositionError>?
        let sourcePTS: CMTime
        let branch: String
        let compositeS: Double
    }

    /// Acquire source frames for the current mode, composite them, and return
    /// a decision record. Always returns — the caller inspects `output`,
    /// `compositionFailed`, and `branch` to decide whether to emit.
    ///
    /// Source-PTS freshness is enforced in the per-mode helpers: a tick whose
    /// source frame is not strictly newer than `lastEmittedSourcePTS` returns
    /// with `branch = "skipStale"` and no composition is performed. This
    /// replaces the encoder-level monotonicity rejection that previously
    /// fired on every static-screen tick and on every cameraOnly tick where
    /// the metronome over-ran the camera's delivery rate.
    private func compositeForCurrentMode() async -> CompositeDecision {
        let queueDepthBefore = cameraFrameQueue.count
        let step: ModeCompositeStep
        switch mode {
        case .screenOnly:
            step = await compositeScreenOnly()
        case .screenAndCamera:
            step = await compositeScreenAndCamera()
        case .cameraOnly:
            step = await compositeCameraOnly(queueDepthBefore: queueDepthBefore)
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
            if decision.branch == "n/a" { decision.branch = "noSource" }
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
            return ModeCompositeStep(result: nil, sourcePTS: .invalid, branch: "noSource", compositeS: 0)
        }
        if isStaleSource(screen.capturePTS) {
            return ModeCompositeStep(result: nil, sourcePTS: screen.capturePTS, branch: "skipStale", compositeS: 0)
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
            branch: "n/a",
            compositeS: -startedAt.timeIntervalSinceNow
        )
    }

    private func compositeScreenAndCamera() async -> ModeCompositeStep {
        guard let screen = latestScreenFrame else {
            return ModeCompositeStep(result: nil, sourcePTS: .invalid, branch: "noSource", compositeS: 0)
        }
        // Screen drives timing in screenAndCamera mode — it's the primary
        // content, camera is just a PiP overlay. Using screen PTS ensures
        // the output advances at the screen's delivery rate and lets a
        // static screen short-circuit through the stale-source check.
        if isStaleSource(screen.capturePTS) {
            return ModeCompositeStep(result: nil, sourcePTS: screen.capturePTS, branch: "skipStale", compositeS: 0)
        }
        let camera = cameraFrameQueue.last
        let cameraAvailable = camera != nil
            && !activeSourceWarnings.contains(.cameraFailed)
            && !activeSourceWarnings.contains(.cameraStale)
        let startedAt = Date()
        let result: Result<CVPixelBuffer, CompositionError>?
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
        return ModeCompositeStep(
            result: result,
            sourcePTS: screen.capturePTS,
            branch: "n/a",
            compositeS: -startedAt.timeIntervalSinceNow
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
            return ModeCompositeStep(result: nil, sourcePTS: .invalid, branch: "noSource", compositeS: 0)
        }
        let popped = cameraFrameQueue.removeFirst()
        lastPoppedCameraFrame = popped
        if isStaleSource(popped.capturePTS) {
            // Pause/resume drop-through (camera frames captured during a
            // pause survive in the FIFO past the drain on a tight race) or
            // mode switch into cameraOnly (FIFO inherits stale frames from
            // screen-mode emits). Drop silently and wait for the next tick.
            return ModeCompositeStep(result: nil, sourcePTS: popped.capturePTS, branch: "skipStale", compositeS: 0)
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
            branch: "pop",
            compositeS: -startedAt.timeIntervalSinceNow
        )
    }

    /// True when the source's capturePTS is not strictly newer than what
    /// we last emitted. Used by the per-mode branches of
    /// `compositeForCurrentMode` to skip a tick before spending GPU time
    /// compositing content the encoder would only reject downstream.
    private func isStaleSource(_ capturePTS: CMTime) -> Bool {
        guard lastEmittedSourcePTS.isValid else { return false }
        return capturePTS <= lastEmittedSourcePTS
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
                action: MetronomeTickAction.notRecording,
                decision: nil,
                ptsLogical: nil,
                lastEmitLogical: nil
            )
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
            return await handleEmptyComposite(
                iterIdx: iterIdx,
                decision: decision,
                start: start,
                lastEmitLogical: lastEmitLogical
            )
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
            handleMonotonicityRejection(
                iterIdx: iterIdx,
                pts: pts,
                decision: decision,
                elapsedLogical: elapsedLogical,
                lastEmitLogical: lastEmitLogical
            )
            return false
        }
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
                action: MetronomeTickAction.rejectSampleBuild,
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
        if decision.branch == "skipStale" {
            // Phase 3: in a long static run, emit a synthetic-PTS repeat
            // of the last cached source so AVAssetWriter's segment cutter
            // doesn't see >4s of dead air.
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
                action: MetronomeTickAction.skipStale,
                decision: decision,
                ptsLogical: nil,
                lastEmitLogical: lastEmitLogical
            )
        } else {
            diagnostics.noSourceTicks += 1
            recordTickRejection(
                iterIdx: iterIdx,
                action: MetronomeTickAction.noSource,
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
                branch: decision.branch,
                t: logicalElapsedSeconds()
            )
        } else if diagnostics.rejectMonotonicity == Self.monoRejectEventCap + 1 {
            timeline.recordMonotonicityRejectedSuppressed(
                cap: Self.monoRejectEventCap,
                branch: decision.branch,
                t: logicalElapsedSeconds()
            )
        }
        recordTickRejection(
            iterIdx: iterIdx,
            action: MetronomeTickAction.rejectMonotonicity,
            decision: decision,
            ptsLogical: elapsedLogical.seconds,
            lastEmitLogical: lastEmitLogical
        )
    }

    /// Phase 3: emit a synthetic-PTS repeat of the last cached source
    /// frame during a long static-source run. Called from
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
    private func tryEmitKeepAlive(
        iterIdx: Int64,
        start: CMTime,
        lastEmitLogical: Double?
    ) async -> Bool {
        guard lastEmitHostTime.isValid else { return false }
        let nowHost = CMClockGetTime(CMClockGetHostTimeClock())
        let staleDuration = (nowHost - lastEmitHostTime).seconds
        guard staleDuration >= Self.keepAliveThresholdSeconds else { return false }

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
            let camera = cameraFrameQueue.last
            let cameraAvailable = camera != nil
                && !activeSourceWarnings.contains(.cameraFailed)
                && !activeSourceWarnings.contains(.cameraStale)
            if cameraAvailable, let camera {
                composedResult = await composition.compositeFrame(
                    screenBuffer: screen.pixelBuffer,
                    cameraBuffer: camera.pixelBuffer,
                    mode: .screenAndCamera,
                    pipPosition: pipPosition
                )
            } else {
                composedResult = await composition.compositeFrame(
                    screenBuffer: screen.pixelBuffer,
                    cameraBuffer: nil,
                    mode: .screenOnly
                )
            }
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

        // Synthetic wall-clock-anchored PTS.
        let elapsedLogical = (nowHost - start) - pauseAccumulator
        guard elapsedLogical >= .zero else { return false }
        let pts = TimestampAdjuster.defaultPrimingOffset + elapsedLogical

        // Encoder monotonicity safety net. Host time only advances, so
        // this should always pass in practice — defensive only.
        if lastEmittedVideoPTS.isValid, pts <= lastEmittedVideoPTS {
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
            cameraBranch: "keepalive",
            sourcePTS: nil,
            elapsedLogical: elapsedLogical.seconds,
            emitPTS: elapsedLogical.seconds,
            lastEmitPTS: lastEmitLogical,
            compositeS: compositeS,
            action: MetronomeTickAction.keepalive,
            driftS: 0,
            sleepS: 0
        )
        diagnostics.pushTick(entry)

        await writer.appendVideo(outputSample)
        return true
    }
}
