import SwiftUI
import AVFoundation

/// NSViewRepresentable that displays an AVCaptureSession's video feed.
/// Used in the menu popover to show camera preview before recording.
struct CameraPreviewView: NSViewRepresentable {
    let session: AVCaptureSession?

    func makeNSView(context: Context) -> CameraPreviewNSView {
        let view = CameraPreviewNSView()
        view.updateSession(session)
        return view
    }

    func updateNSView(_ nsView: CameraPreviewNSView, context: Context) {
        nsView.updateSession(session)
    }
}

/// NSView that hosts an AVCaptureVideoPreviewLayer and keeps it sized to the view bounds.
final class CameraPreviewNSView: NSView {
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var currentSession: AVCaptureSession?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
    }

    func updateSession(_ session: AVCaptureSession?) {
        guard session !== currentSession else { return }
        currentSession = session

        previewLayer?.removeFromSuperlayer()
        previewLayer = nil

        guard let session else { return }

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = bounds
        self.layer?.addSublayer(layer)
        self.previewLayer = layer
    }

    override func layout() {
        super.layout()
        previewLayer?.frame = bounds
    }
}
