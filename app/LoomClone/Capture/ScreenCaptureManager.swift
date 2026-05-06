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
                print("[screen] Excluding from capture: \(app.bundleIdentifier) (pid: \(app.processID))")
            }
            if !exceptingWindows.isEmpty {
                print("[screen] Excepting \(exceptingWindows.count) window(s) from exclusion")
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

        let config = SCStreamConfiguration()
        config.width = pixelWidth
        config.height = pixelHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.showsCursor = true
        config.queueDepth = 5

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        try await stream.startCapture()
        self.stream = stream

        print("[screen] Capture started: native \(pixelWidth)x\(pixelHeight) (scale \(scale)) @ 30fps")
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
        print("[screen] Filter updated: \(excludingApps.count) app(s) excluded, \(exceptingWindows.count) window(s) excepted")
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
            print("[screen] Stop error: \(error)")
        }
        stream = nil
        captureDisplay = nil
        print("[screen] Capture stopped")
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
        print("[screen] Stream stopped with error: \(error)")
        onStreamError?(error)
    }
}
