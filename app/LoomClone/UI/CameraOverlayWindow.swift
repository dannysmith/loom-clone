import AppKit
import CoreImage

/// Transparent floating window that shows the live camera feed as a circle.
/// Visible during recording in modes that use the camera (screenAndCamera, cameraOnly).
/// Draggable. Appears above fullscreen apps and follows Space switches.
///
/// Uses frame-based rendering (CALayer + CIContext) instead of AVCaptureVideoPreviewLayer
/// to avoid dual-session conflicts with CameraCaptureManager during recording.
@MainActor
final class CameraOverlayWindow {

    private var panel: NSPanel?
    private var imageLayer: CALayer?
    private let ciContext: CIContext

    let diameter: CGFloat = 240

    init() {
        ciContext = CIContext(options: [.useSoftwareRenderer: false])
    }

    func show(on screen: NSScreen?) {
        if panel != nil {
            panel?.orderFrontRegardless()
            return
        }

        let size = NSSize(width: diameter, height: diameter)

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true

        // Container view with circular mask
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.layer?.cornerRadius = diameter / 2
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 2
        container.layer?.borderColor = NSColor.white.withAlphaComponent(0.3).cgColor

        // Image layer for rendering camera frames
        let imgLayer = CALayer()
        imgLayer.frame = container.bounds
        imgLayer.contentsGravity = .resizeAspectFill
        container.layer?.addSublayer(imgLayer)

        panel.contentView = container
        self.panel = panel
        self.imageLayer = imgLayer

        positionPanel(on: screen)
        panel.orderFrontRegardless()
    }

    /// Render a camera frame into the overlay. Called from RecordingActor via coordinator.
    func updateFrame(_ pixelBuffer: CVPixelBuffer) {
        guard let imageLayer else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard let cgImage = ciContext.createCGImage(
            ciImage,
            from: CGRect(x: 0, y: 0, width: width, height: height)
        ) else { return }
        imageLayer.contents = cgImage
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
        imageLayer = nil
    }

    var isVisible: Bool { panel != nil }

    private func positionPanel(on screen: NSScreen?) {
        guard let screen = screen ?? NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame
        let x = visibleFrame.maxX - diameter - 40
        let y = visibleFrame.minY + 40
        panel?.setFrameOrigin(NSPoint(x: x, y: y))
    }
}
