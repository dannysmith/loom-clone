import AVFoundation

/// Manages a lightweight AVCaptureSession solely for camera preview display.
/// Used for popover preview (before recording) and the camera overlay (during recording).
/// This is separate from CameraCaptureManager which handles frame delivery for encoding.
@MainActor
@Observable
final class CameraPreviewManager {

    private(set) var session: AVCaptureSession?
    private var currentDeviceID: String?

    var isRunning: Bool { session?.isRunning ?? false }

    func start(device: AVCaptureDevice) {
        // Skip if already running with this device
        if device.uniqueID == currentDeviceID, session?.isRunning == true { return }
        stop()

        let session = AVCaptureSession()
        session.sessionPreset = .high

        do {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) {
                session.addInput(input)
            }
        } catch {
            print("[camera-preview] Failed to create input: \(error)")
            return
        }

        self.session = session
        self.currentDeviceID = device.uniqueID

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
            print("[camera-preview] Started: \(device.localizedName)")
        }
    }

    func stop() {
        session?.stopRunning()
        session = nil
        currentDeviceID = nil
    }
}
