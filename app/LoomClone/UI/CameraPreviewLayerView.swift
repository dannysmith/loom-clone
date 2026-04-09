import AppKit
@preconcurrency import AVFoundation
import CoreMedia

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
@MainActor
final class CameraPreviewLayerView: NSView {

    nonisolated(unsafe) private let displayLayer = AVSampleBufferDisplayLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
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
        // Mark each sample as "display immediately" so the layer ignores PTS
        // and renders frames as soon as they arrive. This is the recommended
        // pattern for live camera previews — without it, the layer schedules
        // frames against its control timebase, which is fragile when the
        // incoming PTS domain isn't perfectly aligned.
        Self.markDisplayImmediately(sampleBuffer)

        if #available(macOS 15.0, *) {
            let renderer = displayLayer.sampleBufferRenderer
            if renderer.status == .failed {
                renderer.flush()
            }
            renderer.enqueue(sampleBuffer)
        } else {
            if displayLayer.status == .failed {
                displayLayer.flush()
            }
            displayLayer.enqueue(sampleBuffer)
        }
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
