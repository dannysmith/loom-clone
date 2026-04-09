import AppKit
import AVFoundation
import CoreMedia

/// Transparent floating window that shows the live camera feed as a circle
/// during recording. Uses the same `CameraPreviewLayerView` as the popover
/// preview, fed by sample buffers from the recording's camera capture session.
///
/// Visible during recording in modes that use the camera (screenAndCamera,
/// cameraOnly). Draggable. Appears above fullscreen apps and follows Space
/// switches via `.statusBar` window level + `.canJoinAllSpaces` /
/// `.fullScreenAuxiliary` collection behaviors.
///
/// Intentionally NOT `@MainActor` so the capture queue can call `enqueue`
/// without an actor hop. Methods that manipulate AppKit state (show/hide) are
/// explicitly `@MainActor`. The `previewView` reference is guarded by the
/// same convention: mutated only on main, read by `enqueue` on any thread.
final class CameraOverlayWindow: @unchecked Sendable {

    @MainActor private var panel: NSPanel?
    nonisolated(unsafe) private var previewView: CameraPreviewLayerView?

    let diameter: CGFloat = 240

    @MainActor
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

        // Reuse the same display layer view as the popover preview.
        let preview = CameraPreviewLayerView(frame: container.bounds)
        preview.autoresizingMask = [.width, .height]
        container.addSubview(preview)

        panel.contentView = container
        self.panel = panel
        self.previewView = preview

        positionPanel(on: screen)
        panel.orderFrontRegardless()
    }

    /// Enqueue a sample buffer for display. Thread-safe — call from any queue.
    func enqueue(_ sampleBuffer: CMSampleBuffer) {
        previewView?.enqueue(sampleBuffer)
    }

    @MainActor
    func hide() {
        previewView?.flush()
        panel?.orderOut(nil)
        panel = nil
        previewView = nil
    }

    @MainActor
    var isVisible: Bool { panel != nil }

    @MainActor
    private func positionPanel(on screen: NSScreen?) {
        guard let screen = screen ?? NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame
        let x = visibleFrame.maxX - diameter - 40
        let y = visibleFrame.minY + 40
        panel?.setFrameOrigin(NSPoint(x: x, y: y))
    }
}
