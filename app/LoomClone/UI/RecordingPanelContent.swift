import SwiftUI

struct RecordingPanelContent: View {
    @Bindable var coordinator: RecordingCoordinator
    var onStop: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Absorb unused space at the top so the toolbar is always
            // pinned to the bottom of the fixed-height panel.
            Spacer(minLength: 0)

            // Warnings float in the clear area above the toolbar.
            if coordinator.state != .countingDown, !coordinator.activeWarnings.isEmpty {
                WarningBannerView(warnings: coordinator.activeWarnings) { warning in
                    coordinator.dismissWarning(warning)
                }
                .padding(.bottom, 6)
            }

            // Toolbar: vibrancy background, rounded corners, shadow.
            Group {
                if coordinator.state == .countingDown {
                    countdownView
                } else {
                    recordingControls
                }
            }
            .background(VisualEffectBackground())
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.3), radius: 8, y: 2)
        }
        // Inset from panel edges so the shadow renders fully.
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    private var countdownView: some View {
        HStack(spacing: 12) {
            // Cancel during countdown
            Button(action: onStop) {
                Image(systemName: "xmark.circle.fill")
                    .font(.title)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Cancel")

            Divider()
                .frame(height: 24)

            Text("Starting in")
                .font(.body)
                .foregroundStyle(.secondary)

            Text("\(coordinator.countdownSeconds ?? 0)")
                .font(.system(size: 28, weight: .semibold, design: .rounded))
                .foregroundStyle(.primary)
                .monospacedDigit()
                .frame(minWidth: 32)
                .contentTransition(.numericText(countsDown: true))
                .animation(.easeOut(duration: 0.2), value: coordinator.countdownSeconds)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var recordingControls: some View {
        HStack(spacing: 12) {
            // Stop button
            Button(action: onStop) {
                Image(systemName: "stop.circle.fill")
                    .font(.title)
                    .foregroundStyle(.red)
            }
            .buttonStyle(.plain)
            .help("Stop Recording")

            // Pause / Resume
            Button(action: togglePause) {
                Image(systemName: coordinator.state == .paused
                    ? "play.circle.fill"
                    : "pause.circle.fill")
                    .font(.title)
                    .foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
            .help(coordinator.state == .paused ? "Resume" : "Pause")

            // Discard / cancel
            Button(action: onCancel) {
                Image(systemName: "trash.circle.fill")
                    .font(.title)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Discard Recording")

            // Mode buttons — only the modes valid for this recording's
            // source set. Devices can't change mid-recording, so the set
            // is fixed at start. When only one mode is available the strip
            // and its surrounding dividers collapse entirely.
            if coordinator.availableModes.count > 1 {
                Divider()
                    .frame(height: 24)

                ForEach(coordinator.availableModes, id: \.self) { mode in
                    Button(
                        action: { coordinator.switchMode(to: mode) },
                        label: {
                            Image(systemName: mode.systemImage)
                                .font(.body)
                                .foregroundStyle(coordinator.mode == mode ? .primary : .secondary)
                        }
                    )
                    .buttonStyle(.plain)
                    .help(mode.displayName)
                }
            }

            Divider()
                .frame(height: 24)

            // Timer
            Text(formattedTime)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(coordinator.state == .paused ? .secondary : .primary)
                .frame(minWidth: 50, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func togglePause() {
        if coordinator.state == .paused {
            coordinator.resumeRecording()
        } else if coordinator.state == .recording {
            coordinator.pauseRecording()
        }
    }

    private var formattedTime: String {
        let total = Int(coordinator.elapsedSeconds)
        let minutes = total / 60
        let seconds = total % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

/// Wraps NSVisualEffectView for use as a SwiftUI background. Reproduces
/// the HUD-window vibrancy that the panel previously got from an AppKit
/// NSVisualEffectView covering the entire content area.
struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context _: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_: NSVisualEffectView, context _: Context) {}
}
