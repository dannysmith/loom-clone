import AVFoundation
import CoreMedia

extension RecordingActor {
    // MARK: - Source Health Monitoring

    // Watches for a capture source going *silent*. `SourceHealthTracker` owns
    // the thresholds and the fire-once / clear / re-fire bookkeeping; this file
    // feeds it host-clock times from the frame handlers, evaluates it from the
    // ~2 Hz health task (see `startHealthCheckTimer` in +Metronome, decoupled
    // from the timing-critical encode loop), and turns each transition it
    // reports into a timeline event plus a user-visible warning.

    /// Run from the ~2 Hz health task. Checks each source the active mode
    /// consumes against its freshness threshold.
    func checkSourceHealth() {
        guard isRecording, !isStopping else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds

        // Audio is always checked; screen and camera only while the active
        // mode actually consumes them.
        var activeSources: Set<SourceHealthTracker.Source> = [.audio]
        if modeUsesScreen { activeSources.insert(.screen) }
        if modeUsesCamera { activeSources.insert(.camera) }

        for transition in sourceHealth.evaluate(now: now, activeSources: activeSources) {
            dispatch(transition)
        }
    }

    /// Called when a frame/sample arrives: updates the last-seen timestamp and
    /// clears the source's stale warning if one was standing.
    func markScreenFrameReceived() {
        markReceived(.screen)
    }

    func markCameraFrameReceived() {
        markReceived(.camera)
    }

    func markAudioSampleReceived() {
        markReceived(.audio)
    }

    private func markReceived(_ source: SourceHealthTracker.Source) {
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if let transition = sourceHealth.markReceived(source, now: now) {
            dispatch(transition)
        }
    }

    /// Turn one tracker transition into its timeline event, log line, and
    /// warning fire/clear. The single place source-health severity is decided:
    /// losing the *only* source in the current mode is critical, losing a
    /// secondary one is a warning.
    private func dispatch(_ transition: SourceHealthTracker.Transition) {
        switch transition {
        case let .wentStale(source, staleSeconds):
            let t = logicalElapsedSeconds()
            timeline.recordSourceStale(source: source.rawValue, t: t, staleDuration: staleSeconds)
            Log.health.log("\(source.rawValue) stale: \(String(format: "%.1f", staleSeconds))s since last delivery")
            fireWarning(.init(
                id: source.staleWarning,
                severity: severity(for: source),
                message: staleMessage(for: source),
                dismissible: false
            ))
        case let .recovered(source):
            timeline.recordSourceRecovered(source: source.rawValue, t: logicalElapsedSeconds())
            Log.health.log("\(source.rawValue) recovered")
            clearWarning(source.staleWarning)
        }
    }

    /// How loud to be about losing `source`: critical when it's the only
    /// source the current mode has, a warning when something useful is still
    /// being recorded without it.
    private func severity(for source: SourceHealthTracker.Source) -> RecordingWarning.Severity {
        switch source {
        case .screen: mode == .screenOnly ? .critical : .warning
        case .camera: mode == .cameraOnly ? .critical : .warning
        // Audio never has a mode in which it's the only source, and a silent
        // recording is still a usable one.
        case .audio: .warning
        }
    }

    private func staleMessage(for source: SourceHealthTracker.Source) -> String {
        switch source {
        case .screen: "Screen capture stalled"
        case .camera: "Camera not delivering frames"
        case .audio: "No audio detected"
        }
    }

    // MARK: - Capture Error Handlers

    /// Called from the ScreenCaptureManager's SCStreamDelegate error callback.
    func handleScreenCaptureError(_ error: Error) {
        recordSourceFailure(
            .screen,
            reason: (error as NSError).localizedDescription,
            message: "Screen capture failed"
        )
    }

    /// Called from the CameraCaptureManager's session error notification.
    func handleCameraSessionError(_ error: Error) {
        let desc = (error as NSError).localizedDescription
        recordSourceFailure(
            .camera,
            reason: desc,
            message: "Camera disconnected",
            audioFailoverReason: "camera session error: \(desc)"
        )
    }

    /// Called from the CameraCaptureManager's session interruption notification.
    func handleCameraSessionInterrupted() {
        recordSourceFailure(
            .camera,
            reason: "session interrupted",
            message: "Camera interrupted",
            audioFailoverReason: "camera session interrupted"
        )
    }

    /// Called from the MicrophoneCaptureManager's session error notification.
    func handleMicSessionError(_ error: Error) {
        recordSourceFailure(
            .audio,
            reason: (error as NSError).localizedDescription,
            message: "Microphone disconnected"
        )
    }

    /// Called from the MicrophoneCaptureManager's session interruption notification.
    func handleMicSessionInterrupted() {
        recordSourceFailure(
            .audio,
            reason: "session interrupted",
            message: "Microphone interrupted"
        )
    }

    /// Shared body of the five capture-failure handlers: record it on the
    /// timeline, mark the source failed (which suppresses its now-redundant
    /// stale check), and raise the warning. `audioFailoverReason` covers the
    /// one source-specific side effect any of them has — the camera's
    /// shared-session audio failover.
    private func recordSourceFailure(
        _ source: SourceHealthTracker.Source,
        reason: String,
        message: String,
        audioFailoverReason: String? = nil
    ) {
        guard isRecording, !isStopping else { return }
        // A dead session can report itself more than once; only the first
        // report is news.
        guard sourceHealth.markFailed(source) else { return }

        let t = logicalElapsedSeconds()
        timeline.recordSourceFailed(source: source.rawValue, error: reason, t: t)
        Log.health.log("\(source.rawValue) capture failed: \(reason)")

        if let audioFailoverReason {
            failoverSharedSessionAudio(reason: audioFailoverReason, t: t)
        }

        fireWarning(.init(
            id: source.failedWarning,
            severity: severity(for: source),
            message: message,
            dismissible: false
        ))
    }

    /// When camera + mic share an AVCaptureSession, the camera's audio is
    /// what feeds the HLS writer (eliminating cross-session clock jitter).
    /// If the camera session dies, that audio path goes silent — but the
    /// standalone mic session is still running. Flip the routing flag so
    /// `handleMicAudioSample` starts forwarding mic audio into the HLS
    /// path. No-op when the session wasn't shared in the first place.
    func failoverSharedSessionAudio(reason: String, t: Double) {
        guard sharedSessionAudioActive else { return }
        sharedSessionAudioActive = false
        timeline.recordAudioFailover(reason: reason, t: t)
        Log.health.log("Audio failover: shared session dead, routing standalone mic to HLS")
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
        Log.health.log("HLS writer failed: \(errorDesc ?? "unknown")")

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

    func fireWarning(_ warning: RecordingWarning) {
        if let callback = onWarningChanged {
            Task { await callback(warning, true) }
        }
    }

    func clearWarning(_ kind: RecordingWarning.Kind) {
        if let callback = onWarningChanged {
            // Send a placeholder warning with the right id so the coordinator
            // can identify which warning to remove.
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
