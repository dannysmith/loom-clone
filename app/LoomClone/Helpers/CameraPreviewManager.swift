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

    /// Live metadata about the camera feed shown in the preview: actual
    /// delivered resolution + advertised/measured frame rate. Surfaced in the
    /// popover so the user can spot a misconfigured device — wrong resolution,
    /// or a PAL camera delivering 25fps against a 30fps target — *before*
    /// recording. Display-only; cadence-stability is the separate
    /// `previewFeedUnstable` signal below.
    private(set) var previewMetadata: PreviewMetadata?

    /// True when the preview feed's capture-PTS timeline is going non-monotonic
    /// — the same CMIO corruption that desyncs a real recording (#30 / #44).
    /// The preview uses the same device + CMIO path, so a stuttering preview
    /// predicts a stuttering recording: surfacing it here lets the user catch it
    /// *before* hitting record. Read in a leaf subview only (the popover hosts
    /// `NativePopUpPicker`; see the picker-flood note). See
    /// `CameraCadenceMonitor`.
    private(set) var previewFeedUnstable: Bool = false

    struct PreviewMetadata: Equatable {
        let width: Int
        let height: Int
        /// Highest frame rate the active format advertises.
        let advertisedMaxFPS: Double
        /// Lowest frame rate the active format advertises. Together with
        /// `advertisedMaxFPS` this says whether the format is *rate-locked* to a
        /// single rate (min ≈ max) — the dangerous shape: a camera whose only
        /// option is a rate it can't sustain has no lower floor to fall back to,
        /// so CMIO fabricates and the recording desyncs (#30). Used by the
        /// pre-record health note via `CameraCaptureManager.shouldCapRate`.
        let advertisedMinFPS: Double
        /// Frame rate measured from delivered buffers over a rolling ~1s
        /// window; nil until the first window completes.
        var measuredFPS: Double?
    }

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

    /// Rolling-window frame-rate measurement state. Written only on the capture
    /// queue (single writer); published to `previewMetadata` ~once/second via a
    /// MainActor hop. Reset in `startSession` before frames begin.
    @ObservationIgnored
    nonisolated(unsafe) private var rateWindowStart: Double = 0
    @ObservationIgnored
    nonisolated(unsafe) private var rateWindowCount: Int = 0

    /// Cadence-health detector fed from delivered preview buffers. Written only
    /// on the capture queue (single writer) plus a reset in `startSession`
    /// before frames begin. `lastPublishedUnstable` throttles the MainActor hop
    /// to transitions only (not per frame). Same predicate the recording
    /// pipeline uses — see `CameraCadenceMonitor`.
    @ObservationIgnored
    nonisolated(unsafe) private var cadenceMonitor = CameraCadenceMonitor()
    @ObservationIgnored
    nonisolated(unsafe) private var lastPublishedUnstable: Bool = false

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
            // If stop() ran while we were chained behind a prior start, it
            // cancelled this task and bumped `sessionGeneration`. Bail out
            // before re-allocating a session — otherwise a queued start
            // could revive the preview after stop() returned.
            guard !Task.isCancelled else { return }
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
            Log.cameraPreview.log("Failed to create input: \(error)")
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
        rateWindowStart = 0
        rateWindowCount = 0
        cadenceMonitor = CameraCadenceMonitor()
        lastPublishedUnstable = false
        previewFeedUnstable = false
        previewMetadata = nil
        sessionGeneration += 1
        let generation = sessionGeneration

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        self.isActive = true
        captureActiveFormatMetadata(from: device)
        Log.cameraPreview.log("Started: \(device.localizedName) (attempt \(retryCount + 1))")

        // Watchdog: if no frame arrives within the timeout, the CMIO device
        // transport likely didn't re-attach. Tear down and retry.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.frameWatchdogTimeout)
            guard let self, self.sessionGeneration == generation else { return }
            if self.hasReceivedFrame { return }

            if retryCount < Self.maxRetries {
                Log.cameraPreview.log("No frames after \(Self.frameWatchdogTimeout) — retrying (\(retryCount + 1)/\(Self.maxRetries))")
                await self.startSession(device: device, retryCount: retryCount + 1)
            } else {
                Log.cameraPreview.log("No frames after \(Self.maxRetries) retries — giving up. Device may need app restart.")
            }
        }
    }

    /// Stop the preview session and wait for the CMIO device to be released.
    /// This must complete before the recording camera session starts or the
    /// system throws "HALB_IOThread::_Start: there already is a thread" errors.
    func stop() async {
        // Cancel any pending start that's queued behind a prior one. Without
        // this, a `start(A) → start(B) → stop()` sequence would leave TaskB
        // waiting on TaskA's completion, then call startSession(B) after
        // stop() returns and recreate the preview. The cancelled TaskB
        // observes Task.isCancelled in its chain and bails out before
        // touching session state.
        inFlightStart?.cancel()
        inFlightStart = nil

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
        previewMetadata = nil
        previewFeedUnstable = false
        lastPublishedUnstable = false
        Log.cameraPreview.log("Stopped")
    }

    /// Read delivered resolution + advertised max frame rate from the device's
    /// active format once the session is live. The measured frame rate is
    /// filled in later from delivered buffers (see the delegate).
    private func captureActiveFormatMetadata(from device: AVCaptureDevice) {
        let format = device.activeFormat
        let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        let ranges = format.videoSupportedFrameRateRanges
        let advertisedMax = ranges.map(\.maxFrameRate).max() ?? 0
        let advertisedMin = ranges.map(\.minFrameRate).min() ?? advertisedMax
        previewMetadata = PreviewMetadata(
            width: Int(dims.width),
            height: Int(dims.height),
            advertisedMaxFPS: advertisedMax,
            advertisedMinFPS: advertisedMin,
            measuredFPS: nil
        )
    }

    /// Fold a freshly-measured frame rate into the published metadata. No-op if
    /// the session was torn down between measurement and this MainActor hop.
    private func publishMeasuredFPS(_ fps: Double) {
        guard previewMetadata != nil else { return }
        previewMetadata?.measuredFPS = fps
    }

    /// Publish a cadence-health transition. No-op if the session was torn down
    /// between the capture-queue evaluation and this MainActor hop.
    private func publishFeedUnstable(_ unstable: Bool) {
        guard isActive else { return }
        previewFeedUnstable = unstable
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
            Log.cameraPreview.log("First frame received")
        }

        // Measure delivered frame rate over a rolling ~1s window and publish it
        // to the observable metadata. Cheap: an integer counter on the capture
        // queue, with one MainActor hop per second (not per frame).
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if rateWindowStart == 0 { rateWindowStart = now }
        rateWindowCount += 1
        let elapsed = now - rateWindowStart
        if elapsed >= 1.0 {
            let fps = Double(rateWindowCount) / elapsed
            rateWindowCount = 0
            rateWindowStart = now
            Task { @MainActor [weak self] in self?.publishMeasuredFPS(fps) }
        }

        // Cadence health: feed the buffer's capture PTS into the same monitor
        // the recording pipeline uses. A non-monotonic preview timeline predicts
        // a desynced recording. Publish only on transition to keep the
        // observable read out of the per-frame path.
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        cadenceMonitor.recordFrame(capturePTSSeconds: pts, now: now)
        let unstable = cadenceMonitor.evaluateHealth(now: now)
        if unstable != lastPublishedUnstable {
            lastPublishedUnstable = unstable
            Task { @MainActor [weak self] in self?.publishFeedUnstable(unstable) }
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
