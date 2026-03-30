import Foundation
@preconcurrency import AVFoundation
import CoreMedia

final class MicrophoneCaptureManager: NSObject, @unchecked Sendable {

    var onAudioSample: (@Sendable (CMSampleBuffer) -> Void)?

    private var session: AVCaptureSession?
    private let captureQueue = DispatchQueue(label: "com.loomclone.mic-capture", qos: .userInteractive)

    static func availableDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        ).devices
    }

    func startCapture(device: AVCaptureDevice) async {
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            print("[mic] Permission denied")
            return
        }

        let session = AVCaptureSession()
        session.beginConfiguration()

        do {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) {
                session.addInput(input)
            }
        } catch {
            print("[mic] Failed to create input: \(error)")
            return
        }

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: captureQueue)

        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
        self.session = session

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
            print("[mic] Capture started: \(device.localizedName)")
        }
    }

    func stopCapture() {
        session?.stopRunning()
        session = nil
        print("[mic] Capture stopped")
    }
}

extension MicrophoneCaptureManager: AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        onAudioSample?(sampleBuffer)
    }
}
