import AppKit
import AVFoundation
import Foundation

extension RecordingCoordinator {
    // MARK: - Start

    func startRecording() {
        // `.stopped` is the brief post-recording window (until
        // `stoppedToIdleDelay` flips it back to `.idle`) — recording
        // resources are already released at that point, so a second
        // recording can start immediately. The pending revert-to-idle
        // Task no-ops because we'll move state out of `.stopped` here.
        guard state == .idle || state == .stopped else { return }
        guard !availableModes.isEmpty else {
            Log.coordinator.log("No sources selected — record button should be disabled")
            return
        }
        // Make sure the mode the user is about to record in is actually
        // valid for the current source set. demoteModeIfUnavailable normally
        // catches this, but be defensive.
        if !availableModes.contains(mode), let first = availableModes.first {
            mode = first
        }

        resetRunState()

        // Enter the countdown state immediately so the panel renders.
        state = .countingDown
        countdownSeconds = Self.countdownDuration
        updateCameraOverlayVisibility()

        let actor = RecordingActor()
        recordingActor = actor

        let displayID = selectedDisplay?.displayID
        let cameraID = selectedCamera?.uniqueID
        let micID = selectedMicrophone?.uniqueID
        let currentMode = mode
        let currentPreset = outputPreset
        let currentFrameRate = frameRate

        startupTask = Task { @MainActor in
            // 1. Stop the previews. Camera preview must be AWAITED — the
            // recording session can't start until CMIO has fully released
            // the device. Screen preview is a fire-and-forget snapshot task,
            // just cancel it. Mic preview is awaited so the recording path
            // can take ownership of the audio device cleanly.
            await cameraPreview.stop()
            await microphonePreview.stop()
            screenPreview.stop()

            await wireActorCallbacks(actor: actor)

            // Kick off the slow setup (server session, capture hardware, audio
            // wait) IN PARALLEL with the visible countdown.
            let currentExcludedApps = self.excludedAppBundleIDs
            let currentHideDesktopIcons = self.hideDesktopIcons
            let prepareTask = Task { () -> (id: String, slug: String)? in
                do {
                    return try await actor.prepareRecording(
                        displayID: displayID,
                        cameraID: cameraID,
                        microphoneID: micID,
                        mode: currentMode,
                        preset: currentPreset,
                        frameRate: currentFrameRate,
                        excludedBundleIDs: currentExcludedApps,
                        hideDesktopIcons: currentHideDesktopIcons
                    )
                } catch {
                    Log.coordinator.log("prepareRecording failed: \(error)")
                    return nil
                }
            }

            // Tick down the countdown: 3 → 2 → 1.
            for n in stride(from: Self.countdownDuration, through: 1, by: -1) {
                if Task.isCancelled { break }
                self.countdownSeconds = n
                try? await Task.sleep(for: .seconds(1))
            }

            // Cancellation check — if user hit Stop during countdown, bail.
            if Task.isCancelled {
                prepareTask.cancel()
                _ = await prepareTask.value
                await actor.cancelPreparation()
                self.cleanupAfterCancellation()
                return
            }

            // Wait for prepare to actually finish (it usually does well
            // before the countdown ends, but mic startup can be slow).
            self.countdownSeconds = 0
            let prepared = await prepareTask.value

            if Task.isCancelled || prepared == nil {
                await actor.cancelPreparation()
                self.cleanupAfterCancellation()
                return
            }

            // Commit: anchors the recording clock, starts writer, starts metronome.
            await actor.commitRecording()

            // Transition to recording state.
            self.countdownSeconds = nil
            self.state = .recording
            self.recordingStartDate = Date()
            self.accumulatedBeforePause = 0
            self.elapsedSeconds = 0
            self.startTimer()
            self.updateCameraOverlayVisibility()
            self.startAppLaunchObserver()
        }
    }

    private func resetRunState() {
        accumulatedBeforePause = 0
        elapsedSeconds = 0
        lastVideo = nil
        recordingStartDate = nil
        chapterMarkerCount = 0
        lastChapterMarkerPressAt = nil
    }

    /// Wire the actor callbacks that need to be set before `prepareRecording`
    /// runs. Pulled out of `startRecording` so the start path stays readable.
    private func wireActorCallbacks(actor: RecordingActor) async {
        // Wire the overlay frame callback before starting captures. Capture
        // the overlay reference by value (it's Sendable) so the closure can
        // call enqueue directly from the camera capture queue, bypassing
        // both the actor and the main thread for per-frame work. The
        // overlay was created by `updateCameraOverlayVisibility()` before
        // this task started.
        let overlay = self.cameraOverlay
        await actor.setOverlayCallback { [overlay] sampleBuffer in
            overlay?.enqueue(sampleBuffer)
        }

        // Wire the PiP quadrant callback. When the user drags the overlay
        // into a different quadrant, update the compositor's position so
        // the composited output matches.
        self.cameraOverlay?.onQuadrantChanged = { [weak self] newPosition in
            guard let self else { return }
            Task { await self.recordingActor?.switchPipPosition(to: newPosition) }
        }

        // Wire the terminal-error callback. Fires at most once per recording,
        // from a detached task inside the actor, when the compositor reports
        // a failure that rebuild can't recover from. Hop to the main actor
        // and run the normal stop flow plus a user-visible alert.
        await actor.setTerminalErrorCallback { [weak self] message in
            guard let self else { return }
            await MainActor.run {
                self.handleTerminalRecordingError(message)
            }
        }

        // Wire the source-health warning callback. Fires when a capture
        // source fails, goes stale, or recovers. Hop to main actor to
        // update the observable warning list.
        await actor.setWarningCallback { [weak self] warning, isActive in
            guard let self else { return }
            await MainActor.run {
                self.handleWarningChanged(warning, isActive: isActive)
            }
        }

        // Wire the camera-adjustments state box. The compositor reads from
        // it on every frame so slider moves take effect immediately on the
        // composited HLS output.
        await actor.setCameraAdjustmentsState(self.cameraAdjustmentsState)
    }

    /// Reset state when the startup task is cancelled or fails before commit.
    func cleanupAfterCancellation() {
        countdownSeconds = nil
        state = .idle
        recordingActor = nil
        stopAppLaunchObserver()
        cameraOverlay?.hide()
        // Only restart the preview if the popover is still open. Otherwise
        // we'd silently re-activate the camera with the popover closed,
        // which is exactly what we're trying to avoid.
        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
        }
        if isPopoverOpen, let mic = selectedMicrophone {
            Task { await microphonePreview.start(device: mic) }
        }
    }

    // MARK: - Stop / Cancel

    func stopRecording() {
        // Stop during countdown: cancel the startup task and clean up.
        if state == .countingDown {
            startupTask?.cancel()
            // The startup task observes Task.isCancelled and runs
            // cleanupAfterCancellation() on the way out.
            return
        }

        guard state == .recording || state == .paused else { return }
        state = .stopped
        stopTimer()
        stopAppLaunchObserver()
        activeWarnings.removeAll()
        cameraOverlay?.hide()

        // Only restart the preview if the popover is still open (rare —
        // usually the popover has been closed since before recording started).
        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
        }
        if isPopoverOpen, let mic = selectedMicrophone {
            Task { await microphonePreview.start(device: mic) }
        }

        Task {
            let result = await recordingActor?.stopRecording()
            if let result {
                self.lastVideo = LastVideoInfo(
                    url: result.url,
                    videoId: result.videoId,
                    slug: result.slug,
                    title: result.title,
                    visibility: result.visibility
                )
            }
            self.recordingActor = nil

            // Hand off any missing segments to HealAgent. Fire-and-forget —
            // the user's clipboard already has the URL by now.
            if let result, !result.missing.isEmpty, let heal = self.healAgent {
                heal.scheduleHeal(
                    videoId: result.videoId,
                    localDir: result.localDir,
                    timelineData: result.timelineData,
                    missing: result.missing
                )
            }

            // Hand off to TranscribeAgent. Fire-and-forget — runs Whisper
            // in the background and uploads the SRT when done.
            if let result, let transcribe = self.transcribeAgent {
                transcribe.scheduleTranscription(
                    videoId: result.videoId,
                    localDir: result.localDir
                )
            }

            try? await Task.sleep(for: Self.stoppedToIdleDelay)
            if self.state == .stopped {
                self.state = .idle
            }
        }
    }

    /// Abandon the current recording after a confirmation prompt. Tears
    /// down the pipeline, deletes the server-side video, and removes the
    /// local safety-net copy. No-op unless currently recording or paused.
    @discardableResult
    func cancelRecording() -> Bool {
        guard state == .recording || state == .paused else { return false }

        let alert = NSAlert()
        alert.messageText = "Discard recording?"
        alert.informativeText = "This will permanently delete the recording. This action cannot be undone."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Discard")
        alert.addButton(withTitle: "Keep Recording")

        // Pause while the confirmation is on-screen so we're not burning
        // disk/CPU on footage the user is about to throw away.
        let wasRecording = (state == .recording)
        if wasRecording { pauseRecording() }

        let response = alert.runModal()

        guard response == .alertFirstButtonReturn else {
            if wasRecording { resumeRecording() }
            return false
        }

        state = .stopped
        stopTimer()
        stopAppLaunchObserver()
        activeWarnings.removeAll()
        cameraOverlay?.hide()

        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
        }

        Task {
            await recordingActor?.cancelRecording()
            self.recordingActor = nil
            self.lastVideo = nil
            self.state = .idle
        }
        return true
    }

    // MARK: - Pause / Resume / Mode / Chapter

    func pauseRecording() {
        guard state == .recording else { return }
        state = .paused
        accumulatedBeforePause = elapsedSeconds
        stopTimer()

        Task { await recordingActor?.pause() }
    }

    func resumeRecording() {
        guard state == .paused else { return }
        state = .recording
        recordingStartDate = Date()
        startTimer()

        Task { await recordingActor?.resume() }
    }

    /// Drop an anonymous chapter marker on the timeline at the current
    /// (or paused) clock position. Coalesces rapid double-clicks so a
    /// twitchy press doesn't produce two markers a few ms apart. Title
    /// and ordering are handled later by the admin editor.
    func addChapterMarker() {
        guard state == .recording || state == .paused else { return }

        let now = Date()
        if let last = lastChapterMarkerPressAt,
           now.timeIntervalSince(last) < Self.chapterMarkerDebounceInterval
        {
            return
        }
        lastChapterMarkerPressAt = now
        chapterMarkerCount += 1

        Task { await recordingActor?.addChapterMarker() }
    }

    func switchMode(to newMode: RecordingMode) {
        mode = newMode
    }

    /// Step `mode` to the next entry in `availableModes`, skipping any modes
    /// the current source selection can't satisfy. The keyboard shortcut
    /// (Cmd+Shift+M) is wired to this during recording — using `mode.next()`
    /// directly would cycle into modes (e.g. `.cameraOnly` with no camera
    /// selected) that the metronome can't drive, silently halting output.
    func cycleMode() {
        let modes = availableModes
        guard !modes.isEmpty else { return }
        if let currentIdx = modes.firstIndex(of: mode) {
            mode = modes[(currentIdx + 1) % modes.count]
        } else {
            mode = modes[0]
        }
    }

    // MARK: - Terminal Recording Error

    /// Invoked from `RecordingActor`'s terminal-error callback when the
    /// compositor reports a render failure that rebuild can't recover from.
    /// Runs the normal stop flow so local files are flushed cleanly and then
    /// surfaces an alert to the user. No-op if we've already moved out of the
    /// recording state (e.g. the user hit Stop between the failure and the
    /// hop to main).
    func handleTerminalRecordingError(_ message: String) {
        guard state == .recording || state == .paused else { return }

        state = .stopped
        stopTimer()
        stopAppLaunchObserver()
        activeWarnings.removeAll()
        cameraOverlay?.hide()

        // Tell AppDelegate to hide the floating RecordingPanel — we don't own
        // it, and neither user-initiated stop nor user-initiated cancel ran
        // here to do it for us.
        onTerminalRecordingStop?()

        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
        }

        Task { @MainActor in
            let result = await recordingActor?.stopRecording()
            if let result {
                self.lastVideo = LastVideoInfo(
                    url: result.url,
                    videoId: result.videoId,
                    slug: result.slug,
                    title: result.title,
                    visibility: result.visibility
                )
            }
            self.recordingActor = nil

            if let result, !result.missing.isEmpty, let heal = self.healAgent {
                heal.scheduleHeal(
                    videoId: result.videoId,
                    localDir: result.localDir,
                    timelineData: result.timelineData,
                    missing: result.missing
                )
            }

            if let result, let transcribe = self.transcribeAgent {
                transcribe.scheduleTranscription(
                    videoId: result.videoId,
                    localDir: result.localDir
                )
            }

            let alert = NSAlert()
            alert.messageText = "Recording stopped"
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()

            try? await Task.sleep(for: Self.stoppedToIdleDelay)
            if self.state == .stopped {
                self.state = .idle
            }
        }
    }

    // MARK: - Camera Overlay

    func updateCameraOverlayVisibility() {
        let activeStates: Set<RecordingState> = [.countingDown, .recording, .paused]
        guard activeStates.contains(state) else {
            cameraOverlay?.hide()
            return
        }

        // No camera selected → never show the on-screen camera overlay,
        // regardless of mode. (Mode wouldn't be a camera-bearing mode in
        // that case anyway, but be explicit.)
        guard selectedCamera != nil else {
            cameraOverlay?.hide()
            return
        }

        if mode != .screenOnly {
            if cameraOverlay == nil {
                cameraOverlay = CameraOverlayWindow()
            }
            // Pass the shared adjustments state so the overlay picks up
            // slider moves live.
            cameraOverlay?.setAdjustmentsState(cameraAdjustmentsState)
            // Match the overlay shape to the compositor's output:
            //   - cameraOnly   → full 16:9 frame (rectangle)
            //   - screenAndCamera → circular PiP (circle)
            let style: CameraOverlayWindow.Style = (mode == .cameraOnly) ? .rectangle : .circle
            cameraOverlay?.show(on: nil, style: style)
        } else {
            cameraOverlay?.hide()
        }
    }

    // MARK: - App Launch Observer

    /// Watch for newly-launched apps during recording. If a launched app's
    /// bundle ID is in the exclusion set, re-resolve and update the capture
    /// filter so it's excluded without needing a recording restart.
    func startAppLaunchObserver() {
        guard !excludedAppBundleIDs.isEmpty else { return }
        appLaunchObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            // NSWorkspace delivers on the main thread (queue:.main) but Swift
            // concurrency doesn't formally guarantee that's the MainActor.
            // Hop explicitly so the `state` / `excludedAppBundleIDs` reads
            // are isolated.
            guard let bundleID = (notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication)?.bundleIdentifier
            else { return }
            Task { @MainActor [weak self] in
                guard let self,
                      self.state == .recording || self.state == .paused,
                      self.excludedAppBundleIDs.contains(bundleID)
                else { return }
                Log.coordinator.log("Excluded app launched mid-recording: \(bundleID)")
                Task { await self.recordingActor?.updateExcludedApps() }
            }
        }
    }

    func stopAppLaunchObserver() {
        if let observer = appLaunchObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            appLaunchObserver = nil
        }
    }

    // MARK: - Timer

    func startTimer() {
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.state == .recording else { continue }
                let elapsed = Date().timeIntervalSince(self.recordingStartDate ?? Date())
                self.elapsedSeconds = self.accumulatedBeforePause + elapsed
            }
        }
    }

    func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }
}
