import AppKit

@MainActor
final class KeyboardShortcutManager {
    // Virtual key codes (Carbon/Events.h)
    private static let keyR: UInt16 = 15
    private static let keyP: UInt16 = 35
    private static let keyM: UInt16 = 46

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
        case Self.keyR:
            if coordinator.state == .idle {
                onToggleRecord?()
            } else if coordinator.state == .recording || coordinator.state == .paused {
                onStop?()
            }

        case Self.keyP:
            if coordinator.state == .recording {
                coordinator.pauseRecording()
            } else if coordinator.state == .paused {
                coordinator.resumeRecording()
            }

        case Self.keyM:
            if coordinator.state == .recording || coordinator.state == .paused {
                coordinator.cycleMode()
            }

        default:
            break
        }
    }
}
