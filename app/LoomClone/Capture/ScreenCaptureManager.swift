import Foundation
import ScreenCaptureKit
import CoreMedia

final class ScreenCaptureManager: NSObject, @unchecked Sendable {

    var onScreenFrame: (@Sendable (CMSampleBuffer) -> Void)?

    private var stream: SCStream?
    private let captureQueue = DispatchQueue(label: "com.loomclone.screen-capture", qos: .userInteractive)

    func startCapture(display: SCDisplay, excludingApp: SCRunningApplication? = nil) async throws {
        let filter: SCContentFilter
        if let app = excludingApp {
            filter = SCContentFilter(display: display, excludingApplications: [app], exceptingWindows: [])
            print("[screen] Excluding app windows from capture (pid: \(app.processID))")
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        let config = SCStreamConfiguration()
        config.width = 1920
        config.height = 1080
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.showsCursor = true
        config.queueDepth = 5

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        try await stream.startCapture()
        self.stream = stream

        print("[screen] Capture started: \(display.width)x\(display.height) -> 1920x1080 @ 30fps")
    }

    func stopCapture() async {
        do {
            try await stream?.stopCapture()
        } catch {
            print("[screen] Stop error: \(error)")
        }
        stream = nil
        print("[screen] Capture stopped")
    }
}

extension ScreenCaptureManager: SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // SCStream delivers sample buffers with a status attachment. Only
        // `.complete` frames carry fresh image data — `.idle`, `.blank`,
        // `.suspended` etc. should be dropped. See SCFrameStatus docs and
        // Apple's "Capturing screen content in macOS" sample code.
        guard
            let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let attachments = attachmentsArray.first,
            let statusRaw = attachments[SCStreamFrameInfo.status] as? Int,
            let status = SCFrameStatus(rawValue: statusRaw),
            status == .complete
        else { return }

        onScreenFrame?(sampleBuffer)
    }
}

extension ScreenCaptureManager: SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        print("[screen] Stream stopped with error: \(error)")
    }
}
