import AVFoundation
import CoreMedia

extension RecordingActor {
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

    // MARK: - Tick Trace Rows

    /// Compact trace-row writer for the non-rejection (emit) path.
    func recordTickRow(
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
    func recordTickRejection(
        iterIdx: Int64,
        action: String,
        decision: CompositeDecision?,
        ptsLogical: Double?,
        lastEmitLogical: Double?
    ) {
        let host = logicalElapsedSeconds()
        let sourceRelative: Double? = decision.flatMap { d in
            guard d.sourcePTS.isValid, let start = recordingStartTime else { return nil }
            return (d.sourcePTS - start).seconds
        }
        let entry = MetronomeTickEntry(
            iter: iterIdx,
            emittedTickIdx: metronomeTickIdx,
            hostT: host,
            queueDepthBefore: decision?.queueDepthBefore ?? cameraFrameQueue.count,
            cameraBranch: decision?.branch ?? "n/a",
            sourcePTS: sourceRelative,
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
