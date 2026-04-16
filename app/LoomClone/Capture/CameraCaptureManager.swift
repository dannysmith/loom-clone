@preconcurrency import AVFoundation
import CoreMedia
import Foundation

final class CameraCaptureManager: NSObject, @unchecked Sendable {
    var onCameraFrame: (@Sendable (CMSampleBuffer) -> Void)?

    private var session: AVCaptureSession?
    private let captureQueue = DispatchQueue(label: "com.loomclone.camera-capture", qos: .userInteractive)

    /// Minimum acceptable max frame rate when selecting a format. 29.0 fps
    /// with the tolerance lets NTSC cameras through (they advertise 29.97 =
    /// 1001/30000, which a strict 30.0 check rejected) while still excluding
    /// PAL-locked cameras that only offer 25fps.
    private static let minAcceptableFrameRate: Double = 29.0

    /// Pick the "best" format for a device subject to a max height cap.
    /// Highest resolution that still fits under the cap and supports
    /// ≈30fps (see `minAcceptableFrameRate`). Returns nil if no format
    /// matches — caller should fall back.
    static func bestFormat(for device: AVCaptureDevice, maxHeight: Int) -> AVCaptureDevice.Format? {
        let candidates = device.formats.filter { format in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Int(dims.height) <= maxHeight else { return false }
            return format.videoSupportedFrameRateRanges.contains {
                $0.maxFrameRate >= minAcceptableFrameRate
            }
        }
        return candidates.max { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return (Int(da.width) * Int(da.height)) < (Int(db.width) * Int(db.height))
        }
    }

    /// Maximum height a device can deliver at ≈30fps. Used by the coordinator
    /// to gate the 4K preset in cameraOnly mode.
    static func maxNativeHeight(for device: AVCaptureDevice) -> Int {
        var maxH = 0
        for format in device.formats {
            let supports30 = format.videoSupportedFrameRateRanges.contains {
                $0.maxFrameRate >= minAcceptableFrameRate
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

    /// Native pixel dimensions of the format AVCaptureSession is actually
    /// delivering. Set unconditionally after `startCapture` returns —
    /// reflects the device's `activeFormat` regardless of whether the
    /// configured preset, the explicit `bestFormat` path, or the `.high`
    /// fallback was used. Used by the recording actor to declare the raw
    /// camera writer's dimensions.
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
                // Only lock the frame rate when 1/30 is within the format's
                // supported duration range. UVC cameras like the ZV-1
                // advertise fixed-rate ranges whose min and max duration
                // are both `1000000/30000030` (essentially-but-not-exactly
                // 30fps — UVC intervals are stored in 100ns units, which
                // doesn't hit 1/30 on the nose). Setting
                // activeVideoMinFrameDuration to CMTime(1, 30) in that
                // case throws NSInvalidArgumentException — an ObjC
                // exception Swift's `try/catch` can't catch, which
                // crashes the app. When 1/30 isn't in range, the format's
                // own rate applies (30.00003 fps on the ZV-1, 30 exactly
                // on cameras that report it that way) — leave it alone.
                let thirtyDur = CMTime(value: 1, timescale: 30)
                if best.videoSupportedFrameRateRanges.contains(where: {
                    $0.minFrameDuration <= thirtyDur && thirtyDur <= $0.maxFrameDuration
                }) {
                    device.activeVideoMinFrameDuration = thirtyDur
                    device.activeVideoMaxFrameDuration = thirtyDur
                }
                device.unlockForConfiguration()
                let dims = CMVideoFormatDescriptionGetDimensions(best.formatDescription)
                let rate = best.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
                print(String(
                    format: "[camera] Selected format: %dx%d @ %.2ffps (cap: %d)",
                    dims.width,
                    dims.height,
                    min(rate, 30.0),
                    maxHeight
                ))
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
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
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

        // Now that the session is actually running, read the device's
        // active format dims. This is the source of truth: it works whether
        // we configured a specific format above or fell through to .high
        // (which mutates `device.activeFormat` itself when the session is
        // applied). Previously we only set `nativePixelSize` inside the
        // `bestFormat` success branch, which meant cameras whose format
        // discovery returned nil (e.g. ZV-1 over USB) silently left the
        // size at zero — and the raw camera writer was never created.
        let activeDims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        nativePixelSize = CGSize(width: Int(activeDims.width), height: Int(activeDims.height))
        print("[camera] Capture started: \(device.localizedName) @ \(activeDims.width)x\(activeDims.height)")

        // Format introspection — logs what the active format declares for
        // pixel format + colour metadata. Many USB cameras and capture cards
        // deliver buffers with missing or inconsistent colour extensions,
        // which is why the delegate callback tags pixel buffers explicitly
        // with Rec. 709 before forwarding. Logging the declared values at
        // startup gives us a diagnostic trail for future camera debugging.
        let fmtDesc = device.activeFormat.formatDescription
        let subType = CMFormatDescriptionGetMediaSubType(fmtDesc)
        let subTypeStr = String(
            format: "%c%c%c%c",
            (subType >> 24) & 0xFF,
            (subType >> 16) & 0xFF,
            (subType >> 8) & 0xFF,
            subType & 0xFF
        )
        let primaries = CMFormatDescriptionGetExtension(fmtDesc, extensionKey: kCMFormatDescriptionExtension_ColorPrimaries) as? String ?? "none"
        let transfer = CMFormatDescriptionGetExtension(fmtDesc, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String ??
            "none"
        let matrix = CMFormatDescriptionGetExtension(fmtDesc, extensionKey: kCMFormatDescriptionExtension_YCbCrMatrix) as? String ?? "none"
        print("[camera] Format introspection: subType=\(subTypeStr) primaries=\(primaries) transfer=\(transfer) matrix=\(matrix)")
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
        _: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from _: AVCaptureConnection
    ) {
        // Tag the pixel buffer with explicit Rec. 709 colour metadata before
        // forwarding. Many USB cameras (ZV-1, generic
        // capture cards) deliver buffers without YCbCrMatrix / TransferFunction
        // / ColorPrimaries attachments — CIContext then runs an expensive
        // multi-stage colourspace conversion chain on every frame because it
        // can't know the source space. Rec. 709 is the correct default for
        // SDR consumer cameras (Apple TN2227, QA1839). `.shouldPropagate` so
        // both CIImage and AVAssetWriter honour the tags downstream.
        if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
            let attachments: [CFString: Any] = [
                kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
                kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_ITU_R_709_2,
            ]
            CVBufferSetAttachments(pixelBuffer, attachments as CFDictionary, .shouldPropagate)
        }
        onCameraFrame?(sampleBuffer)
    }
}
