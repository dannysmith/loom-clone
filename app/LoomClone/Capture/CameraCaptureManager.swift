import Foundation
@preconcurrency import AVFoundation
import CoreMedia

final class CameraCaptureManager: NSObject, @unchecked Sendable {

    var onCameraFrame: (@Sendable (CMSampleBuffer) -> Void)?

    private var session: AVCaptureSession?
    private let captureQueue = DispatchQueue(label: "com.loomclone.camera-capture", qos: .userInteractive)

    /// Pick the "best" format for a device subject to a max height cap.
    /// Highest resolution that still fits under the cap and supports ≥30fps.
    /// Returns nil if no format matches — caller should fall back.
    static func bestFormat(for device: AVCaptureDevice, maxHeight: Int) -> AVCaptureDevice.Format? {
        let targetDur = CMTime(value: 1, timescale: 30)
        let candidates = device.formats.filter { format in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Int(dims.height) <= maxHeight else { return false }
            return format.videoSupportedFrameRateRanges.contains {
                $0.minFrameDuration <= targetDur && targetDur <= $0.maxFrameDuration
            }
        }
        return candidates.max { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return (Int(da.width) * Int(da.height)) < (Int(db.width) * Int(db.height))
        }
    }

    /// Maximum height a device can deliver at ≥30fps. Used by the coordinator
    /// to gate the 4K preset in cameraOnly mode.
    static func maxNativeHeight(for device: AVCaptureDevice) -> Int {
        let targetDur = CMTime(value: 1, timescale: 30)
        var maxH = 0
        for format in device.formats {
            let supports30 = format.videoSupportedFrameRateRanges.contains {
                $0.minFrameDuration <= targetDur && targetDur <= $0.maxFrameDuration
            }
            guard supports30 else { continue }
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            if Int(dims.height) > maxH { maxH = Int(dims.height) }
        }
        return maxH
    }

    static func availableDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    /// Native pixel dimensions of the active capture format. Set after
    /// `startCapture` resolves the best format for the requested max height.
    private(set) var nativePixelSize: CGSize = .zero

    func startCapture(device: AVCaptureDevice, maxHeight: Int = Int.max) async {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else {
            print("[camera] Permission denied")
            return
        }

        let session = AVCaptureSession()
        session.beginConfiguration()

        // Pick the highest-resolution format whose height is <= maxHeight and
        // supports at least 30fps. This lets a good camera (4K webcam, DSLR
        // via capture card) deliver at the output preset's height rather than
        // being pegged to AVCaptureSession.Preset.high's ~720p default.
        if let best = Self.bestFormat(for: device, maxHeight: maxHeight) {
            do {
                try device.lockForConfiguration()
                device.activeFormat = best
                let targetDur = CMTime(value: 1, timescale: 30)
                if best.videoSupportedFrameRateRanges.contains(where: {
                    $0.minFrameDuration <= targetDur && targetDur <= $0.maxFrameDuration
                }) {
                    device.activeVideoMinFrameDuration = targetDur
                    device.activeVideoMaxFrameDuration = targetDur
                }
                device.unlockForConfiguration()
                let dims = CMVideoFormatDescriptionGetDimensions(best.formatDescription)
                nativePixelSize = CGSize(width: Int(dims.width), height: Int(dims.height))
                print("[camera] Selected format: \(dims.width)x\(dims.height) @ 30fps (cap: \(maxHeight))")
            } catch {
                print("[camera] Could not set activeFormat: \(error) — falling back to .high")
                session.sessionPreset = .high
            }
        } else {
            session.sessionPreset = .high
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) {
                session.addInput(input)
            }
        } catch {
            print("[camera] Failed to create input: \(error)")
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

        // startRunning() blocks until the session is actually running. Wait for
        // it to complete before returning so callers don't race against the
        // hardware coming up.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        print("[camera] Capture started: \(device.localizedName)")
    }

    func stopCapture() async {
        guard let session else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
                continuation.resume()
            }
        }
        self.session = nil
        print("[camera] Capture stopped")
    }
}

extension CameraCaptureManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        onCameraFrame?(sampleBuffer)
    }
}
