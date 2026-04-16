import AppKit
@preconcurrency import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Metal

/// Serialises access to each preview view's filter pixel-buffer pool.
/// Declared at file scope so it's nonisolated and reachable from the
/// capture-queue paths that call `enqueue(_:)`.
private let cameraPreviewFilterQueue = DispatchQueue(
    label: "com.loomclone.camera-preview-filter"
)

/// Shared NSView that renders live camera frames via `AVSampleBufferDisplayLayer`.
///
/// Used by both the popover preview (before recording) and the on-screen
/// camera overlay (during recording). Replaces the previous CIContext.createCGImage
/// path which did full-resolution CPU rendering on every frame.
///
/// Properties:
/// - Hardware-accelerated GPU rendering, no per-frame CPU work
/// - Horizontally mirrored so the camera reads like a mirror (selfie convention)
/// - `enqueue(_:)` is thread-safe and can be called from any queue (per Apple's
///   contract for `AVSampleBufferDisplayLayer`)
/// - Aspect-fill cropping
/// - Applies camera adjustments on the way through when a
///   `CameraAdjustmentsState` is attached and its value is non-default.
///   Fast-paths the original sample buffer through unchanged otherwise.
@MainActor
final class CameraPreviewLayerView: NSView {
    nonisolated(unsafe) private let displayLayer = AVSampleBufferDisplayLayer()

    // MARK: - Filter State

    nonisolated(unsafe) private var adjustmentsState: CameraAdjustmentsState?
    nonisolated private let filterContext: CIContext
    nonisolated(unsafe) private var filterOutputPool: CVPixelBufferPool?
    nonisolated(unsafe) private var filterPoolDims: (Int, Int) = (0, 0)

    override init(frame: NSRect) {
        // Separate CIContext from the compositor's — the preview/overlay
        // path must keep running even if the compositor's context is mid-
        // rebuild.
        if let device = MTLCreateSystemDefaultDevice() {
            self.filterContext = CIContext(
                mtlDevice: device,
                options: [.cacheIntermediates: false]
            )
        } else {
            self.filterContext = CIContext(options: [.cacheIntermediates: false])
        }
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        if let device = MTLCreateSystemDefaultDevice() {
            self.filterContext = CIContext(
                mtlDevice: device,
                options: [.cacheIntermediates: false]
            )
        } else {
            self.filterContext = CIContext(options: [.cacheIntermediates: false])
        }
        super.init(coder: coder)
        configure()
    }

    /// Wire the shared adjustments state. Passing nil reverts to pure
    /// passthrough. Thread-safe.
    nonisolated func setAdjustmentsState(_ state: CameraAdjustmentsState?) {
        adjustmentsState = state
    }

    private func configure() {
        wantsLayer = true
        layer = CALayer()
        layer?.backgroundColor = NSColor.black.cgColor

        // Aspect-fill so the circular crop in the parent view always has content
        displayLayer.videoGravity = .resizeAspectFill
        displayLayer.anchorPoint = CGPoint(x: 0.5, y: 0.5)

        // Horizontal mirror — anchored at center, scale -1 in X.
        displayLayer.transform = CATransform3DMakeScale(-1, 1, 1)

        // Configure a control timebase anchored to the host clock's *current*
        // time (not zero) so the timebase runs in the same domain as the PTS
        // values on incoming capture sample buffers. `enqueue(_:)` also marks
        // each buffer as "display immediately" so the exact PTS alignment is
        // moot — but `displayImmediately` is only honoured when the layer has
        // a control timebase, so we still need one.
        var timebase: CMTimebase?
        CMTimebaseCreateWithSourceClock(
            allocator: kCFAllocatorDefault,
            sourceClock: CMClockGetHostTimeClock(),
            timebaseOut: &timebase
        )
        if let timebase {
            CMTimebaseSetTime(timebase, time: CMClockGetTime(CMClockGetHostTimeClock()))
            CMTimebaseSetRate(timebase, rate: 1.0)
            displayLayer.controlTimebase = timebase
        }

        layer?.addSublayer(displayLayer)
    }

    override func layout() {
        super.layout()
        // Center the display layer in the view so the (-1,1,1) transform
        // mirrors around its centre and stays in place.
        let b = bounds
        displayLayer.bounds = b
        displayLayer.position = CGPoint(x: b.midX, y: b.midY)
    }

    /// Enqueue a sample buffer for display. Thread-safe per Apple's docs for
    /// `AVSampleBufferDisplayLayer`. Call from the capture queue directly to
    /// avoid main-thread hops.
    nonisolated func enqueue(_ sampleBuffer: CMSampleBuffer) {
        let toEnqueue = filteredSampleBuffer(from: sampleBuffer) ?? sampleBuffer

        // Mark each sample as "display immediately" so the layer ignores PTS
        // and renders frames as soon as they arrive. This is the recommended
        // pattern for live camera previews — without it, the layer schedules
        // frames against its control timebase, which is fragile when the
        // incoming PTS domain isn't perfectly aligned.
        Self.markDisplayImmediately(toEnqueue)

        if #available(macOS 15.0, *) {
            let renderer = displayLayer.sampleBufferRenderer
            if renderer.status == .failed {
                renderer.flush()
            }
            renderer.enqueue(toEnqueue)
        } else {
            if displayLayer.status == .failed {
                displayLayer.flush()
            }
            displayLayer.enqueue(toEnqueue)
        }
    }

    /// Apply camera adjustments to a sample buffer and wrap the filtered pixel
    /// buffer in a new CMSampleBuffer with matching timing and the same
    /// Rec. 709 attachments. Returns nil when no adjustments are attached, the
    /// values are defaults, or any step of the wrap fails — caller enqueues
    /// the original buffer in that case.
    nonisolated private func filteredSampleBuffer(from sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let state = adjustmentsState else { return nil }
        let adj = state.value
        guard !adj.isDefault else { return nil }
        guard let inputBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }

        let width = CVPixelBufferGetWidth(inputBuffer)
        let height = CVPixelBufferGetHeight(inputBuffer)

        let output = cameraPreviewFilterQueue.sync { () -> CVPixelBuffer? in
            ensureFilterPool(width: width, height: height)
            guard let pool = filterOutputPool else { return nil }
            var buffer: CVPixelBuffer?
            guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess else {
                return nil
            }
            return buffer
        }
        guard let output else { return nil }

        // Propagate attachments (YCbCr matrix, transfer function, primaries)
        // so the display layer honours the same Rec. 709 treatment the raw
        // capture buffer had.
        CVBufferPropagateAttachments(inputBuffer, output)

        let base = CIImage(cvPixelBuffer: inputBuffer)
        let filtered = Self.applyFilters(to: base, adjustments: adj)

        let destination = CIRenderDestination(pixelBuffer: output)
        destination.colorSpace = CGColorSpace(name: CGColorSpace.itur_709)
        do {
            let task = try filterContext.startTask(toRender: filtered, to: destination)
            try task.waitUntilCompleted()
        } catch {
            return nil
        }

        return wrapInSampleBuffer(pixelBuffer: output, sourceSampleBuffer: sampleBuffer)
    }

    /// Lazily create or recreate the output pixel-buffer pool when the
    /// input dimensions change. Called on `filterPoolQueue`.
    nonisolated private func ensureFilterPool(width: Int, height: Int) {
        if filterPoolDims == (width, height), filterOutputPool != nil { return }
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
        filterOutputPool = pool
        filterPoolDims = (width, height)
    }

    /// Wrap a filtered pixel buffer into a fresh CMSampleBuffer, reusing the
    /// source sample's timing info so the display layer timebase behaviour is
    /// identical to the passthrough path.
    nonisolated private func wrapInSampleBuffer(
        pixelBuffer: CVPixelBuffer,
        sourceSampleBuffer: CMSampleBuffer
    ) -> CMSampleBuffer? {
        var formatDesc: CMFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDesc
        )
        guard let formatDesc else { return nil }

        var timing = CMSampleTimingInfo()
        let pts = CMSampleBufferGetPresentationTimeStamp(sourceSampleBuffer)
        let duration = CMSampleBufferGetDuration(sourceSampleBuffer)
        timing.presentationTimeStamp = pts.isValid ? pts : .zero
        timing.duration = duration
        timing.decodeTimeStamp = .invalid

        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDesc,
            sampleTiming: &timing,
            sampleBufferOut: &out
        )
        guard status == noErr else { return nil }
        return out
    }

    /// Build the filter graph for the given adjustments. Static because it
    /// doesn't touch any instance state — just returns a CIImage graph the
    /// caller renders into an output buffer.
    nonisolated private static func applyFilters(
        to image: CIImage,
        adjustments: CameraAdjustments
    ) -> CIImage {
        let neutral = CIVector(x: CameraAdjustments.defaultTemperature, y: 0)
        let target = CIVector(x: adjustments.temperature, y: 0)
        var result = image.applyingFilter("CITemperatureAndTint", parameters: [
            "inputNeutral": neutral,
            "inputTargetNeutral": target,
        ])
        result = result.applyingFilter("CIExposureAdjust", parameters: [
            kCIInputEVKey: adjustments.brightness,
        ])
        // Preserve original extent — CIExposureAdjust doesn't change it, but
        // be explicit so downstream consumers aren't surprised.
        return result.cropped(to: image.extent)
    }

    /// Sets `kCMSampleAttachmentKey_DisplayImmediately` on every sample in the
    /// buffer's sample-attachments array.
    nonisolated private static func markDisplayImmediately(_ sampleBuffer: CMSampleBuffer) {
        guard
            let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: true
            ) as? [NSMutableDictionary]
        else { return }
        for dict in attachmentsArray {
            dict[kCMSampleAttachmentKey_DisplayImmediately as NSString] = true
        }
    }

    /// Flush any pending frames. Useful when switching sources or after errors.
    nonisolated func flush() {
        if #available(macOS 15.0, *) {
            displayLayer.sampleBufferRenderer.flush()
        } else {
            displayLayer.flush()
        }
    }
}
