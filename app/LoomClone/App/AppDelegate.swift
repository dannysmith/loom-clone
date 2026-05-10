import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var eventMonitor: Any?
    private var recordingPanel: RecordingPanel?
    private let shortcutManager = KeyboardShortcutManager()
    let coordinator = RecordingCoordinator()
    private let healAgent = HealAgent()
    let transcribeAgent = TranscribeAgent()

    func applicationDidFinishLaunching(_: Notification) {
        setupStatusItem()
        setupPopover()

        // Hand agents to the coordinator so post-stop handoffs work,
        // and kick off startup scans for healing and transcription.
        coordinator.healAgent = healAgent
        coordinator.transcribeAgent = transcribeAgent
        Task { await healAgent.runStartupScan() }
        Task { await transcribeAgent.runStartupScan() }

        shortcutManager.register(
            coordinator: coordinator,
            onToggleRecord: { [weak self] in self?.handleRecord() },
            onStop: { [weak self] in self?.handleStop() }
        )

        // When the compositor's terminal-error path stops a recording on its
        // own, the coordinator needs to tell us to hide the floating panel —
        // it doesn't own it.
        coordinator.onTerminalRecordingStop = { [weak self] in
            self?.recordingPanel?.hide()
        }

        // Device enumeration + camera preview lifecycle are owned by
        // `popoverDidOpen()` / `popoverWillClose()`, so the camera hardware
        // (and the macOS green indicator) is only active when the popover is
        // visible or a recording is in progress.
    }

    func applicationWillTerminate(_: Notification) {
        shortcutManager.unregister()
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    // MARK: - Status Item

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "record.circle",
                accessibilityDescription: "LoomClone"
            )
            button.action = #selector(togglePopover)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
    }

    private func setupPopover() {
        let popover = NSPopover()
        popover.contentSize = NSSize(width: 300, height: 420)
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        let content = MenuView(coordinator: coordinator, onRecord: { [weak self] in
            self?.handleRecord()
        })
        popover.contentViewController = NSHostingController(rootView: content)
        self.popover = popover

        // Close popover when clicking outside
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.closePopover()
        }
    }

    @objc private func togglePopover(_: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp {
            // Right click: show quit menu
            showQuitMenu()
            return
        }

        if popover.isShown {
            closePopover()
        } else {
            openPopover()
        }
    }

    private func openPopover() {
        guard let button = statusItem.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    private func closePopover() {
        popover.performClose(nil)
    }

    private func showQuitMenu() {
        let menu = NSMenu()
        menu.addItem(
            NSMenuItem(
                title: "Quit LoomClone",
                action: #selector(NSApplication.terminate(_:)),
                keyEquivalent: "q"
            )
        )
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    // MARK: - Recording

    private func handleRecord() {
        guard coordinator.state == .idle else { return }
        closePopover()
        coordinator.startRecording()
        showRecordingPanel()
    }

    private func showRecordingPanel() {
        if recordingPanel == nil {
            recordingPanel = RecordingPanel(
                coordinator: coordinator,
                onStop: { [weak self] in self?.handleStop() },
                onCancel: { [weak self] in self?.handleCancel() }
            )
        }
        recordingPanel?.show()
    }

    // MARK: - Popover Delegate

    // See the `NSPopoverDelegate` extension below for the lifecycle hooks
    // that start and stop the camera preview.

    func handleCancel() {
        if coordinator.cancelRecording() {
            recordingPanel?.hide()
        }
    }

    func handleStop() {
        // If we're cancelling a countdown, just stop and hide — no URL to copy.
        let wasCountingDown = coordinator.state == .countingDown

        coordinator.stopRecording()
        recordingPanel?.hide()

        guard !wasCountingDown else { return }

        // Copy URL to clipboard when available
        Task {
            try? await Task.sleep(for: .seconds(1))
            if let url = coordinator.lastVideo?.url {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
                Log.app.log("URL copied to clipboard: \(url)")
            }
        }
    }
}

// MARK: - NSPopoverDelegate

extension AppDelegate: NSPopoverDelegate {
    func popoverWillShow(_: Notification) {
        coordinator.popoverDidOpen()
    }

    func popoverDidClose(_: Notification) {
        coordinator.popoverWillClose()
    }
}
