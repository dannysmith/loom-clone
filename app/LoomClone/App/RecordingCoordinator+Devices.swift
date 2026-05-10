import AVFoundation
import ScreenCaptureKit

extension RecordingCoordinator {
    // MARK: - Device Enumeration

    func refreshDevices() async {
        // Screens — may fail if screen recording permission not granted
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            screenPermissionDenied = false
            let newDisplays = content.displays
            if newDisplays.map(\.displayID) != availableDisplays.map(\.displayID) {
                availableDisplays = newDisplays
            }
            if let current = selectedDisplay,
               !availableDisplays.contains(where: { $0.displayID == current.displayID })
            {
                selectedDisplay = availableDisplays.first
            }
        } catch let error as NSError {
            // TCC denial: Code -3801
            if error.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain", error.code == -3801 {
                screenPermissionDenied = true
                Log.devices.log("Screen recording permission denied — user must grant in System Settings")
            } else {
                Log.devices.log("Failed to enumerate displays: \(error)")
            }
        }

        // Cameras
        let cameraDiscovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        )
        let newCameras = cameraDiscovery.devices
        if newCameras.map(\.uniqueID) != availableCameras.map(\.uniqueID) {
            availableCameras = newCameras
        }
        if let current = selectedCamera,
           !availableCameras.contains(where: { $0.uniqueID == current.uniqueID })
        {
            selectedCamera = availableCameras.first
        }

        // Microphones
        let micDiscovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        let newMics = micDiscovery.devices
        if newMics.map(\.uniqueID) != availableMicrophones.map(\.uniqueID) {
            availableMicrophones = newMics
        }
        if let current = selectedMicrophone,
           !availableMicrophones.contains(where: { $0.uniqueID == current.uniqueID })
        {
            selectedMicrophone = availableMicrophones.first
        }

        // First-time defaults: pick the first display, first camera, and the
        // *system default* microphone. Subsequent refreshes don't auto-fill
        // nil selections — that's what the user is asking for when they pick
        // "None."
        if !didApplyInitialDefaults {
            if selectedDisplay == nil { selectedDisplay = availableDisplays.first }
            if selectedCamera == nil { selectedCamera = availableCameras.first }
            if selectedMicrophone == nil {
                selectedMicrophone = AVCaptureDevice.default(for: .audio)
                    ?? availableMicrophones.first
            }
            didApplyInitialDefaults = true
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
}
