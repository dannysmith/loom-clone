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
            }
        }
    }

    // MARK: - Device Selection

    var availableDisplays: [SCDisplay] = []
    var availableCameras: [AVCaptureDevice] = []
    var availableMicrophones: [AVCaptureDevice] = []

    var selectedDisplay: SCDisplay?
    var selectedCamera: AVCaptureDevice? {
        didSet {
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

    // MARK: - Camera Preview & Overlay

    let cameraPreview = CameraPreviewManager()
    private var cameraOverlay: CameraOverlayWindow?

    // MARK: - Permissions

    private(set) var screenPermissionDenied = false

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

        startupTask = Task { @MainActor in
            // 1. Stop the camera preview and AWAIT it. The recording session
            // can't start until CMIO has fully released the device, so we
            // explicitly wait for stopRunning() before proceeding.
            await cameraPreview.stop()

            // 2. Wire the overlay frame callback before starting captures.
            await actor.setOverlayCallback { [weak self] pixelBuffer in
                DispatchQueue.main.async {
                    self?.cameraOverlay?.updateFrame(pixelBuffer)
                }
            }

            // 3. Kick off the slow setup (server session, capture hardware,
            // audio wait) IN PARALLEL with the visible countdown.
            let prepareTask = Task { () -> (id: String, slug: String)? in
                do {
                    return try await actor.prepareRecording(
                        displayID: displayID,
                        cameraID: cameraID,
                        microphoneID: micID,
                        mode: currentMode
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
        // Restart preview if a camera is selected
        if let camera = selectedCamera {
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

        // Restart camera preview now that recording is done
        if let camera = selectedCamera {
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
            if selectedDisplay == nil {
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
        if selectedCamera == nil {
            selectedCamera = availableCameras.first
        }

        // Microphones
        let micDiscovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        availableMicrophones = micDiscovery.devices
        if selectedMicrophone == nil {
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
            cameraOverlay?.show(on: nil)
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
