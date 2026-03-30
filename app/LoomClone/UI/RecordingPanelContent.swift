import SwiftUI

struct RecordingPanelContent: View {
    @Bindable var coordinator: RecordingCoordinator
    var onStop: () -> Void

    var body: some View {
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

            Divider()
                .frame(height: 24)

            // Mode buttons
            ForEach(RecordingMode.allCases, id: \.self) { mode in
                Button(action: { coordinator.switchMode(to: mode) }) {
                    Image(systemName: mode.systemImage)
                        .font(.body)
                        .foregroundStyle(coordinator.mode == mode ? .primary : .secondary)
                }
                .buttonStyle(.plain)
                .help(mode.displayName)
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
