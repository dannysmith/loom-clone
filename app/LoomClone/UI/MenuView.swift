import SwiftUI
import ScreenCaptureKit
import AVFoundation

struct MenuView: View {
    @Bindable var coordinator: RecordingCoordinator
    var onRecord: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Display picker
            if !coordinator.availableDisplays.isEmpty {
                LabeledContent("Display") {
                    Picker("", selection: displayBinding) {
                        ForEach(coordinator.availableDisplays, id: \.displayID) { display in
                            Text(displayName(for: display))
                                .tag(display.displayID)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 160)
                }
            }

            // Camera picker
            if !coordinator.availableCameras.isEmpty {
                LabeledContent("Camera") {
                    Picker("", selection: cameraBinding) {
                        ForEach(coordinator.availableCameras, id: \.uniqueID) { device in
                            Text(device.localizedName).tag(device.uniqueID)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 160)
                }
            }

            // Microphone picker
            if !coordinator.availableMicrophones.isEmpty {
                LabeledContent("Microphone") {
                    Picker("", selection: micBinding) {
                        ForEach(coordinator.availableMicrophones, id: \.uniqueID) { device in
                            Text(device.localizedName).tag(device.uniqueID)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 160)
                }
            }

            Divider()

            // Mode picker
            Picker("Mode", selection: $coordinator.mode) {
                ForEach(RecordingMode.allCases, id: \.self) { mode in
                    Label(mode.displayName, systemImage: mode.systemImage)
                        .tag(mode)
                }
            }
            .pickerStyle(.segmented)

            // Record button
            Button(action: onRecord) {
                Label("Record", systemImage: "record.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(coordinator.state != .idle)

            // Show last video URL if available
            if let url = coordinator.lastVideoURL {
                HStack {
                    Text(url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Open") {
                        if let nsURL = URL(string: url) {
                            NSWorkspace.shared.open(nsURL)
                        }
                    }
                    .font(.caption)
                }
            }

            Divider()

            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .foregroundStyle(.secondary)
            .font(.caption)
        }
        .padding(12)
        .frame(width: 300)
    }

    // MARK: - Bindings

    private var displayBinding: Binding<CGDirectDisplayID> {
        Binding(
            get: { coordinator.selectedDisplay?.displayID ?? 0 },
            set: { id in
                coordinator.selectedDisplay = coordinator.availableDisplays.first {
                    $0.displayID == id
                }
            }
        )
    }

    private var cameraBinding: Binding<String> {
        Binding(
            get: { coordinator.selectedCamera?.uniqueID ?? "" },
            set: { id in
                coordinator.selectedCamera = coordinator.availableCameras.first {
                    $0.uniqueID == id
                }
            }
        )
    }

    private var micBinding: Binding<String> {
        Binding(
            get: { coordinator.selectedMicrophone?.uniqueID ?? "" },
            set: { id in
                coordinator.selectedMicrophone = coordinator.availableMicrophones.first {
                    $0.uniqueID == id
                }
            }
        )
    }

    // MARK: - Helpers

    private func displayName(for display: SCDisplay) -> String {
        if coordinator.availableDisplays.count == 1 {
            return "Main Display"
        }
        return "Display \(display.displayID)"
    }
}
