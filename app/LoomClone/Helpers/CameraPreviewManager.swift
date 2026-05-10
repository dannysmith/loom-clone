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

    /// In-flight start (or stop) task. Used to coalesce overlapping
    /// `start()` calls: when popoverDidOpen and the selectedCamera didSet
    /// both fire `Task { await cameraPreview.start(...) }`, both Tasks
    /// would otherwise race through their `await stop()` and concurrently
    /// configure separate AVCaptureSessions. Chaining each new start
    /// behind the previous Task makes the sequence deterministic.
    private var inFlightStart: Task<Void, Never>?

    /// Monotonically increasing counter bumped each time `start()` creates a
    /// new session. The frame-watchdog task compares its captured generation
    /// against the current value — if they differ, the session it was
    /// monitoring has already been replaced and the watchdog exits silently.
    private var sessionGeneration: Int = 0

    /// Set to `true` by the sample-buffer delegate the first time a frame
    /// arrives for the current session. Reset to `false` in `start()` before
    /// `startRunning()`. Read by the watchdog to decide whether to retry.
    @ObservationIgnored
    nonisolated(unsafe) private var hasReceivedFrame: Bool = false

    /// How long to wait for the first frame before concluding the session is
    /// dead and retrying. USB cameras (ZV-1, capture cards) can take a moment
    /// to re-establish their CMIO device transport after a recording session
    /// releases them — if we start too soon, `startRunning()` succeeds but
    /// frames never arrive.
    private static let frameWatchdogTimeout: Duration = .seconds(1.5)

    /// Maximum number of automatic retries when the watchdog fires. After
    /// this many consecutive failures, give up and log rather than looping.
    private static let maxRetries: Int = 2

    /// Start the preview session for `device`. Awaits the AVCaptureSession's
    /// `startRunning()` so callers know the hardware is actually live before
    /// they proceed (avoids CMIO contention with the recording session).
    ///
    /// Coalesced: overlapping calls are serialised behind the most recent
    /// in-flight start, so concurrent invocations (e.g. popover open and
    /// selectedCamera didSet firing back-to-back) can't tangle the
    /// `session` / `currentDeviceID` state.
    func start(device: AVCaptureDevice) async {
        let prior = inFlightStart
        let task = Task { [weak self] in
            await prior?.value
            await self?.startSession(device: device, retryCount: 0)
        }
        inFlightStart = task
        await task.value
        // Clear the handle only if we're still the most recent task — a
        // later start() may have replaced us while we were running.
        if inFlightStart == task {
            inFlightStart = nil
        }
    }

    private func startSession(device: AVCaptureDevice, retryCount: Int) async {
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
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: captureQueue)
        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
        self.session = session
        self.currentDeviceID = device.uniqueID
        self.hasReceivedFrame = false
        sessionGeneration += 1
        let generation = sessionGeneration

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        self.isActive = true
        print("[camera-preview] Started: \(device.localizedName) (attempt \(retryCount + 1))")

        // Watchdog: if no frame arrives within the timeout, the CMIO device
        // transport likely didn't re-attach. Tear down and retry.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.frameWatchdogTimeout)
            guard let self, self.sessionGeneration == generation else { return }
            if self.hasReceivedFrame { return }

            if retryCount < Self.maxRetries {
                print("[camera-preview] No frames after \(Self.frameWatchdogTimeout) — retrying (\(retryCount + 1)/\(Self.maxRetries))")
                await self.startSession(device: device, retryCount: retryCount + 1)
            } else {
                print("[camera-preview] No frames after \(Self.maxRetries) retries — giving up. Device may need app restart.")
            }
        }
    }

    /// Stop the preview session and wait for the CMIO device to be released.
    /// This must complete before the recording camera session starts or the
    /// system throws "HALB_IOThread::_Start: there already is a thread" errors.
    func stop() async {
        // Bump the generation so any in-flight watchdog task exits on its
        // next check. Without this, a watchdog spawned by the previous
        // start() could fire after stop() returns and restart the preview
        // session while the recording session is using the same device —
        // causing CMIO contention and corrupted frames.
        sessionGeneration += 1

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
        _: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from _: AVCaptureConnection
    ) {
        // Log + flag the first frame so the watchdog knows the device is
        // actually delivering. nonisolated(unsafe) write is fine — only one
        // capture queue writes, and the MainActor watchdog reads after a
        // sleep that far exceeds any reordering window.
        if !hasReceivedFrame {
            hasReceivedFrame = true
            print("[camera-preview] First frame received")
        }

        // Tag the pixel buffer with explicit Rec. 709 colour metadata before
        // forwarding, matching what `CameraCaptureManager` does on the
        // recording path. Many USB cameras deliver frames without the
        // YCbCrMatrix / TransferFunction / ColorPrimaries attachments —
        // without these, `AVSampleBufferDisplayLayer` falls back to a
        // conservative path and logs `createFromPixelbuffer: … Using R709`.
        if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
            let attachments: [CFString: Any] = [
                kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
                kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_ITU_R_709_2,
            ]
            CVBufferSetAttachments(pixelBuffer, attachments as CFDictionary, .shouldPropagate)
        }
        onSampleBuffer?(sampleBuffer)
    }
}
