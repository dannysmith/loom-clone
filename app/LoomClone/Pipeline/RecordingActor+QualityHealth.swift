import CoreMedia

extension RecordingActor {
    // MARK: - Live Quality-Degradation Monitoring

    // The source-health checks (`checkSourceHealth`) catch *silence* — a source
    // that stops delivering. This catches the failure that doesn't go silent:
    // the CMIO meltdown (#30 / #44) where the camera keeps delivering frames at
    // roughly the right rate but with a corrupt, non-monotonic capture-PTS
    // timeline — which *is* the A/V desync. `CameraCadenceMonitor` (fed per
    // camera frame in `recordCameraFrameForDiagnostics`) holds the predicate;
    // here we evaluate it from the same ~2Hz health timer and fire/clear a
    // single `.qualityDegraded` warning, mirroring the stale/recover dispatch.
    //
    // Severity is `.warning`, not `.critical`: output is still being produced,
    // just degraded — it's the user's call whether to pause, stop, or carry on
    // (#44). It observes the violation; task 3 enforces the invariant.

    /// Run from the health-check timer. Evaluates the camera cadence monitor and
    /// fires/clears the quality-degradation warning on transition.
    func checkQualityHealth() {
        guard isRecording, !isStopping else { return }

        // The camera AVCaptureSession runs for the whole recording (mode switch
        // just flips a flag), so the monitor keeps being fed even in
        // `screenOnly` — but a corrupt camera timeline only desyncs output when
        // the camera is actually in the composite. If the active mode no longer
        // uses the camera, clear any standing warning and stay quiet.
        guard modeUsesCamera else {
            if activeSourceWarnings.remove(.qualityDegraded) != nil {
                timeline.recordQualityRecovered(t: logicalElapsedSeconds())
                Log.health.log("Quality warning cleared: mode no longer uses camera")
                clearWarning(.qualityDegraded)
            }
            return
        }

        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        let degraded = cameraCadenceMonitor.evaluateHealth(now: now)

        if degraded, !activeSourceWarnings.contains(.qualityDegraded) {
            activeSourceWarnings.insert(.qualityDegraded)
            let t = logicalElapsedSeconds()
            let count = cameraCadenceMonitor.windowedEventCount
            let fps = measuredCameraFps(atLogical: t)
            timeline.recordQualityDegraded(nonMonotonicCount: count, cameraFps: fps, t: t)
            Log.health.log("Quality degraded: \(count) non-monotonic camera frames in window")
            fireWarning(.init(
                id: .qualityDegraded,
                severity: .warning,
                message: "Recording quality may be degraded — check your camera",
                dismissible: false
            ))
        } else if !degraded, activeSourceWarnings.contains(.qualityDegraded) {
            activeSourceWarnings.remove(.qualityDegraded)
            timeline.recordQualityRecovered(t: logicalElapsedSeconds())
            Log.health.log("Quality recovered")
            clearWarning(.qualityDegraded)
        }
    }

    /// Rough camera frame rate (frames received ÷ logical elapsed) for the
    /// degraded timeline event. Lifetime average, not instantaneous — enough to
    /// tell "below target but steady" from "destabilising" in forensics. Nil
    /// before any elapsed time has accrued.
    private func measuredCameraFps(atLogical elapsed: Double) -> Double? {
        guard elapsed > 0.1 else { return nil }
        return Double(diagnostics.cameraFramesReceived) / elapsed
    }
}
