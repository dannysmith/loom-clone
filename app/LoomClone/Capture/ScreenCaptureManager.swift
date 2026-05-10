import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

final class ScreenCaptureManager: NSObject, @unchecked Sendable {
    /// Native pixel dimensions of the display currently being captured.
    /// Set by `startCapture` after resolving the backing scale factor.
    /// Used by the coordinator for preset-availability gating.
    private(set) var nativePixelSize: CGSize = .zero

    var onScreenFrame: (@Sendable (CMSampleBuffer) -> Void)?
    var onStreamError: (@Sendable (Error) -> Void)?

    private var stream: SCStream?
    private var captureDisplay: SCDisplay?
    private let captureQueue = DispatchQueue(label: "com.loomclone.screen-capture", qos: .userInteractive)

    func startCapture(
        display: SCDisplay,
        fps: Int32 = 30,
        excludingApps: [SCRunningApplication] = [],
        exceptingWindows: [SCWindow] = []
    ) async throws {
        captureDisplay = display

        let filter: SCContentFilter
        if !excludingApps.isEmpty {
            filter = SCContentFilter(
                display: display,
                excludingApplications: excludingApps,
                exceptingWindows: exceptingWindows
            )
            for app in excludingApps {
                Log.screen.log("Excluding from capture: \(app.bundleIdentifier) (pid: \(app.processID))")
            }
            if !exceptingWindows.isEmpty {
                Log.screen.log("Excepting \(exceptingWindows.count) window(s) from exclusion")
            }
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        // Capture at the display's native pixel resolution. SCDisplay's
        // width/height are in points; multiply by the matching NSScreen's
        // backingScaleFactor to get real pixels. This gives a higher-quality
        // source that the compositor can downscale cleanly — visibly sharper
        // than asking SCK to pre-scale for us.
        let scale = Self.backingScaleFactor(for: display.displayID)
        let pixelWidth = Int(CGFloat(display.width) * scale)
        let pixelHeight = Int(CGFloat(display.height) * scale)
        nativePixelSize = CGSize(width: pixelWidth, height: pixelHeight)

        // Clamp the requested fps to the display's refresh rate. Most Mac
        // displays are 60Hz; ProMotion is 120Hz. We cap at 60fps regardless
        // (120fps is out of scope), and on the rare <60Hz external display
        // this prevents requesting more frames than the display can produce.
        let displayRefreshRate = Self.refreshRate(for: display.displayID)
        let effectiveFPS = min(fps, Int32(displayRefreshRate))

        let config = SCStreamConfiguration()
        config.width = pixelWidth
        config.height = pixelHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: effectiveFPS)
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.showsCursor = true
        // Scale queue depth with fps (Cap pattern: ceil(fps/30 * 5)).
        // 5 at 30fps, 10 at 60fps.
        config.queueDepth = Int(ceil(Double(effectiveFPS) / 30.0 * 5.0))

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        try await stream.startCapture()
        self.stream = stream

        Log.screen.log("Capture started: native \(pixelWidth)x\(pixelHeight) (scale \(scale)) @ \(effectiveFPS)fps")
    }

    /// Display refresh rate for the given display. Returns the reported
    /// rate from CGDisplayMode, or 60 if the display reports 0 (common
    /// for LCD panels — they have a fixed refresh that CGDisplayMode
    /// doesn't surface).
    static func refreshRate(for displayID: CGDirectDisplayID) -> Int {
        guard let mode = CGDisplayCopyDisplayMode(displayID) else { return 60 }
        let rate = mode.refreshRate
        return rate > 0 ? Int(rate.rounded()) : 60
    }

    /// Update the content filter on a live stream. Used to add newly-launched
    /// excluded apps or refresh Finder browser window exceptions mid-recording.
    func updateFilter(
        excludingApps: [SCRunningApplication],
        exceptingWindows: [SCWindow] = []
    ) async throws {
        guard let display = captureDisplay, let stream else { return }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludingApps,
            exceptingWindows: exceptingWindows
        )
        try await stream.updateContentFilter(filter)
        Log.screen.log("Filter updated: \(excludingApps.count) app(s) excluded, \(exceptingWindows.count) window(s) excepted")
    }

    /// Look up the backing scale factor for a CGDirectDisplayID. Falls back
    /// to 1.0 if no matching NSScreen is found (shouldn't happen in practice).
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

    /// Native pixel dimensions of a given display. Used by the coordinator
    /// to decide whether the 4K preset is offered, before recording starts.
    static func nativePixelSize(for display: SCDisplay) -> CGSize {
        let scale = backingScaleFactor(for: display.displayID)
        return CGSize(
            width: CGFloat(display.width) * scale,
            height: CGFloat(display.height) * scale
        )
    }

    func stopCapture() async {
        do {
            try await stream?.stopCapture()
        } catch {
            Log.screen.log("Stop error: \(error)")
        }
        stream = nil
        captureDisplay = nil
        Log.screen.log("Capture stopped")
    }
}

extension ScreenCaptureManager: SCStreamOutput {
    func stream(_: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // SCStream delivers sample buffers with a status attachment. Only
        // `.complete` frames carry fresh image data — `.idle`, `.blank`,
        // `.suspended` etc. should be dropped. See SCFrameStatus docs and
        // Apple's "Capturing screen content in macOS" sample code.
        guard
            let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let attachments = attachmentsArray.first,
            let statusRaw = attachments[SCStreamFrameInfo.status] as? Int,
            let status = SCFrameStatus(rawValue: statusRaw),
            status == .complete
        else { return }

        onScreenFrame?(sampleBuffer)
    }
}

extension ScreenCaptureManager: SCStreamDelegate {
    func stream(_: SCStream, didStopWithError error: any Error) {
        Log.screen.log("Stream stopped with error: \(error)")
        onStreamError?(error)
    }
}
