@preconcurrency import AVFoundation
import CoreMedia

/// Manages a lightweight AVCaptureSession used to feed live camera frames to
/// the popover preview before recording starts. Separate from `CameraCaptureManager`
/// which owns the recording session.
///
/// Frames are exposed via `onSampleBuffer` callback (fired from the capture
/// queue) so consumers can render them through `AVSampleBufferDisplayLayer`.
@MainActor
@Observable
final class CameraPreviewManager: NSObject {

    /// Observable presence flag — true when the preview session is live.
    /// SwiftUI views read this to decide whether to show the preview area.
    private(set) var isActive: Bool = false

    /// Set by consumers to receive live sample buffers. Called from the
    /// capture queue (a high-priority dispatch queue), not the main thread.
    /// Excluded from `@Observable` tracking — the macro's generated code can't
    /// coexist with `nonisolated` on a stored property.
    @ObservationIgnored
    nonisolated(unsafe) var onSampleBuffer: (@Sendable (CMSampleBuffer) -> Void)?

    private var session: AVCaptureSession?
    private var currentDeviceID: String?
    private let captureQueue = DispatchQueue(
        label: "com.loomclone.camera-preview",
        qos: .userInteractive
    )

    /// Start the preview session for `device`. Awaits the AVCaptureSession's
    /// `startRunning()` so callers know the hardware is actually live before
    /// they proceed (avoids CMIO contention with the recording session).
    func start(device: AVCaptureDevice) async {
        // Skip if already running with this device
        if device.uniqueID == currentDeviceID, session?.isRunning == true { return }
        await stop()

        let session = AVCaptureSession()
        session.beginConfiguration()
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

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: captureQueue)
        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
        self.session = session
        self.currentDeviceID = device.uniqueID

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        self.isActive = true
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
        isActive = false
        print("[camera-preview] Stopped")
    }
}

extension CameraPreviewManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        onSampleBuffer?(sampleBuffer)
    }
}
