@preconcurrency import AVFoundation
import CoreMedia
import Foundation

final class CameraCaptureManager: NSObject, @unchecked Sendable {
    var onCameraFrame: (@Sendable (CMSampleBuffer) -> Void)?
    var onAudioSample: (@Sendable (CMSampleBuffer) -> Void)?
    var onSessionError: (@Sendable (Error) -> Void)?
    var onSessionInterrupted: (@Sendable () -> Void)?

    private var session: AVCaptureSession?
    private let captureQueue = DispatchQueue(label: "com.loomclone.camera-capture", qos: .userInteractive)
    private let audioCaptureQueue = DispatchQueue(label: "com.loomclone.camera-audio-capture", qos: .userInteractive)
    private var audioOutput: AVCaptureAudioDataOutput?
    private var sessionObservers: [NSObjectProtocol] = []

    /// True when this session includes a mic audio input/output alongside
    /// the camera video. Set during `startCapture` when a `micDevice` is
    /// provided and successfully added to the session. Used by RecordingActor
    /// to decide audio routing (shared session vs standalone mic).
    private(set) var hasAudioCapture: Bool = false

    /// Pick the "best" format for a device subject to a max height cap
    /// and a target frame rate. Highest resolution that still fits under
    /// the cap and supports the target fps (with NTSC tolerance: 29.97
    /// passes ≥ 29.0, 59.94 passes ≥ 59.0). Returns nil if no format
    /// matches — caller should fall back.
    static func bestFormat(
        for device: AVCaptureDevice,
        maxHeight: Int,
        targetFPS: FrameRate = .thirtyFPS
    ) -> AVCaptureDevice.Format? {
        let minRate = targetFPS.minAcceptableRate
        let candidates = device.formats.filter { format in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Int(dims.height) <= maxHeight else { return false }
            return format.videoSupportedFrameRateRanges.contains {
                $0.maxFrameRate >= minRate
            }
        }
        return candidates.max { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return (Int(da.width) * Int(da.height)) < (Int(db.width) * Int(db.height))
        }
    }

    /// Maximum height a device can deliver at ≈30fps. Used by the coordinator
    /// to gate the 1440p preset. Resolution availability is fps-agnostic
    /// (we always support 30fps at any resolution).
    static func maxNativeHeight(for device: AVCaptureDevice) -> Int {
        let minRate = FrameRate.thirtyFPS.minAcceptableRate
        var maxH = 0
        for format in device.formats {
            let supports30 = format.videoSupportedFrameRateRanges.contains {
                $0.maxFrameRate >= minRate
            }
            guard supports30 else { continue }
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            if Int(dims.height) > maxH { maxH = Int(dims.height) }
        }
        return maxH
    }

    /// Whether the device has any format at ≤ maxHeight that supports
    /// ≈60fps. Used by the coordinator to gate the 60fps toggle.
    static func supports60fps(for device: AVCaptureDevice, maxHeight: Int) -> Bool {
        let minRate = FrameRate.sixtyFPS.minAcceptableRate
        return device.formats.contains { format in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Int(dims.height) <= maxHeight else { return false }
            return format.videoSupportedFrameRateRanges.contains {
                $0.maxFrameRate >= minRate
            }
        }
    }

    /// Diagnostics: capture every advertised format for a device into the
    /// JSON-friendly shape used by the recording actor's diagnostics dump.
    /// Read-only, called once per recording at startup.
    static func snapshotAdvertisedFormats(for device: AVCaptureDevice) -> [CameraAdvertisedFormat] {
        device.formats.map { format -> CameraAdvertisedFormat in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let pf = CMFormatDescriptionGetMediaSubType(format.formatDescription)
            let ranges = format.videoSupportedFrameRateRanges.map { range in
                CameraAdvertisedFormat.RateRange(
                    minFrameRate: range.minFrameRate,
                    maxFrameRate: range.maxFrameRate,
                    minFrameDurationSeconds: range.minFrameDuration.seconds,
                    maxFrameDurationSeconds: range.maxFrameDuration.seconds
                )
            }
            return CameraAdvertisedFormat(
                width: Int(dims.width),
                height: Int(dims.height),
                pixelFormat: PixelFormatLabel.string(for: pf),
                rateRanges: ranges
            )
        }
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

    /// Diagnostics: every format the device advertised, captured at startup
    /// so the recording actor can include it in the diagnostics dump.
    /// Useful for confirming whether a camera (e.g. Opal Tadpole) actually
    /// exposes a 60fps format.
    private(set) var lastAdvertisedFormats: [CameraAdvertisedFormat] = []

    /// Diagnostics: which format we actually picked + whether we managed
    /// to lock `activeVideoMinFrameDuration` to the target. If `didLockRate`
    /// is false, the camera ran at its own native rate (which is what we
    /// log to console), not the user-picked rate.
    private(set) var lastSelectedFormat: MetronomeDiagnostics.SelectedCameraFormat?

    func startCapture(
        device: AVCaptureDevice,
        maxHeight: Int = Int.max,
        targetFPS: FrameRate = .thirtyFPS,
        micDevice: AVCaptureDevice? = nil
    ) async {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else {
            Log.camera.log("Permission denied")
            return
        }

        // Diagnostics: snapshot every advertised format before we touch the
        // session. Helpful for confirming "what does the Opal actually
        // expose?" — log to console and stash for the diagnostics dump.
        lastAdvertisedFormats = Self.snapshotAdvertisedFormats(for: device)
        print("[camera-diag] \(device.localizedName) advertises \(lastAdvertisedFormats.count) format(s):")
        for (i, fmt) in lastAdvertisedFormats.enumerated() {
            let ranges = fmt.rateRanges
                .map { String(format: "%.2f-%.2ffps", $0.minFrameRate, $0.maxFrameRate) }
                .joined(separator: ", ")
            print("[camera-diag]   [\(i)] \(fmt.width)x\(fmt.height) pf=\(fmt.pixelFormat) ranges=[\(ranges)]")
        }

        let session = AVCaptureSession()
        session.beginConfiguration()

        // Pick the highest-resolution format whose height is <= maxHeight and
        // supports the target fps. This lets a good camera (4K webcam, DSLR
        // via capture card) deliver at the output preset's height rather than
        // being pegged to AVCaptureSession.Preset.high's ~720p default.
        if let best = Self.bestFormat(for: device, maxHeight: maxHeight, targetFPS: targetFPS) {
            do {
                try device.lockForConfiguration()
                device.activeFormat = best
                // Only lock the frame rate when 1/fps is within the format's
                // supported duration range. UVC cameras like the ZV-1
                // advertise fixed-rate ranges whose min and max duration
                // are both `1000000/30000030` (essentially-but-not-exactly
                // 30fps — UVC intervals are stored in 100ns units, which
                // doesn't hit 1/30 on the nose). Setting
                // activeVideoMinFrameDuration to CMTime(1, fps) in that
                // case throws NSInvalidArgumentException — an ObjC
                // exception Swift's `try/catch` can't catch, which
                // crashes the app. When 1/fps isn't in range, the format's
                // own rate applies — leave it alone.
                let targetDur = targetFPS.frameDuration
                var didLockRate = false
                if best.videoSupportedFrameRateRanges.contains(where: {
                    $0.minFrameDuration <= targetDur && targetDur <= $0.maxFrameDuration
                }) {
                    device.activeVideoMinFrameDuration = targetDur
                    device.activeVideoMaxFrameDuration = targetDur
                    didLockRate = true
                }
                device.unlockForConfiguration()
                let dims = CMVideoFormatDescriptionGetDimensions(best.formatDescription)
                let rate = best.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
                Log.camera.log(String(
                    format: "Selected format: %dx%d @ %.2ffps (target: %d, cap: %d, lockedRate=%@)",
                    dims.width,
                    dims.height,
                    min(rate, Double(targetFPS.rawValue)),
                    targetFPS.rawValue,
                    maxHeight,
                    didLockRate ? "yes" : "NO (range mismatch — camera runs at its own rate)"
                ))

                // Diagnostics: stash the selected format details so the
                // recording actor can include them in the dump.
                let pf = CMFormatDescriptionGetMediaSubType(best.formatDescription)
                lastSelectedFormat = MetronomeDiagnostics.SelectedCameraFormat(
                    width: Int(dims.width),
                    height: Int(dims.height),
                    pixelFormat: PixelFormatLabel.string(for: pf),
                    targetFPS: Int(targetFPS.rawValue),
                    didLockRate: didLockRate,
                    activeMinFrameDurationSeconds: device.activeVideoMinFrameDuration.seconds,
                    activeMaxFrameDurationSeconds: device.activeVideoMaxFrameDuration.seconds,
                    advertisedMaxFrameRate: rate
                )
            } catch {
                Log.camera.log("Could not set activeFormat: \(error) — falling back to .high")
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
            Log.camera.log("Failed to create input: \(error)")
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

        // Optional mic audio: when a mic device is provided, add it to this
        // session so audio and video share a single synchronizationClock.
        // This eliminates the cross-session clock jitter (5-30ms) that caused
        // lip-sync issues in cameraOnly recordings.
        if let micDevice {
            do {
                let audioInput = try AVCaptureDeviceInput(device: micDevice)
                if session.canAddInput(audioInput) {
                    session.addInput(audioInput)
                    let audioOut = AVCaptureAudioDataOutput()
                    audioOut.setSampleBufferDelegate(self, queue: audioCaptureQueue)
                    if session.canAddOutput(audioOut) {
                        session.addOutput(audioOut)
                        audioOutput = audioOut
                        hasAudioCapture = true
                        Log.camera.log("Added mic to shared session: \(micDevice.localizedName)")
                    }
                }
            } catch {
                Log.camera.log("Failed to add mic to shared session: \(error) — standalone mic will be used")
            }
        }

        session.commitConfiguration()
        self.session = session

        // Subscribe to session error and interruption notifications so we can
        // detect device disconnects, resource pressure, and other failures
        // mid-recording.
        let errorObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error
                ?? NSError(domain: "AVCaptureSession", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown runtime error"])
            Log.camera.log("Session runtime error: \(error)")
            self.onSessionError?(error)
        }
        let interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.wasInterruptedNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            Log.camera.log("Session interrupted: \(notification.userInfo ?? [:])")
            self.onSessionInterrupted?()
        }
        sessionObservers = [errorObserver, interruptionObserver]

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
        Log.camera.log("Capture started: \(device.localizedName) @ \(activeDims.width)x\(activeDims.height)")

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
        Log.camera.log("Format introspection: subType=\(subTypeStr) primaries=\(primaries) transfer=\(transfer) matrix=\(matrix)")
    }

    func stopCapture() async {
        for observer in sessionObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        sessionObservers.removeAll()
        guard let session else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
                continuation.resume()
            }
        }
        self.session = nil
        self.audioOutput = nil
        self.hasAudioCapture = false
        Log.camera.log("Capture stopped")
    }
}

extension CameraCaptureManager: AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from _: AVCaptureConnection
    ) {
        // Audio from the shared session's mic — route to the audio callback.
        if output === audioOutput {
            onAudioSample?(sampleBuffer)
            return
        }

        // Video: tag the pixel buffer with explicit Rec. 709 colour metadata
        // before forwarding. Many USB cameras (ZV-1, generic capture cards)
        // deliver buffers without YCbCrMatrix / TransferFunction /
        // ColorPrimaries attachments — CIContext then runs an expensive
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
