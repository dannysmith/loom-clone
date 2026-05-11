import AVFoundation
import Foundation
import ScreenCaptureKit

/// UI-observable state for the recording pipeline.
/// Lives on the main actor so SwiftUI views can bind directly.
/// Delegates actual recording work to RecordingActor.
@MainActor
@Observable
final class RecordingCoordinator {
    // MARK: - Recording State

    private(set) var state: RecordingState = .idle
    var mode: RecordingMode = .screenAndCamera {
        didSet {
            if state == .recording || state == .paused {
                Task { await recordingActor?.switchMode(to: mode) }
                updateCameraOverlayVisibility()
            } else if isPopoverOpen {
                // Mode changed from the picker while idle — re-evaluate which
                // previews should be running.
                updatePreviewsForCurrentState()
            }
        }
    }

    // MARK: - Device Selection

    var availableDisplays: [SCDisplay] = []
    var availableCameras: [AVCaptureDevice] = []
    var availableMicrophones: [AVCaptureDevice] = []

    /// Modes that are reachable given the currently-selected sources.
    /// Used to gate the mode picker (and to filter the recording panel's
    /// mode strip during recording, since devices can't change mid-session).
    var availableModes: [RecordingMode] {
        let hasScreen = selectedDisplay != nil
        let hasCamera = selectedCamera != nil
        var modes: [RecordingMode] = []
        if hasScreen { modes.append(.screenOnly) }
        if hasCamera { modes.append(.cameraOnly) }
        if hasScreen, hasCamera { modes.append(.screenAndCamera) }
        return modes
    }

    var selectedDisplay: SCDisplay? {
        didSet {
            // Source change: ensure the current mode is still reachable.
            demoteModeIfUnavailable()
            // Refresh idle-state previews for the new selection.
            if isPopoverOpen, state == .idle {
                updatePreviewsForCurrentState()
            }
        }
    }

    var selectedCamera: AVCaptureDevice? {
        didSet {
            demoteModeIfUnavailable()
            // Only act on the preview if it's actually running right now.
            // Starting the preview is owned by `updatePreviewsForCurrentState()`
            // — not by the selection itself — so that the camera hardware
            // (and the macOS green indicator) is only active while the popover
            // is open and a camera-bearing mode is selected.
            guard cameraPreview.isActive || selectedCamera == nil else { return }
            let camera = selectedCamera
            Task { @MainActor in
                if let camera {
                    await cameraPreview.start(device: camera)
                } else {
                    await cameraPreview.stop()
                }
            }
        }
    }

    var selectedMicrophone: AVCaptureDevice? {
        didSet {
            // Mirror the camera-preview pattern: only act if a preview is
            // already running (or the user just cleared the selection). The
            // popover-lifecycle path in `updatePreviewsForCurrentState()` owns
            // starting the preview, so the mic hardware (and macOS's orange
            // indicator) is only live while the popover is open.
            guard microphonePreview.isActive || selectedMicrophone == nil else { return }
            let mic = selectedMicrophone
            Task { @MainActor in
                if let mic {
                    await microphonePreview.start(device: mic)
                } else {
                    await microphonePreview.stop()
                }
            }
        }
    }

    /// If `mode` is no longer in `availableModes` (because a source went
    /// away), pick the first available mode. If none are available, leave
    /// `mode` alone — the record button is disabled separately.
    private func demoteModeIfUnavailable() {
        let modes = availableModes
        guard !modes.isEmpty else { return }
        if !modes.contains(mode) {
            mode = modes.first!
        }
    }

    // MARK: - Output Preset

    /// Resolution + bitrate of the encoded HLS stream. Capture happens at
    /// native resolution regardless; this controls what the compositor
    /// renders into and what the encoder produces.
    var outputPreset: OutputPreset = .fromID(
        AppEnvironment.defaults.string(forKey: AppEnvironment.outputPresetKey) ?? OutputPreset.default.id
    ) {
        didSet {
            AppEnvironment.defaults.set(outputPreset.id, forKey: AppEnvironment.outputPresetKey)
        }
    }

    /// True if 1440p is meaningful for *any* mode the user could switch into
    /// during this recording. Devices can't change mid-recording, but mode
    /// can — so 1440p is offered whenever EITHER the selected display or the
    /// selected camera can natively feed it. (There is no 4K preset — see
    /// `OutputPreset.p1440` for the reasoning.)
    var is1440pAvailable: Bool {
        let displayOK: Bool = {
            guard let display = selectedDisplay else { return false }
            return Int(ScreenCaptureManager.nativePixelSize(for: display).height) >= 1440
        }()
        let cameraOK: Bool = {
            guard let cam = selectedCamera else { return false }
            return CameraCaptureManager.maxNativeHeight(for: cam) >= 1440
        }()
        return displayOK || cameraOK
    }

    // MARK: - Frame Rate

    /// Target fps for the output video. Orthogonal to resolution — the
    /// effective bitrate is `outputPreset.bitrate × frameRate.bitrateMultiplier`.
    var frameRate: FrameRate = {
        guard let raw = AppEnvironment.defaults.object(forKey: AppEnvironment.frameRateKey) as? Int32 else {
            return .thirtyFPS
        }
        return FrameRate(rawValue: raw) ?? .thirtyFPS
    }() {
        didSet {
            AppEnvironment.defaults.set(frameRate.rawValue, forKey: AppEnvironment.frameRateKey)
        }
    }

    /// True if 60fps is meaningful given the current source selection and
    /// resolution. Uses permissive gating: shown whenever ANY non-None
    /// selected source can deliver 60fps at the current resolution.
    /// Always false for 720p (incoherent intent — see issue #20 decision 6).
    var is60fpsAvailable: Bool {
        guard outputPreset != .p720 else { return false }
        // Screen: any display ≥60Hz supports 60fps capture
        let displayOK: Bool = {
            guard let display = selectedDisplay else { return false }
            return ScreenCaptureManager.refreshRate(for: display.displayID) >= 60
        }()
        let cameraOK: Bool = {
            guard let cam = selectedCamera else { return false }
            return CameraCaptureManager.supports60fps(for: cam, maxHeight: outputPreset.height)
        }()
        return displayOK || cameraOK
    }

    // MARK: - App Exclusion

    /// Bundle IDs currently selected for exclusion. In-memory only — resets
    /// on app restart. Persists across popover open/close within a session.
    var excludedAppBundleIDs: Set<String> = [] {
        didSet { updateRecentlyHidden() }
    }

    /// Whether desktop icons are hidden from recording. Persisted.
    var hideDesktopIcons: Bool = AppEnvironment.hideDesktopIcons {
        didSet { AppEnvironment.hideDesktopIcons = hideDesktopIcons }
    }

    /// Most-recently-hidden bundle IDs (up to 5), persisted across restarts.
    /// Displayed at the top of the app exclusion list in the popover.
    private(set) var recentlyHiddenBundleIDs: [String] = AppEnvironment.recentlyHiddenBundleIDs

    /// Promotes any checked bundle IDs to the front of the recently-hidden list.
    private func updateRecentlyHidden() {
        var recent = recentlyHiddenBundleIDs
        for id in excludedAppBundleIDs {
            recent.removeAll { $0 == id }
            recent.insert(id, at: 0)
        }
        recent = Array(recent.prefix(5))
        recentlyHiddenBundleIDs = recent
        AppEnvironment.recentlyHiddenBundleIDs = recent
    }

    /// NSWorkspace observer token for app launches during recording.
    private var appLaunchObserver: NSObjectProtocol?

    // MARK: - Camera Preview & Overlay

    let cameraPreview = CameraPreviewManager()
    let screenPreview = ScreenPreviewManager()
    let microphonePreview = MicrophonePreviewManager()
    private var cameraOverlay: CameraOverlayWindow?

    // MARK: - Camera Adjustments

    /// Live white-balance + brightness for the camera feed. Applied to every
    /// live preview surface and the composited HLS stream, but never to the
    /// raw `camera.mp4` master file. Session-only state — intentionally not
    /// persisted in UserDefaults, matching the existing stance on source
    /// selection.
    ///
    /// Mutations flow through to the shared `cameraAdjustmentsState` box in
    /// `didSet` so the compositor and every preview layer pick up the new
    /// value without an actor hop.
    var cameraAdjustments: CameraAdjustments = .default {
        didSet {
            cameraAdjustmentsState.value = cameraAdjustments
        }
    }

    /// Shared reference handed to `CompositionActor`, the popover
    /// `CameraPreviewLayerView`, and the on-screen overlay's layer view. All
    /// three read from it on every frame; none mutate it.
    let cameraAdjustmentsState = CameraAdjustmentsState()

    func resetCameraAdjustments() {
        cameraAdjustments = .default
    }

    // MARK: - Source Health Warnings

    /// Active warnings surfaced by the recording pipeline. Observed by the
    /// floating toolbar to show warning pills above the controls.
    private(set) var activeWarnings: [RecordingWarning] = []

    /// Called from RecordingActor's warning callback (via MainActor hop).
    func handleWarningChanged(_ warning: RecordingWarning, isActive: Bool) {
        if isActive {
            if !activeWarnings.contains(where: { $0.id == warning.id }) {
                activeWarnings.append(warning)
            }
        } else {
            activeWarnings.removeAll { $0.id == warning.id }
        }
    }

    /// Dismiss a warning (for dismissible warnings like tier 2 silence).
    func dismissWarning(_ warning: RecordingWarning) {
        activeWarnings.removeAll { $0.id == warning.id }
    }

    // MARK: - Permissions

    var screenPermissionDenied = false

    // MARK: - Server Reachability

    /// Set by `checkServerHealth()`. `true` when the recording server
    /// responded 200 to GET /api/health. Default is `false` so the Record
    /// button is disabled until we've confirmed the server is up.
    private(set) var serverReachable: Bool = false

    private static let healthCheckTimeout: TimeInterval = 2.0

    func checkServerHealth() async {
        do {
            let request = try APIClient.shared.request(
                path: "/api/health",
                timeout: Self.healthCheckTimeout
            )
            let (_, http) = try await APIClient.shared.send(request)
            serverReachable = (http.statusCode == 200)
        } catch {
            serverReachable = false
        }
    }

    // MARK: - Countdown

    /// Seconds remaining in the pre-recording countdown. nil when not counting.
    /// 3 → 2 → 1 → nil (then state transitions to .recording).
    private(set) var countdownSeconds: Int?

    /// Total countdown duration. Match Loom's pattern.
    private static let countdownDuration: Int = 3

    // MARK: - Timer

    private(set) var elapsedSeconds: TimeInterval = 0
    private var timerTask: Task<Void, Never>?
    private var recordingStartDate: Date?
    private var accumulatedBeforePause: TimeInterval = 0

    // MARK: - Result

    struct LastVideoInfo {
        let url: String
        let videoId: String
        let slug: String
        let title: String?
        let visibility: String
    }

    private(set) var lastVideo: LastVideoInfo?

    /// Set by `AppDelegate` at launch. Owned there because heal work spans
    /// app lifetime (startup scan + post-stop handoff).
    var healAgent: HealAgent?

    /// Set by `AppDelegate` at launch. Runs Whisper transcription in the
    /// background after recording completes, uploads SRT to the server.
    var transcribeAgent: TranscribeAgent?

    // MARK: - Pipeline

    private var recordingActor: RecordingActor?

    /// In-flight startup task — prepare + countdown + commit. Tracked so the
    /// user can cancel mid-countdown by hitting Stop.
    private var startupTask: Task<Void, Never>?

    /// Fired when the recording ends via a path that the AppDelegate didn't
    /// trigger itself — currently just the terminal-error escalation, where
    /// `handleTerminalRecordingError` stops the recording in response to a GPU
    /// failure rather than a user click. AppDelegate sets this to hide the
    /// floating RecordingPanel (which it owns) so the UI doesn't get left in a
    /// zombie state.
    ///
    /// Not used by the normal `stopRecording()` / `cancelRecording()` flows —
    /// AppDelegate hides the panel directly in its handlers for those.
    var onTerminalRecordingStop: (@MainActor () -> Void)?

    // MARK: - Popover Lifecycle

    /// True while the menu-bar popover is visible. Used to gate camera-preview
    /// session startup so the macOS camera indicator is only on when the user
    /// is actually looking at the popover (or a recording is running).
    private(set) var isPopoverOpen: Bool = false

    /// Background task that re-enumerates devices while the popover is open,
    /// so newly-plugged-in cameras / mics / displays appear without having
    /// to close and reopen the popover.
    private var deviceRefreshTask: Task<Void, Never>?

    /// How often to re-poll the device lists while the popover is open.
    private static let devicePollInterval: Duration = .seconds(2)

    /// Wait between flipping `state` to `.stopped` (post-recording) and
    /// flipping it back to `.idle`. Long enough for the user to glance at
    /// the toast / pasteboard-grab confirmation, short enough that
    /// reopening the popover shortly after a stop doesn't feel laggy.
    private static let stoppedToIdleDelay: Duration = .seconds(8)

    /// Notification observers active while the popover is open. Used to
    /// drive device list refreshes on hot-plug instead of polling.
    private var deviceHotPlugObservers: [NSObjectProtocol] = []

    /// Called when the menu-bar popover is about to become visible.
    /// Kicks off device enumeration + starts the relevant previews + begins
    /// polling for server health (devices use hot-plug notifications).
    func popoverDidOpen() {
        guard !isPopoverOpen else { return }
        isPopoverOpen = true

        Task { @MainActor in
            await self.checkServerHealth()
            await self.refreshDevices()
            self.updatePreviewsForCurrentState()
        }

        installDeviceHotPlugObservers()

        deviceRefreshTask?.cancel()
        deviceRefreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.devicePollInterval)
                if Task.isCancelled { break }
                if !self.isPopoverOpen { break }
                await self.checkServerHealth()
            }
        }
    }

    /// Called when the popover has closed. Stops previews and tears down
    /// the device polling task.
    func popoverWillClose() {
        guard isPopoverOpen else { return }
        isPopoverOpen = false

        deviceRefreshTask?.cancel()
        deviceRefreshTask = nil
        removeDeviceHotPlugObservers()

        // Only stop previews if we're idle. If recording is starting or in
        // progress, the recording flow manages the camera itself.
        if state == .idle {
            Task { @MainActor in
                await cameraPreview.stop()
                await microphonePreview.stop()
            }
            screenPreview.stop()
        }
    }

    private func installDeviceHotPlugObservers() {
        removeDeviceHotPlugObservers()
        let nc = NotificationCenter.default
        let names: [NSNotification.Name] = [
            .AVCaptureDeviceWasConnected,
            .AVCaptureDeviceWasDisconnected,
            NSApplication.didChangeScreenParametersNotification,
        ]
        deviceHotPlugObservers = names.map { name in
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in
                    await self?.refreshDevices()
                }
            }
        }
    }

    private func removeDeviceHotPlugObservers() {
        for observer in deviceHotPlugObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        deviceHotPlugObservers = []
    }

    /// Reconcile camera and screen preview lifecycles with the current
    /// popover + state + mode + selection. Call this after any of those
    /// change while in the idle/popover-open phase.
    private func updatePreviewsForCurrentState() {
        let idleInPopover = isPopoverOpen && state == .idle

        // Camera preview: needed whenever a camera is selected AND the
        // current mode includes camera.
        let wantsCamera = idleInPopover && selectedCamera != nil && mode != .screenOnly
        if wantsCamera, let camera = selectedCamera {
            Task { @MainActor in await cameraPreview.start(device: camera) }
        } else {
            Task { @MainActor in await cameraPreview.stop() }
        }

        // Screen preview: needed whenever a display is selected AND the
        // current mode includes screen.
        let wantsScreen = idleInPopover && selectedDisplay != nil && mode != .cameraOnly
        if wantsScreen, let display = selectedDisplay {
            screenPreview.start(display: display)
        } else {
            screenPreview.stop()
        }

        // Microphone preview: drives the input-level meter. Runs whenever a
        // mic is selected and the popover is open — independent of mode.
        let wantsMic = idleInPopover && selectedMicrophone != nil
        if wantsMic, let mic = selectedMicrophone {
            Task { @MainActor in await microphonePreview.start(device: mic) }
        } else {
            Task { @MainActor in await microphonePreview.stop() }
        }
    }

    // MARK: - Actions

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

        // Reset run state
        accumulatedBeforePause = 0
        elapsedSeconds = 0
        lastVideo = nil
        recordingStartDate = nil

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

            // 2. Wire the overlay frame callback before starting captures.
            // Capture the overlay reference by value (it's Sendable) so the
            // closure can call enqueue directly from the camera capture queue,
            // bypassing both the actor and the main thread for per-frame work.
            // The overlay was created by `updateCameraOverlayVisibility()`
            // before this task started.
            let overlay = self.cameraOverlay
            await actor.setOverlayCallback { [overlay] sampleBuffer in
                overlay?.enqueue(sampleBuffer)
            }

            // Wire the PiP quadrant callback. When the user drags the
            // overlay into a different quadrant, update the compositor's
            // position so the composited output matches.
            self.cameraOverlay?.onQuadrantChanged = { [weak self] newPosition in
                guard let self else { return }
                Task { await self.recordingActor?.switchPipPosition(to: newPosition) }
            }

            // Wire the terminal-error callback. Fires at most once per
            // recording, from a detached task inside the actor, when the
            // compositor reports a failure that rebuild can't recover from.
            // Hop to the main actor and run the normal stop flow plus a
            // user-visible alert.
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

            // Wire the camera-adjustments state box. The compositor reads
            // from it on every frame so slider moves take effect immediately
            // on the composited HLS output.
            await actor.setCameraAdjustmentsState(self.cameraAdjustmentsState)

            // 3. Kick off the slow setup (server session, capture hardware,
            // audio wait) IN PARALLEL with the visible countdown.
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

            // 4. Tick down the countdown: 3 → 2 → 1.
            for n in stride(from: Self.countdownDuration, through: 1, by: -1) {
                if Task.isCancelled { break }
                self.countdownSeconds = n
                try? await Task.sleep(for: .seconds(1))
            }

            // 5. Cancellation check — if user hit Stop during countdown, bail.
            if Task.isCancelled {
                prepareTask.cancel()
                _ = await prepareTask.value
                await actor.cancelPreparation()
                self.cleanupAfterCancellation()
                return
            }

            // 6. Wait for prepare to actually finish (it usually does well
            // before the countdown ends, but mic startup can be slow).
            self.countdownSeconds = 0
            let prepared = await prepareTask.value

            if Task.isCancelled || prepared == nil {
                await actor.cancelPreparation()
                self.cleanupAfterCancellation()
                return
            }

            // 7. Commit: anchors the recording clock, starts writer, starts metronome.
            await actor.commitRecording()

            // 8. Transition to recording state.
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

    /// Reset state when the startup task is cancelled or fails before commit.
    private func cleanupAfterCancellation() {
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

    // MARK: - Device Enumeration

    /// True after the first successful `refreshDevices` call has populated
    /// initial source selections. Once set, subsequent refreshes don't
    /// override `nil` selections — that lets the user explicitly choose
    /// "None" without it being clobbered by the next device-poll tick.
    var didApplyInitialDefaults = false

    // MARK: - Terminal Recording Error

    /// Invoked from `RecordingActor`'s terminal-error callback when the
    /// compositor reports a render failure that rebuild can't recover from.
    /// Runs the normal stop flow so local files are flushed cleanly and then
    /// surfaces an alert to the user. No-op if we've already moved out of the
    /// recording state (e.g. the user hit Stop between the failure and the
    /// hop to main).
    private func handleTerminalRecordingError(_ message: String) {
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

    private func updateCameraOverlayVisibility() {
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
    private func startAppLaunchObserver() {
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

    private func stopAppLaunchObserver() {
        if let observer = appLaunchObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            appLaunchObserver = nil
        }
    }

    // MARK: - Timer

    private func startTimer() {
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.state == .recording else { continue }
                let elapsed = Date().timeIntervalSince(self.recordingStartDate ?? Date())
                self.elapsedSeconds = self.accumulatedBeforePause + elapsed
            }
        }
    }

    private func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }
}
