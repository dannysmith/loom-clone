import AVFoundation
import CoreMedia

extension RecordingActor {
    // MARK: - Source Health Monitoring

    // Tracks the last time each source delivered data, and which warnings are
    // currently active. The health check runs on each metronome tick (free —
    // we're already awake) and fires warnings/timeline events on threshold
    // breach. Each warning fires once; if the source recovers (delivers again)
    // the warning clears and can re-fire on a subsequent stall.

    // Thresholds (seconds since last delivery):
    static let screenStaleThreshold: Double = 2.0
    static let cameraStaleThreshold: Double = 1.0
    static let audioMissingThreshold: Double = 2.0

    /// Run from the metronome tick. Checks each source against its freshness
    /// threshold and fires/clears warnings as needed.
    func checkSourceHealth() {
        guard isRecording, !isStopping else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds

        // Screen — skip the stale check if already known-failed
        if modeUsesScreen, !activeSourceWarnings.contains(.screenFailed) {
            if let last = lastScreenFrameHostTime {
                let stale = now - last
                if stale > Self.screenStaleThreshold, !activeSourceWarnings.contains(.screenStale) {
                    activeSourceWarnings.insert(.screenStale)
                    let t = logicalElapsedSeconds()
                    timeline.recordSourceStale(source: "screen", t: t, staleDuration: stale)
                    print("[health] Screen stale: \(String(format: "%.1f", stale))s since last frame")
                    fireWarning(.init(
                        id: .screenStale,
                        severity: mode == .screenOnly ? .critical : .warning,
                        message: "Screen capture stalled",
                        dismissible: false
                    ))
                }
            }
        }

        // Camera — skip the stale check if the source is already known-failed
        // (the failed warning is more specific and already visible).
        if modeUsesCamera, !activeSourceWarnings.contains(.cameraFailed) {
            if let last = lastCameraFrameHostTime {
                let stale = now - last
                if stale > Self.cameraStaleThreshold, !activeSourceWarnings.contains(.cameraStale) {
                    activeSourceWarnings.insert(.cameraStale)
                    let t = logicalElapsedSeconds()
                    timeline.recordSourceStale(source: "camera", t: t, staleDuration: stale)
                    print("[health] Camera stale: \(String(format: "%.1f", stale))s since last frame")
                    fireWarning(.init(
                        id: .cameraStale,
                        severity: mode == .cameraOnly ? .critical : .warning,
                        message: "Camera not delivering frames",
                        dismissible: false
                    ))
                }
            }
        }

        // Audio — skip if already known-failed
        if !activeSourceWarnings.contains(.audioFailed) {
            if let last = lastAudioSampleHostTime {
                let stale = now - last
                if stale > Self.audioMissingThreshold, !activeSourceWarnings.contains(.audioMissing) {
                    activeSourceWarnings.insert(.audioMissing)
                    let t = logicalElapsedSeconds()
                    timeline.recordSourceStale(source: "audio", t: t, staleDuration: stale)
                    print("[health] Audio missing: \(String(format: "%.1f", stale))s since last sample")
                    fireWarning(.init(
                        id: .audioMissing,
                        severity: .warning,
                        message: "No audio detected",
                        dismissible: false
                    ))
                }
            }
        }
    }

    /// Called when a frame/sample arrives to clear a stale warning if one was
    /// active. Also updates the last-seen timestamp.
    func markScreenFrameReceived() {
        lastScreenFrameHostTime = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if activeSourceWarnings.remove(.screenStale) != nil {
            timeline.recordSourceRecovered(source: "screen", t: logicalElapsedSeconds())
            print("[health] Screen recovered")
            clearWarning(.screenStale)
        }
    }

    func markCameraFrameReceived() {
        lastCameraFrameHostTime = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if activeSourceWarnings.remove(.cameraStale) != nil {
            timeline.recordSourceRecovered(source: "camera", t: logicalElapsedSeconds())
            print("[health] Camera recovered")
            clearWarning(.cameraStale)
        }
    }

    func markAudioSampleReceived() {
        lastAudioSampleHostTime = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if activeSourceWarnings.remove(.audioMissing) != nil {
            timeline.recordSourceRecovered(source: "audio", t: logicalElapsedSeconds())
            print("[health] Audio recovered")
            clearWarning(.audioMissing)
        }
    }

    // MARK: - Capture Error Handlers

    /// Called from the ScreenCaptureManager's SCStreamDelegate error callback.
    func handleScreenCaptureError(_ error: Error) {
        guard isRecording, !isStopping else { return }
        let t = logicalElapsedSeconds()
        let desc = (error as NSError).localizedDescription
        timeline.recordSourceFailed(source: "screen", error: desc, t: t)
        print("[health] Screen capture failed: \(desc)")

        activeSourceWarnings.insert(.screenFailed)
        fireWarning(.init(
            id: .screenFailed,
            severity: mode == .screenOnly ? .critical : .warning,
            message: "Screen capture failed",
            dismissible: false
        ))
    }

    /// Called from the CameraCaptureManager's session error notification.
    func handleCameraSessionError(_ error: Error) {
        guard isRecording, !isStopping else { return }
        let t = logicalElapsedSeconds()
        let desc = (error as NSError).localizedDescription
        timeline.recordSourceFailed(source: "camera", error: desc, t: t)
        print("[health] Camera session error: \(desc)")

        activeSourceWarnings.insert(.cameraFailed)
        fireWarning(.init(
            id: .cameraFailed,
            severity: mode == .cameraOnly ? .critical : .warning,
            message: "Camera disconnected",
            dismissible: false
        ))
    }

    /// Called from the CameraCaptureManager's session interruption notification.
    func handleCameraSessionInterrupted() {
        guard isRecording, !isStopping else { return }
        let t = logicalElapsedSeconds()
        timeline.recordSourceFailed(source: "camera", error: "session interrupted", t: t)
        print("[health] Camera session interrupted")

        activeSourceWarnings.insert(.cameraFailed)
        fireWarning(.init(
            id: .cameraFailed,
            severity: mode == .cameraOnly ? .critical : .warning,
            message: "Camera interrupted",
            dismissible: false
        ))
    }

    /// Called from the MicrophoneCaptureManager's session error notification.
    func handleMicSessionError(_ error: Error) {
        guard isRecording, !isStopping else { return }
        let t = logicalElapsedSeconds()
        let desc = (error as NSError).localizedDescription
        timeline.recordSourceFailed(source: "audio", error: desc, t: t)
        print("[health] Mic session error: \(desc)")

        activeSourceWarnings.insert(.audioFailed)
        fireWarning(.init(
            id: .audioFailed,
            severity: .warning,
            message: "Microphone disconnected",
            dismissible: false
        ))
    }

    /// Called from the MicrophoneCaptureManager's session interruption notification.
    func handleMicSessionInterrupted() {
        guard isRecording, !isStopping else { return }
        let t = logicalElapsedSeconds()
        timeline.recordSourceFailed(source: "audio", error: "session interrupted", t: t)
        print("[health] Mic session interrupted")

        activeSourceWarnings.insert(.audioFailed)
        fireWarning(.init(
            id: .audioFailed,
            severity: .warning,
            message: "Microphone interrupted",
            dismissible: false
        ))
    }

    // MARK: - HLS Writer Health

    /// Called at segment boundaries (from handleSegment) to check whether the
    /// HLS writer has entered .failed state. Unlike raw writer failures (which
    /// are recoverable — the HLS path continues), an HLS writer failure is
    /// terminal: the primary output is dead.
    func checkHLSWriterHealth() async {
        guard isRecording, !isStopping else { return }
        let status = await writer.writerStatus()
        guard status == .failed else { return }

        let errorDesc = await writer.writerError()
        let t = logicalElapsedSeconds()
        timeline.recordHLSWriterFailed(error: errorDesc ?? "unknown", t: t)
        print("[health] HLS writer failed: \(errorDesc ?? "unknown")")

        fireWarning(.init(
            id: .hlsWriterFailed,
            severity: .critical,
            message: "Recording output failed",
            dismissible: false
        ))

        // Escalate as terminal — there's no point continuing if the primary
        // output is dead.
        guard !terminalErrorFired else { return }
        terminalErrorFired = true
        timeline.recordCompositionTerminalFailure(t: t, detail: "HLS writer entered .failed state")
        let message = "Recording stopped: the video encoder failed. Your recording has been saved up to this point."
        if let callback = onTerminalError {
            Task { await callback(message) }
        }
    }

    // MARK: - Warning Dispatch

    private func fireWarning(_ warning: RecordingWarning) {
        if let callback = onWarningChanged {
            Task { await callback(warning, true) }
        }
    }

    private func clearWarning(_ kind: RecordingWarning.Kind) {
        if let callback = onWarningChanged {
            // Send a dummy warning with the right id so the coordinator can
            // identify which warning to remove.
            let placeholder = RecordingWarning(id: kind, severity: .warning, message: "", dismissible: false)
            Task { await callback(placeholder, false) }
        }
    }

    // MARK: - Helpers

    var modeUsesScreen: Bool {
        mode == .screenOnly || mode == .screenAndCamera
    }

    var modeUsesCamera: Bool {
        mode == .cameraOnly || mode == .screenAndCamera
    }
}
