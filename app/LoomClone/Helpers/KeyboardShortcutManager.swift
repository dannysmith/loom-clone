import AppKit

@MainActor
final class KeyboardShortcutManager {
    private var globalMonitor: Any?
    private weak var coordinator: RecordingCoordinator?
    private var onToggleRecord: (() -> Void)?
    private var onStop: (() -> Void)?

    func register(
        coordinator: RecordingCoordinator,
        onToggleRecord: @escaping () -> Void,
        onStop: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.onToggleRecord = onToggleRecord
        self.onStop = onStop

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleKeyEvent(event)
            }
        }
    }

    func unregister() {
        if let monitor = globalMonitor {
            NSEvent.removeMonitor(monitor)
            globalMonitor = nil
        }
    }

    private func handleKeyEvent(_ event: NSEvent) {
        guard let coordinator else { return }

        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let cmdShift: NSEvent.ModifierFlags = [.command, .shift]

        guard modifiers == cmdShift else { return }

        switch event.keyCode {
        case 15: // R key
            if coordinator.state == .idle {
                onToggleRecord?()
            } else if coordinator.state == .recording || coordinator.state == .paused {
                onStop?()
            }

        case 35: // P key
            if coordinator.state == .recording {
                coordinator.pauseRecording()
            } else if coordinator.state == .paused {
                coordinator.resumeRecording()
            }

        case 46: // M key
            if coordinator.state == .recording || coordinator.state == .paused {
                coordinator.cycleMode()
            }

        default:
            break
        }
    }
}
