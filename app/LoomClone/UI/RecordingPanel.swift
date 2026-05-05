import AppKit
import SwiftUI

@MainActor
final class RecordingPanel {
    private var panel: NSPanel?
    private let coordinator: RecordingCoordinator
    private let onStop: () -> Void
    private let onCancel: () -> Void

    /// Fixed panel height: toolbar (~56pt) + warning space (~70pt for 2-3
    /// pills) + shadow/padding (~26pt). The toolbar is pinned to the bottom;
    /// warnings appear in the clear space above. Panel size never changes.
    private static let panelWidth: CGFloat = 360
    private static let panelHeight: CGFloat = 160

    init(
        coordinator: RecordingCoordinator,
        onStop: @escaping () -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.onStop = onStop
        self.onCancel = onCancel
    }

    func show() {
        if panel == nil {
            createPanel()
        }
        positionPanel()
        panel?.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func createPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.panelHeight),
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
        // Shadow is rendered by the SwiftUI toolbar shape, not the panel
        // frame — otherwise the panel's full rect (including the transparent
        // warning area) would cast a shadow.
        panel.hasShadow = false

        let content = RecordingPanelContent(
            coordinator: coordinator,
            onStop: onStop,
            onCancel: onCancel
        )
        let hostingView = NSHostingView(rootView: content)
        hostingView.translatesAutoresizingMaskIntoConstraints = false

        panel.contentView = NSView()
        panel.contentView?.addSubview(hostingView)

        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor),
        ])

        self.panel = panel
    }

    private func positionPanel() {
        guard let screen = NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame

        let x = visibleFrame.midX - Self.panelWidth / 2
        // Position the panel so the toolbar (pinned to the bottom of the
        // panel, with 12pt bottom padding) sits ~28pt above the screen bottom.
        let y = visibleFrame.minY + 16

        panel?.setFrameOrigin(NSPoint(x: x, y: y))
    }
}
