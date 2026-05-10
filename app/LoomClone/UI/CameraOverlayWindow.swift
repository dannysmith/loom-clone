import AppKit
import AVFoundation
import CoreMedia

/// Transparent floating window that shows the live camera feed during
/// recording. Uses the same `CameraPreviewLayerView` as the popover preview,
/// fed by sample buffers from the recording's camera capture session.
///
/// Has two visual styles depending on recording mode:
///   - `.circle`    — 240x240 circular crop, used in screenAndCamera (matches
///                    the circular PiP that the compositor actually produces)
///   - `.rectangle` — 360x202 16:9 frame, used in cameraOnly (matches the
///                    full-frame camera output that goes into the recording)
///
/// Draggable. Appears above fullscreen apps and follows Space switches via
/// `.statusBar` window level + `.canJoinAllSpaces` / `.fullScreenAuxiliary`.
///
/// Isolation contract:
///   - The class is `@MainActor` so AppKit state (panel, observers) is
///     only ever touched on main. Almost every method inherits that.
///   - `@unchecked Sendable` lets references cross into the camera capture
///     queue (a Sendable closure captures `overlay` and calls `enqueue`).
///     Crossing is safe because everything reachable from the per-frame
///     path is itself thread-safe: AVSampleBufferDisplayLayer.enqueue per
///     Apple's docs, and the `previewView` pointer load is word-sized
///     atomic on ARM64. The worst case during a style change is one
///     frame enqueued into the outgoing preview view, which is harmless.
///   - `enqueue(_:)` is the only `nonisolated` entry point. Everything
///     else lives on main.
@MainActor
final class CameraOverlayWindow: @unchecked Sendable {
    enum Style: Equatable {
        case circle
        case rectangle

        var size: NSSize {
            switch self {
            case .circle: NSSize(width: 240, height: 240)
            case .rectangle: NSSize(width: 360, height: 202) // 16:9
            }
        }

        var cornerRadius: CGFloat {
            switch self {
            case .circle: 120 // half of 240 → circle
            case .rectangle: 12
            }
        }
    }

    private var panel: NSPanel?
    private var currentStyle: Style = .circle

    /// Read by `enqueue(_:)` from any thread. The class invariant is that
    /// writes only happen on MainActor (in `show` and `tearDownPanel`); the
    /// nonisolated read in `enqueue` is a single word-sized atomic load on
    /// ARM64. Marked unsafe rather than synchronised because the cost of a
    /// dispatch round-trip per frame isn't justified by the harm (stale
    /// pointer → enqueue into outgoing view → flushed on next tearDown).
    nonisolated(unsafe) private var previewView: CameraPreviewLayerView?

    /// Last known quadrant so we only fire the callback on actual changes.
    private var currentQuadrant: PipPosition = .bottomRight

    /// Fired when the user drags the overlay into a different screen quadrant.
    /// Set by the coordinator before recording starts.
    var onQuadrantChanged: ((PipPosition) -> Void)?

    private var moveObserver: NSObjectProtocol?

    /// Optional shared camera-adjustments state. Forwarded into the preview
    /// layer on every `show()` so the overlay reflects slider moves live.
    private var adjustmentsState: CameraAdjustmentsState?

    func setAdjustmentsState(_ state: CameraAdjustmentsState?) {
        adjustmentsState = state
        previewView?.setAdjustmentsState(state)
    }

    /// Show (or reconfigure) the overlay with the given style. If the overlay
    /// is already visible with the same style, just brings it to front. If
    /// it's visible with a different style, rebuilds in place — the outer
    /// `CameraOverlayWindow` reference stays valid so callbacks that captured
    /// it keep working.
    func show(on screen: NSScreen?, style: Style) {
        if panel != nil, currentStyle == style {
            panel?.orderFrontRegardless()
            return
        }

        // Remember the previous position so we don't jump the overlay around
        // when the user has dragged it somewhere and then switched modes.
        let previousOrigin = panel?.frame.origin

        tearDownPanel()
        currentStyle = style

        let size = style.size

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

        let container = NSView(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.layer?.cornerRadius = style.cornerRadius
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 2
        container.layer?.borderColor = NSColor.white.withAlphaComponent(0.3).cgColor

        let preview = CameraPreviewLayerView(frame: container.bounds)
        preview.autoresizingMask = [.width, .height]
        preview.setAdjustmentsState(adjustmentsState)
        container.addSubview(preview)

        panel.contentView = container
        self.panel = panel
        self.previewView = preview

        if let previousOrigin {
            // Preserve the user's dragged position, but clamp the new frame
            // to the visible screen so a larger size doesn't hang off the
            // edge (e.g. when switching from the compact circle to the wider
            // 16:9 rectangle while near the right edge).
            let proposed = NSRect(origin: previousOrigin, size: size)
            let clamped = clampedToVisibleFrame(proposed, on: screen)
            panel.setFrame(clamped, display: false)
        } else {
            positionPanel(on: screen)
        }
        panel.orderFrontRegardless()
        observePanelMoves()
    }

    private func clampedToVisibleFrame(_ frame: NSRect, on screen: NSScreen?) -> NSRect {
        guard let screen = screen ?? NSScreen.main else { return frame }
        let visible = screen.visibleFrame
        let edgeMargin: CGFloat = 8
        var result = frame
        if result.maxX > visible.maxX - edgeMargin {
            result.origin.x = visible.maxX - result.width - edgeMargin
        }
        if result.minX < visible.minX + edgeMargin {
            result.origin.x = visible.minX + edgeMargin
        }
        if result.maxY > visible.maxY - edgeMargin {
            result.origin.y = visible.maxY - result.height - edgeMargin
        }
        if result.minY < visible.minY + edgeMargin {
            result.origin.y = visible.minY + edgeMargin
        }
        return result
    }

    // MARK: - Quadrant Detection

    private func observePanelMoves() {
        if let old = moveObserver {
            NotificationCenter.default.removeObserver(old)
        }
        guard let panel else { return }
        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            // NotificationCenter delivers on the main thread (queue:.main),
            // but Swift concurrency doesn't formally guarantee that's the
            // MainActor. Hop explicitly so we can't trip a future runtime
            // check. Cheap — fires once per window-move event.
            Task { @MainActor [weak self] in
                self?.handlePanelMoved()
            }
        }
    }

    private func handlePanelMoved() {
        guard let panel else { return }
        let frame = panel.frame
        let centre = CGPoint(x: frame.midX, y: frame.midY)
        let screen = panel.screen ?? NSScreen.main
        guard let visibleFrame = screen?.visibleFrame else { return }
        let quadrant = PipPosition.from(point: centre, in: visibleFrame)
        guard quadrant != currentQuadrant else { return }
        currentQuadrant = quadrant
        onQuadrantChanged?(quadrant)
    }

    /// Enqueue a sample buffer for display. Thread-safe — call from any queue.
    /// The only `nonisolated` entry point on this class; see class header
    /// for the isolation contract.
    nonisolated func enqueue(_ sampleBuffer: CMSampleBuffer) {
        previewView?.enqueue(sampleBuffer)
    }

    func hide() {
        tearDownPanel()
    }

    private func tearDownPanel() {
        if let observer = moveObserver {
            NotificationCenter.default.removeObserver(observer)
            moveObserver = nil
        }
        previewView?.flush()
        panel?.orderOut(nil)
        panel = nil
        previewView = nil
    }

    var isVisible: Bool {
        panel != nil
    }

    private func positionPanel(on screen: NSScreen?) {
        guard let screen = screen ?? NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame
        let size = currentStyle.size
        let x = visibleFrame.maxX - size.width - 40
        let y = visibleFrame.minY + 40
        panel?.setFrameOrigin(NSPoint(x: x, y: y))
    }
}
