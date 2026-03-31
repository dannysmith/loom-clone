import SwiftUI
import ScreenCaptureKit
import AVFoundation

struct MenuView: View {
    @Bindable var coordinator: RecordingCoordinator
    var onRecord: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {

            // Screen permission banner (shown instead of display picker when denied)
            if coordinator.screenPermissionDenied {
                screenPermissionBanner
            } else if !coordinator.availableDisplays.isEmpty {
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

            // Camera preview (shown when idle and camera is available)
            if coordinator.cameraPreview.session != nil && coordinator.state == .idle {
                ZStack {
                    CameraPreviewView(session: coordinator.cameraPreview.session)

                    // Circle indicator showing the visible area in Screen+Camera mode
                    if coordinator.mode == .screenAndCamera {
                        Circle()
                            .strokeBorder(.white.opacity(0.6), lineWidth: 2)
                            .background(Circle().fill(.white.opacity(0.08)))
                            .frame(width: 80, height: 80)
                    }
                }
                .frame(height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .frame(maxWidth: .infinity)
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

            // Record button — disabled if no display available
            let canRecord = coordinator.state == .idle
                && !coordinator.screenPermissionDenied
                && coordinator.selectedDisplay != nil

            Button(action: onRecord) {
                Label("Record", systemImage: "record.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(!canRecord)

            // Last video URL
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

    // MARK: - Permission Banner

    private var screenPermissionBanner: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Screen Recording Required", systemImage: "exclamationmark.shield")
                .font(.caption.bold())
                .foregroundStyle(.orange)

            Text("Grant permission in System Settings, then click Retry.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Button("Open Settings") {
                    coordinator.openScreenRecordingSettings()
                }
                .controlSize(.small)

                Button("Retry") {
                    Task { await coordinator.retryScreenPermission() }
                }
                .controlSize(.small)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(.orange.opacity(0.3), lineWidth: 1)
        )
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
