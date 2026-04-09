import SwiftUI
import ScreenCaptureKit
import AVFoundation

struct MenuView: View {
    @Bindable var coordinator: RecordingCoordinator
    var onRecord: () -> Void

    /// Width of the left-hand label column in the device picker rows.
    /// Sized to comfortably fit "Microphone" (the widest label).
    private let labelColumnWidth: CGFloat = 80

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {

            // Server health banner (shown if the server isn't reachable)
            if !coordinator.serverReachable {
                serverUnavailableBanner
            }

            // Screen permission banner (shown instead of display picker when denied)
            if coordinator.screenPermissionDenied {
                screenPermissionBanner
            } else if !coordinator.availableDisplays.isEmpty {
                pickerRow(label: "Display") {
                    DropdownMenu(
                        selection: coordinator.selectedDisplay?.displayID,
                        options: coordinator.availableDisplays.map {
                            .init(id: $0.displayID, label: displayName(for: $0))
                        },
                        onSelect: { id in
                            coordinator.selectedDisplay = coordinator.availableDisplays.first {
                                $0.displayID == id
                            }
                        }
                    )
                }
            }

            // Camera picker
            if !coordinator.availableCameras.isEmpty {
                pickerRow(label: "Camera") {
                    DropdownMenu(
                        selection: coordinator.selectedCamera?.uniqueID,
                        options: coordinator.availableCameras.map {
                            .init(id: $0.uniqueID, label: $0.localizedName)
                        },
                        onSelect: { id in
                            coordinator.selectedCamera = coordinator.availableCameras.first {
                                $0.uniqueID == id
                            }
                        }
                    )
                }
            }

            // Microphone picker
            if !coordinator.availableMicrophones.isEmpty {
                pickerRow(label: "Microphone") {
                    DropdownMenu(
                        selection: coordinator.selectedMicrophone?.uniqueID,
                        options: coordinator.availableMicrophones.map {
                            .init(id: $0.uniqueID, label: $0.localizedName)
                        },
                        onSelect: { id in
                            coordinator.selectedMicrophone = coordinator.availableMicrophones.first {
                                $0.uniqueID == id
                            }
                        }
                    )
                }
            }

            // Preview area — contents depend on mode
            if coordinator.state == .idle {
                previewArea
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
            .labelsHidden()

            // Record button — disabled if any prerequisite isn't satisfied
            let canRecord = coordinator.state == .idle
                && !coordinator.screenPermissionDenied
                && coordinator.selectedDisplay != nil
                && coordinator.serverReachable

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

    // MARK: - Picker Row Helper

    /// A label + control row where the label has a fixed column width and
    /// the control fills the remaining space. The HStack is forced to
    /// `maxWidth: .infinity` and the content gets `layoutPriority(1)` so
    /// SwiftUI's Picker (which has a sticky intrinsic width based on the
    /// widest menu item) actually expands to the row width instead of
    /// shrinking to fit its shortest selection.
    @ViewBuilder
    private func pickerRow<Content: View>(
        label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .frame(width: labelColumnWidth, alignment: .leading)
            content()
                .layoutPriority(1)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Preview Area

    /// Preview content shown in the popover when idle. Adapts to the current
    /// mode so the popover mirrors what the recording will actually produce:
    ///   - cameraOnly      → live camera feed (full frame)
    ///   - screenOnly      → periodic screenshot of the selected display
    ///   - screenAndCamera → screenshot as background + camera PiP circle
    @ViewBuilder
    private var previewArea: some View {
        ZStack(alignment: .bottomTrailing) {
            // Background layer — either screen snapshot or black.
            if coordinator.mode != .cameraOnly {
                if let img = coordinator.screenPreview.image {
                    Image(decorative: img, scale: 1.0, orientation: .up)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ZStack {
                        Color.black.opacity(0.4)
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }

            // Camera layer — either full-frame or PiP circle.
            if coordinator.mode == .cameraOnly {
                if coordinator.cameraPreview.isActive {
                    CameraPreviewView(manager: coordinator.cameraPreview)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    Color.black.opacity(0.4)
                }
            } else if coordinator.mode == .screenAndCamera
                        && coordinator.cameraPreview.isActive {
                CameraPreviewView(manager: coordinator.cameraPreview)
                    .frame(width: 54, height: 54)
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(.white.opacity(0.7), lineWidth: 1.5)
                    )
                    .padding(8)
            }
        }
        .frame(height: 160)
        .frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Server Banner

    private var serverUnavailableBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Server unreachable")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text("Start the recording server at localhost:3000 before recording.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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

    // MARK: - Helpers

    private func displayName(for display: SCDisplay) -> String {
        if coordinator.availableDisplays.count == 1 {
            return "Main Display"
        }
        return "Display \(display.displayID)"
    }
}
