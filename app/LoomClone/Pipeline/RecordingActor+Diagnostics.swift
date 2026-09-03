import CoreMedia
import Foundation

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

        // Live quality signal: feed the capture PTS into the cadence monitor
        // so the ~2Hz health timer (`checkQualityHealth`) can spot a
        // non-monotonic (CMIO-corrupt) camera timeline. `hostNow` is the
        // monotonic window clock — capture PTS is the thing being judged, so it
        // can't also time the window. Bump the forensic counter on a violation.
        if cameraCadenceMonitor.recordFrame(capturePTSSeconds: capturePTS.seconds, now: hostNow.seconds) {
            diagnostics.cameraNonMonotonicPTS += 1
        }

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
        action: MetronomeTickAction
    ) {
        let host = logicalElapsedSeconds()
        let entry = MetronomeTickEntry(
            iter: iterIdx,
            emittedTickIdx: metronomeTickIdx,
            hostT: host,
            queueDepthBefore: decision.queueDepthBefore,
            cameraBranch: decision.branch.rawValue,
            sourcePTS: sourceLogical,
            elapsedLogical: elapsedLogical,
            emitPTS: emitLogical,
            lastEmitPTS: lastEmitLogical,
            compositeS: decision.compositeS,
            action: action.rawValue,
            driftS: 0, // filled by metronomeLoop after the call if desired
            sleepS: 0
        )
        diagnostics.pushTick(entry)
    }

    /// Trace-row writer for rejection paths. `decision` may be nil if we
    /// rejected before composition ran (e.g. notRecording / noStart).
    func recordTickRejection(
        iterIdx: Int64,
        action: MetronomeTickAction,
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
            cameraBranch: (decision?.branch ?? .notApplicable).rawValue,
            sourcePTS: sourceRelative,
            elapsedLogical: ptsLogical,
            emitPTS: nil,
            lastEmitPTS: lastEmitLogical,
            compositeS: decision?.compositeS ?? 0,
            action: action.rawValue,
            driftS: 0,
            sleepS: 0
        )
        diagnostics.pushTick(entry)
    }

    /// Writes `diagnostics.json` next to the recording bundle and logs a
    /// one-line summary to console. No-op if there's no local save path.
    func writeDiagnosticsDump(sessionID: String) {
        let summary = diagnostics.summaryLine()
        Log.recording.log("diagnostics: \(summary)")

        guard let localDir = localSavePath else { return }
        let path = localDir.appendingPathComponent("diagnostics.json")
        let dump = diagnostics.makeFullDump(
            sessionID: sessionID,
            recordedAt: ISO8601DateFormatter().string(from: Date())
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(dump)
            try data.write(to: path)
            Log.recording.log("Wrote \(data.count) bytes to diagnostics.json")
        } catch {
            Log.recording.log("Failed to write diagnostics dump: \(error)")
        }
    }

    /// Convenience: append a `diagnostics.summary` event to the recording
    /// timeline so the one-line summary is visible in `recording.json` too.
    /// Called from `stopRecording` after the timeline builder has the
    /// recording.stopped event recorded.
    func recordDiagnosticsSummaryEvent() {
        let summary = diagnostics.summaryLine()
        timeline.recordError(message: "diagnostics: \(summary)", t: logicalElapsedSeconds())
    }
}
