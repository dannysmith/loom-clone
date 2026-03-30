import Foundation
import ScreenCaptureKit
import CoreMedia

final class ScreenCaptureManager: NSObject, @unchecked Sendable {

    var onScreenFrame: (@Sendable (CMSampleBuffer) -> Void)?

    private var stream: SCStream?
    private let captureQueue = DispatchQueue(label: "com.loomclone.screen-capture", qos: .userInteractive)

    func startCapture(display: SCDisplay) async throws {
        let filter = SCContentFilter(display: display, excludingWindows: [])

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
        guard type == .screen else { return }
        onScreenFrame?(sampleBuffer)
    }
}

extension ScreenCaptureManager: SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        print("[screen] Stream stopped with error: \(error)")
    }
}
