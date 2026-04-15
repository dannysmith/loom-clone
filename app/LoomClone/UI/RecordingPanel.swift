import AppKit
import SwiftUI

@MainActor
final class RecordingPanel {
    private var panel: NSPanel?
    private let coordinator: RecordingCoordinator
    private let onStop: () -> Void
    private let onCancel: () -> Void

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
        // Width accommodates the three optional DEBUG buttons at the right
        // edge (compiled out of release builds). The panel auto-centres so the
        // extra width just expands symmetrically — harmless when the DEBUG
        // buttons are absent.
        #if DEBUG
        let width: CGFloat = 440
        #else
        let width: CGFloat = 320
        #endif
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: 56),
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

        // Vibrancy background
        let visualEffect = NSVisualEffectView()
        visualEffect.material = .hudWindow
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.wantsLayer = true
        visualEffect.layer?.cornerRadius = 12
        visualEffect.layer?.masksToBounds = true

        let content = RecordingPanelContent(
            coordinator: coordinator,
            onStop: onStop,
            onCancel: onCancel
        )
        let hostingView = NSHostingView(rootView: content)
        hostingView.translatesAutoresizingMaskIntoConstraints = false

        visualEffect.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = NSView()
        panel.contentView?.addSubview(visualEffect)
        panel.contentView?.addSubview(hostingView)

        NSLayoutConstraint.activate([
            visualEffect.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
            visualEffect.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
            visualEffect.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
            visualEffect.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor),

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
        let panelSize = panel?.frame.size ?? NSSize(width: 320, height: 56)

        let x = visibleFrame.midX - panelSize.width / 2
        let y = visibleFrame.minY + 40 // 40pt above the bottom of the visible area

        panel?.setFrameOrigin(NSPoint(x: x, y: y))
    }
}
