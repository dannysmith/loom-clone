@preconcurrency import AVFoundation

/// Manages a lightweight AVCaptureSession solely for camera preview display.
/// Used for popover preview (before recording) and the camera overlay (during recording).
/// This is separate from CameraCaptureManager which handles frame delivery for encoding.
@MainActor
@Observable
final class CameraPreviewManager {

    private(set) var session: AVCaptureSession?
    private var currentDeviceID: String?

    var isRunning: Bool { session?.isRunning ?? false }

    /// Start the preview session for `device`. Awaits the AVCaptureSession's
    /// `startRunning()` so callers know the hardware is actually live before
    /// they proceed (avoids CMIO contention with the recording session).
    func start(device: AVCaptureDevice) async {
        // Skip if already running with this device
        if device.uniqueID == currentDeviceID, session?.isRunning == true { return }
        await stop()

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

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        print("[camera-preview] Started: \(device.localizedName)")
    }

    /// Stop the preview session and wait for the CMIO device to be released.
    /// This must complete before the recording camera session starts or the
    /// system throws "HALB_IOThread::_Start: there already is a thread" errors.
    func stop() async {
        guard let session else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
                continuation.resume()
            }
        }
        self.session = nil
        currentDeviceID = nil
        print("[camera-preview] Stopped")
    }
}
