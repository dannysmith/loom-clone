import Foundation
import ScreenCaptureKit
import AVFoundation

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

    var selectedDisplay: SCDisplay? {
        didSet {
            // If the screen preview is active, re-capture for the new
            // display. `ScreenPreviewManager.start` no-ops if already on the
            // same display, so the refresh-polling path can call it freely.
            guard isPopoverOpen, state == .idle, mode != .cameraOnly else { return }
            if let display = selectedDisplay {
                screenPreview.start(display: display)
            }
        }
    }
    var selectedCamera: AVCaptureDevice? {
        didSet {
            // Only act on the selection change if the preview is actually
            // running right now. Starting the preview is owned by
            // `updatePreviewsForCurrentState()` — not by the selection itself —
            // so that the camera hardware (and the macOS green indicator) is
            // only active while the popover is open and a camera-bearing mode
            // is selected.
            guard cameraPreview.isActive else { return }
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
    var selectedMicrophone: AVCaptureDevice?

    // MARK: - Output Preset

    /// Resolution + bitrate of the encoded HLS stream. Capture happens at
    /// native resolution regardless; this controls what the compositor
    /// renders into and what the encoder produces.
    private static let outputPresetDefaultsKey = "outputPresetID"
    var outputPreset: OutputPreset = OutputPreset.fromID(
        UserDefaults.standard.string(forKey: "outputPresetID") ?? OutputPreset.default.id
    ) {
        didSet {
            UserDefaults.standard.set(outputPreset.id, forKey: Self.outputPresetDefaultsKey)
        }
    }

    /// True if 4K is meaningful for *any* mode the user could switch into
    /// during this recording. Devices can't change mid-recording, but mode
    /// can — so 4K is offered whenever EITHER the selected display or the
    /// selected camera can natively feed it.
    var is4KAvailable: Bool {
        let displayOK: Bool = {
            guard let display = selectedDisplay else { return false }
            return Int(ScreenCaptureManager.nativePixelSize(for: display).height) >= 2160
        }()
        let cameraOK: Bool = {
            guard let cam = selectedCamera else { return false }
            return CameraCaptureManager.maxNativeHeight(for: cam) >= 2160
        }()
        return displayOK || cameraOK
    }

    // MARK: - Camera Preview & Overlay

    let cameraPreview = CameraPreviewManager()
    let screenPreview = ScreenPreviewManager()
    private var cameraOverlay: CameraOverlayWindow?

    // MARK: - Permissions

    private(set) var screenPermissionDenied = false

    // MARK: - Server Reachability

    /// Set by `checkServerHealth()`. `true` when the recording server
    /// responded 200 to GET /api/health. Default is `false` so the Record
    /// button is disabled until we've confirmed the server is up.
    private(set) var serverReachable: Bool = false

    private static let serverBaseURL = "http://localhost:3000"
    private static let healthCheckTimeout: TimeInterval = 2.0

    func checkServerHealth() async {
        guard let url = URL(string: "\(Self.serverBaseURL)/api/health") else {
            serverReachable = false
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = Self.healthCheckTimeout
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                serverReachable = true
            } else {
                serverReachable = false
            }
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

    private(set) var lastVideoURL: String?

    // MARK: - Pipeline

    private var recordingActor: RecordingActor?

    /// In-flight startup task — prepare + countdown + commit. Tracked so the
    /// user can cancel mid-countdown by hitting Stop.
    private var startupTask: Task<Void, Never>?

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

    /// Called when the menu-bar popover is about to become visible.
    /// Kicks off device enumeration + starts the relevant previews + begins
    /// polling for device hot-plug events.
    func popoverDidOpen() {
        guard !isPopoverOpen else { return }
        isPopoverOpen = true

        Task { @MainActor in
            await self.checkServerHealth()
            await self.refreshDevices()
            self.updatePreviewsForCurrentState()
        }

        deviceRefreshTask?.cancel()
        deviceRefreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.devicePollInterval)
                if Task.isCancelled { break }
                if !self.isPopoverOpen { break }
                await self.checkServerHealth()
                await self.refreshDevices()
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

        // Only stop previews if we're idle. If recording is starting or in
        // progress, the recording flow manages the camera itself.
        if state == .idle {
            Task { @MainActor in
                await cameraPreview.stop()
            }
            screenPreview.stop()
        }
    }

    /// Reconcile camera and screen preview lifecycles with the current
    /// popover + state + mode + selection. Call this after any of those
    /// change while in the idle/popover-open phase.
    private func updatePreviewsForCurrentState() {
        let idleInPopover = isPopoverOpen && state == .idle

        // Camera preview: needed whenever camera is part of the output.
        let wantsCamera = idleInPopover && mode != .screenOnly
        if wantsCamera, let camera = selectedCamera {
            Task { @MainActor in await cameraPreview.start(device: camera) }
        } else {
            Task { @MainActor in await cameraPreview.stop() }
        }

        // Screen preview: needed whenever screen is part of the output.
        let wantsScreen = idleInPopover && mode != .cameraOnly
        if wantsScreen, let display = selectedDisplay {
            screenPreview.start(display: display)
        } else {
            screenPreview.stop()
        }
    }

    // MARK: - Actions

    func startRecording() {
        guard state == .idle else { return }
        guard let display = selectedDisplay else {
            print("[coordinator] No display selected — screen permission may be missing")
            return
        }

        // Reset run state
        accumulatedBeforePause = 0
        elapsedSeconds = 0
        lastVideoURL = nil
        recordingStartDate = nil

        // Enter the countdown state immediately so the panel renders.
        state = .countingDown
        countdownSeconds = Self.countdownDuration
        updateCameraOverlayVisibility()

        let actor = RecordingActor()
        recordingActor = actor

        let displayID = display.displayID
        let cameraID = selectedCamera?.uniqueID
        let micID = selectedMicrophone?.uniqueID
        let currentMode = mode
        let currentPreset = outputPreset

        startupTask = Task { @MainActor in
            // 1. Stop the previews. Camera preview must be AWAITED — the
            // recording session can't start until CMIO has fully released
            // the device. Screen preview is a fire-and-forget snapshot task,
            // just cancel it.
            await cameraPreview.stop()
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

            // 3. Kick off the slow setup (server session, capture hardware,
            // audio wait) IN PARALLEL with the visible countdown.
            let prepareTask = Task { () -> (id: String, slug: String)? in
                do {
                    return try await actor.prepareRecording(
                        displayID: displayID,
                        cameraID: cameraID,
                        microphoneID: micID,
                        mode: currentMode,
                        preset: currentPreset
                    )
                } catch {
                    print("[coordinator] prepareRecording failed: \(error)")
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
        }
    }

    /// Reset state when the startup task is cancelled or fails before commit.
    private func cleanupAfterCancellation() {
        countdownSeconds = nil
        state = .idle
        recordingActor = nil
        cameraOverlay?.hide()
        // Only restart the preview if the popover is still open. Otherwise
        // we'd silently re-activate the camera with the popover closed,
        // which is exactly what we're trying to avoid.
        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
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
        cameraOverlay?.hide()

        // Only restart the preview if the popover is still open (rare —
        // usually the popover has been closed since before recording started).
        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
        }

        Task {
            let url = await recordingActor?.stopRecording()
            self.lastVideoURL = url
            self.recordingActor = nil

            try? await Task.sleep(for: .seconds(8))
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
        cameraOverlay?.hide()

        if isPopoverOpen, let camera = selectedCamera {
            Task { await cameraPreview.start(device: camera) }
        }

        Task {
            await recordingActor?.cancelRecording()
            self.recordingActor = nil
            self.lastVideoURL = nil
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

    func cycleMode() {
        mode = mode.next()
    }

    // MARK: - Device Enumeration

    func refreshDevices() async {
        // Screens — may fail if screen recording permission not granted
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            screenPermissionDenied = false
            availableDisplays = content.displays
            // If the previously-selected display is no longer available,
            // fall back to the first one.
            if let current = selectedDisplay,
               !availableDisplays.contains(where: { $0.displayID == current.displayID }) {
                selectedDisplay = availableDisplays.first
            } else if selectedDisplay == nil {
                selectedDisplay = availableDisplays.first
            }
        } catch let error as NSError {
            // TCC denial: Code -3801
            if error.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && error.code == -3801 {
                screenPermissionDenied = true
                print("[devices] Screen recording permission denied — user must grant in System Settings")
            } else {
                print("[devices] Failed to enumerate displays: \(error)")
            }
        }

        // Cameras
        let cameraDiscovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        )
        availableCameras = cameraDiscovery.devices
        if let current = selectedCamera,
           !availableCameras.contains(where: { $0.uniqueID == current.uniqueID }) {
            selectedCamera = availableCameras.first
        } else if selectedCamera == nil {
            selectedCamera = availableCameras.first
        }

        // Microphones
        let micDiscovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        availableMicrophones = micDiscovery.devices
        if let current = selectedMicrophone,
           !availableMicrophones.contains(where: { $0.uniqueID == current.uniqueID }) {
            selectedMicrophone = availableMicrophones.first
        } else if selectedMicrophone == nil {
            selectedMicrophone = availableMicrophones.first
        }
    }

    func openScreenRecordingSettings() {
        // Works on macOS 13+: opens directly to Screen Recording pane
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    func retryScreenPermission() async {
        screenPermissionDenied = false
        await refreshDevices()
    }

    // MARK: - Camera Overlay

    private func updateCameraOverlayVisibility() {
        let activeStates: Set<RecordingState> = [.countingDown, .recording, .paused]
        guard activeStates.contains(state) else {
            cameraOverlay?.hide()
            return
        }

        if mode != .screenOnly {
            if cameraOverlay == nil {
                cameraOverlay = CameraOverlayWindow()
            }
            // Match the overlay shape to the compositor's output:
            //   - cameraOnly   → full 16:9 frame (rectangle)
            //   - screenAndCamera → circular PiP (circle)
            let style: CameraOverlayWindow.Style = (mode == .cameraOnly) ? .rectangle : .circle
            cameraOverlay?.show(on: nil, style: style)
        } else {
            cameraOverlay?.hide()
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
