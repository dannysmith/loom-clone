import AppKit
@preconcurrency import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

// MARK: - HarnessFrameSource

//
// Common interface for both synthetic and real-capture frame sources.
// HarnessRunner holds frame sources by protocol so the metronome loop
// doesn't have to branch on source kind.
//
// The `index` parameter is meaningful for synthetic sources (they use
// it to generate deterministic per-frame content). Real-capture sources
// ignore it and always return the most recent buffer received from the
// capture callback.

protocol HarnessFrameSource: AnyObject, Sendable {
    /// Returns a pixel buffer for this metronome tick. Synthetic sources
    /// generate based on `index`; captured sources return the most
    /// recent capture-callback buffer (or nil if none has arrived yet).
    func makePixelBuffer(index: Int64) -> CVPixelBuffer?

    /// Monotonically increasing counter that changes when — and only
    /// when — a fundamentally new pixel buffer would be returned by the
    /// next `makePixelBuffer` call. Synthetic sources return the tick
    /// index (a new buffer per tick). Real-capture sources return a
    /// counter that increments on each capture-callback delivery. The
    /// metronome uses this to avoid feeding the raw-screen and raw-
    /// camera writers with duplicate sample buffers when the source
    /// hasn't produced anything new — without this, a 30fps metronome
    /// driving a 0.3fps SCStream delivery would feed ProRes 100× more
    /// work than it's seeing from real capture, GPU-starving SCStream
    /// itself through the shared compositor.
    var generation: Int64 { get }

    /// Real-capture sources: begin capture. Called once before the
    /// metronome starts. No-op for synthetic.
    func start() async throws

    /// Real-capture sources: stop capture cleanly. Called in the
    /// runner's finalise path. No-op for synthetic.
    func stop() async
}

extension SyntheticFrameSource: HarnessFrameSource {
    /// Synthetic sources produce a new buffer on every makePixelBuffer
    /// call; the metronome's tick index is the natural generation. We
    /// expose the source's internal frame counter so the metronome sees
    /// a new generation per tick and feeds writers every tick — matching
    /// the pre-real-capture behaviour exactly.
    var generation: Int64 {
        syntheticGeneration
    }

    func start() async throws {}
    func stop() async {}
}

// MARK: - CapturedScreenSource

//
// SCStream-backed frame source. Mirrors the main-app ScreenCaptureManager's
// shape (filter, pixel format, native-pixel-resolution capture) but is a
// standalone reimplementation — the harness intentionally doesn't import
// from the main-app target. Keep the two in rough sync when changes to
// either surface a difference worth investigating.

final class CapturedScreenSource: NSObject, HarnessFrameSource, @unchecked Sendable {
    struct Config {
        var displayID: CGDirectDisplayID?
        var displayName: String?
        var pixelFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        var frameRate: Int = 30
        var queueDepth: Int = 5
    }

    private let config: Config
    private let captureQueue: DispatchQueue
    private let events: EventLog?
    private var stream: SCStream?

    // Store the whole CMSampleBuffer, not just the extracted
    // CVPixelBuffer. The pixel buffer's IOSurface lifecycle is tied to
    // the sample buffer's retention chain; storing only the pixel
    // buffer reference can leave us with a valid-looking handle whose
    // underlying surface has been released back to SCStream's pool.
    // Observed in Tier 4 T4.1/T4.2: the screen stream froze after a
    // handful of frames until we switched to storing the sample buffer.
    private let lock = NSLock()
    private var latestSample: CMSampleBuffer?

    // Per-second frame delivery counters — diagnostic.
    private var acceptedThisSecond = 0
    private var rejectedThisSecond = 0
    private var lastLogAt = Date()
    private var totalAccepted = 0
    private var totalRejected = 0

    /// Generation counter — incremented on each accepted delivery so
    /// the metronome can tell "new buffer arrived since my last feed"
    /// from "still the old buffer".
    private var generationCounter: Int64 = 0

    private(set) var nativePixelSize: CGSize = .zero
    private(set) var selectedDisplayName: String = ""

    var generation: Int64 {
        lock.lock()
        defer { lock.unlock() }
        return generationCounter
    }

    init(config: Config, events: EventLog? = nil) {
        self.config = config
        self.events = events
        self.captureQueue = DispatchQueue(
            label: "com.loomclone.harness.screen-capture",
            qos: .userInteractive
        )
    }

    func start() async throws {
        // SCShareableContent.current is the permission-gated entry point.
        // If Screen Recording is not granted, it returns successfully but
        // with an empty displays list. There is no way from code (post
        // macOS 13) to force the TCC prompt — the user has to enable it
        // in System Settings once.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw CapturedFrameSourceError.screenRecordingPermissionDenied
        }
        guard !content.displays.isEmpty else {
            throw CapturedFrameSourceError.screenRecordingPermissionDenied
        }

        let target = try resolveDisplay(in: content.displays)
        selectedDisplayName = Self.localizedName(for: target.displayID)

        let scale = Self.backingScaleFactor(for: target.displayID)
        let pixelWidth = Int(CGFloat(target.width) * scale)
        let pixelHeight = Int(CGFloat(target.height) * scale)
        nativePixelSize = CGSize(width: pixelWidth, height: pixelHeight)

        let filter = SCContentFilter(display: target, excludingWindows: [])
        let streamConfig = SCStreamConfiguration()
        streamConfig.width = pixelWidth
        streamConfig.height = pixelHeight
        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: Int32(config.frameRate))
        streamConfig.pixelFormat = config.pixelFormat
        streamConfig.showsCursor = true
        streamConfig.queueDepth = config.queueDepth

        let stream = SCStream(filter: filter, configuration: streamConfig, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        if let stream {
            do { try await stream.stopCapture() } catch {}
        }
        stream = nil
        events?.log("source.screen-totals", [
            "accepted": totalAccepted,
            "rejected": totalRejected,
        ])
    }

    func makePixelBuffer(index _: Int64) -> CVPixelBuffer? {
        lock.lock()
        let s = latestSample
        lock.unlock()
        guard let s else { return nil }
        return CMSampleBufferGetImageBuffer(s)
    }

    // MARK: Display resolution

    private func resolveDisplay(in displays: [SCDisplay]) throws -> SCDisplay {
        if let id = config.displayID {
            guard let d = displays.first(where: { $0.displayID == id }) else {
                throw CapturedFrameSourceError.displayNotFound(id)
            }
            return d
        }
        if let name = config.displayName {
            let fragment = name.lowercased()
            for d in displays {
                if Self.localizedName(for: d.displayID).lowercased().contains(fragment) {
                    return d
                }
            }
            throw CapturedFrameSourceError.displayNameNotFound(name)
        }
        let mainID = CGMainDisplayID()
        if let d = displays.first(where: { $0.displayID == mainID }) { return d }
        guard let first = displays.first else {
            throw CapturedFrameSourceError.screenRecordingPermissionDenied
        }
        return first
    }

    static func backingScaleFactor(for displayID: CGDirectDisplayID) -> CGFloat {
        for screen in NSScreen.screens {
            if let id = screen.deviceDescription[
                NSDeviceDescriptionKey("NSScreenNumber")
            ] as? CGDirectDisplayID, id == displayID {
                return screen.backingScaleFactor
            }
        }
        return 1.0
    }

    static func localizedName(for displayID: CGDirectDisplayID) -> String {
        for screen in NSScreen.screens {
            if let id = screen.deviceDescription[
                NSDeviceDescriptionKey("NSScreenNumber")
            ] as? CGDirectDisplayID, id == displayID {
                return screen.localizedName
            }
        }
        return "display-\(displayID)"
    }
}

extension CapturedScreenSource: SCStreamOutput {
    func stream(_: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else {
            accountFrame(accepted: false)
            return
        }
        // Only accept `.complete` frames. `.idle` / `.blank` / `.suspended`
        // sample buffers carry no fresh image data — forwarding them would
        // feed stale content to the encoders and skew the test.
        guard
            let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let attachments = attachmentsArray.first,
            let statusRaw = attachments[SCStreamFrameInfo.status] as? Int,
            let status = SCFrameStatus(rawValue: statusRaw),
            status == .complete
        else {
            accountFrame(accepted: false)
            return
        }
        lock.lock()
        latestSample = sampleBuffer
        generationCounter &+= 1
        lock.unlock()
        accountFrame(accepted: true)
    }

    private func accountFrame(accepted: Bool) {
        lock.lock()
        if accepted {
            acceptedThisSecond += 1
            totalAccepted += 1
        } else {
            rejectedThisSecond += 1
            totalRejected += 1
        }
        let shouldLog = Date().timeIntervalSince(lastLogAt) >= 1.0
        var acc = 0
        var rej = 0
        if shouldLog {
            acc = acceptedThisSecond
            rej = rejectedThisSecond
            acceptedThisSecond = 0
            rejectedThisSecond = 0
            lastLogAt = Date()
        }
        lock.unlock()
        if shouldLog {
            events?.log("source.screen-rate", [
                "accepted_last_sec": acc,
                "rejected_last_sec": rej,
            ])
        }
    }
}

extension CapturedScreenSource: SCStreamDelegate {
    func stream(_: SCStream, didStopWithError error: any Error) {
        events?.log("source.screen-stopped-with-error", [
            "error": "\(error)",
        ])
    }
}

// MARK: - CapturedCameraSource

//
// AVCaptureSession-backed frame source. Mirrors the main-app
// CameraCaptureManager — permission check, bestFormat selection, explicit
// Rec. 709 colour tagging on delivery.

final class CapturedCameraSource: NSObject, HarnessFrameSource, @unchecked Sendable {
    struct Config {
        var deviceUniqueID: String?
        var deviceName: String?
        var maxHeight: Int = .max
        var frameRate: Int = 30
    }

    private let config: Config
    private let captureQueue: DispatchQueue
    private let events: EventLog?
    private var session: AVCaptureSession?

    private let lock = NSLock()
    private var latestSample: CMSampleBuffer?

    // Per-second delivery counters.
    private var acceptedThisSecond = 0
    private var lastLogAt = Date()
    private var totalAccepted = 0

    /// Generation counter — see CapturedScreenSource for rationale.
    private var generationCounter: Int64 = 0

    private(set) var nativePixelSize: CGSize = .zero
    private(set) var selectedDeviceName: String = ""

    var generation: Int64 {
        lock.lock()
        defer { lock.unlock() }
        return generationCounter
    }

    init(config: Config, events: EventLog? = nil) {
        self.config = config
        self.events = events
        self.captureQueue = DispatchQueue(
            label: "com.loomclone.harness.camera-capture",
            qos: .userInteractive
        )
    }

    func start() async throws {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else {
            throw CapturedFrameSourceError.cameraPermissionDenied
        }

        let device = try resolveDevice()
        selectedDeviceName = device.localizedName

        let session = AVCaptureSession()
        session.beginConfiguration()

        if let best = Self.bestFormat(for: device, maxHeight: config.maxHeight, frameRate: config.frameRate) {
            do {
                try device.lockForConfiguration()
                device.activeFormat = best
                let targetDur = CMTime(value: 1, timescale: Int32(config.frameRate))
                if best.videoSupportedFrameRateRanges.contains(where: {
                    $0.minFrameDuration <= targetDur && targetDur <= $0.maxFrameDuration
                }) {
                    device.activeVideoMinFrameDuration = targetDur
                    device.activeVideoMaxFrameDuration = targetDur
                }
                device.unlockForConfiguration()
            } catch {
                session.sessionPreset = .high
            }
        } else {
            session.sessionPreset = .high
        }

        let input = try AVCaptureDeviceInput(device: device)
        if session.canAddInput(input) { session.addInput(input) }

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String:
                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: captureQueue)
        if session.canAddOutput(output) { session.addOutput(output) }

        session.commitConfiguration()
        self.session = session

        // Wait for the session to actually come up before returning so
        // the metronome doesn't race against hardware init.
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                cont.resume()
            }
        }

        let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        nativePixelSize = CGSize(width: Int(dims.width), height: Int(dims.height))
    }

    func stop() async {
        guard let session else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
                cont.resume()
            }
        }
        self.session = nil
        events?.log("source.camera-totals", ["accepted": totalAccepted])
    }

    func makePixelBuffer(index _: Int64) -> CVPixelBuffer? {
        lock.lock()
        let s = latestSample
        lock.unlock()
        guard let s else { return nil }
        return CMSampleBufferGetImageBuffer(s)
    }

    // MARK: Device resolution

    private func resolveDevice() throws -> AVCaptureDevice {
        if let id = config.deviceUniqueID {
            guard let d = AVCaptureDevice(uniqueID: id) else {
                throw CapturedFrameSourceError.cameraDeviceNotFound(id)
            }
            return d
        }
        if let name = config.deviceName {
            let fragment = name.lowercased()
            for d in Self.discoverDevices() {
                if d.localizedName.lowercased().contains(fragment) {
                    return d
                }
            }
            throw CapturedFrameSourceError.cameraDeviceNameNotFound(name)
        }
        if let d = AVCaptureDevice.default(for: .video) { return d }
        throw CapturedFrameSourceError.noDefaultCamera
    }

    static func discoverDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    static func bestFormat(for device: AVCaptureDevice, maxHeight: Int, frameRate: Int = 30) -> AVCaptureDevice.Format? {
        let minAcceptableRate = Double(frameRate) - 1.0
        let candidates = device.formats.filter { format in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Int(dims.height) <= maxHeight else { return false }
            return format.videoSupportedFrameRateRanges.contains {
                $0.maxFrameRate >= minAcceptableRate
            }
        }
        return candidates.max { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return (Int(da.width) * Int(da.height)) < (Int(db.width) * Int(db.height))
        }
    }
}

extension CapturedCameraSource: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from _: AVCaptureConnection
    ) {
        if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
            // Tag Rec. 709 explicitly. Many USB cameras deliver buffers with
            // missing colour extensions; without this, CIContext runs an
            // expensive multi-stage conversion chain per frame.
            let attachments: [CFString: Any] = [
                kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
                kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_ITU_R_709_2,
            ]
            CVBufferSetAttachments(pixelBuffer, attachments as CFDictionary, .shouldPropagate)
        }
        lock.lock()
        latestSample = sampleBuffer
        generationCounter &+= 1
        acceptedThisSecond += 1
        totalAccepted += 1
        let shouldLog = Date().timeIntervalSince(lastLogAt) >= 1.0
        var acc = 0
        if shouldLog {
            acc = acceptedThisSecond
            acceptedThisSecond = 0
            lastLogAt = Date()
        }
        lock.unlock()
        if shouldLog {
            events?.log("source.camera-rate", ["accepted_last_sec": acc])
        }
    }
}

// MARK: - Errors

enum CapturedFrameSourceError: Error, CustomStringConvertible {
    case screenRecordingPermissionDenied
    case cameraPermissionDenied
    case displayNotFound(CGDirectDisplayID)
    case displayNameNotFound(String)
    case cameraDeviceNotFound(String)
    case cameraDeviceNameNotFound(String)
    case noDefaultCamera

    var description: String {
        switch self {
        case .screenRecordingPermissionDenied:
            "Screen Recording permission is not granted. Open System Settings → Privacy & Security → Screen & System Audio Recording, enable LoomCloneTestHarness, then re-run. macOS cannot trigger this dialog from code after the first refusal."
        case .cameraPermissionDenied:
            "Camera permission is not granted. Open System Settings → Privacy & Security → Camera, enable LoomCloneTestHarness, then re-run."
        case let .displayNotFound(id):
            "No SCDisplay found for displayID \(id). Run `--list-devices` to see available displays."
        case let .displayNameNotFound(name):
            "No display found whose name contains '\(name)'. Run `--list-devices` to see available displays."
        case let .cameraDeviceNotFound(id):
            "No camera device found with uniqueID '\(id)'. Run `--list-devices` to see available cameras."
        case let .cameraDeviceNameNotFound(name):
            "No camera device found whose name contains '\(name)'. Run `--list-devices` to see available cameras."
        case .noDefaultCamera:
            "No default camera device found. Run `--list-devices` to see what's attached."
        }
    }
}
