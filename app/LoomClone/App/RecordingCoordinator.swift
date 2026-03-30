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
            guard state == .recording || state == .paused else { return }
            Task { await recordingActor?.switchMode(to: mode) }
        }
    }

    // MARK: - Device Selection

    var availableDisplays: [SCDisplay] = []
    var availableCameras: [AVCaptureDevice] = []
    var availableMicrophones: [AVCaptureDevice] = []

    var selectedDisplay: SCDisplay?
    var selectedCamera: AVCaptureDevice?
    var selectedMicrophone: AVCaptureDevice?

    // MARK: - Permissions

    private(set) var screenPermissionDenied = false

    // MARK: - Timer

    private(set) var elapsedSeconds: TimeInterval = 0
    private var timerTask: Task<Void, Never>?
    private var recordingStartDate: Date?
    private var accumulatedBeforePause: TimeInterval = 0

    // MARK: - Result

    private(set) var lastVideoURL: String?

    // MARK: - Pipeline

    private var recordingActor: RecordingActor?

    // MARK: - Actions

    func startRecording() {
        guard state == .idle else { return }
        guard let display = selectedDisplay else {
            print("[coordinator] No display selected — screen permission may be missing")
            return
        }

        state = .recording
        recordingStartDate = Date()
        accumulatedBeforePause = 0
        elapsedSeconds = 0
        lastVideoURL = nil
        startTimer()

        let actor = RecordingActor()
        recordingActor = actor

        let displayID = display.displayID
        let cameraID = selectedCamera?.uniqueID
        let micID = selectedMicrophone?.uniqueID
        let currentMode = mode

        Task {
            do {
                let _ = try await actor.startRecording(
                    displayID: displayID,
                    cameraID: cameraID,
                    microphoneID: micID,
                    mode: currentMode
                )
            } catch {
                print("[coordinator] Failed to start recording: \(error)")
                self.state = .idle
                self.stopTimer()
            }
        }
    }

    func stopRecording() {
        guard state == .recording || state == .paused else { return }
        state = .stopped
        stopTimer()

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
