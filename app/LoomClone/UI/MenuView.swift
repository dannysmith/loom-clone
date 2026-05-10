import AVFoundation
import ScreenCaptureKit
import SwiftUI

struct MenuView: View {
    @Bindable var coordinator: RecordingCoordinator
    @State private var apiKeyStatus = APIKeyStatus.shared
    var onRecord: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // API key banner (shown if no token is stored). Takes precedence
            // over the server banner because the key is needed even if the
            // server is up — you'd just get 401s.
            if !apiKeyStatus.hasKey {
                apiKeyMissingBanner
            }

            // Server health banner (shown if the server isn't reachable)
            if !coordinator.serverReachable {
                serverUnavailableBanner
            }

            // Screen permission banner replaces the Display picker when denied
            if coordinator.screenPermissionDenied {
                screenPermissionBanner
            }

            // Device pickers. SwiftUI's own `Picker` wraps `NSPopUpButton`
            // but leaves its horizontal content-hugging priority at
            // `defaultHigh`, which is why `.frame(maxWidth: .infinity)`
            // never actually stretched it. `NativePopUpPicker` wraps
            // `NSPopUpButton` directly with hugging priority lowered, so
            // SwiftUI frame modifiers work as expected and `Form.columns`
            // is able to give all three controls a uniform width.
            Form {
                if !coordinator.screenPermissionDenied, !coordinator.availableDisplays.isEmpty {
                    LabeledContent("Display") {
                        NativePopUpPicker(
                            selection: coordinator.selectedDisplay?.displayID,
                            options: coordinator.availableDisplays.map {
                                .init(id: $0.displayID, label: displayName(for: $0))
                            },
                            includeNone: true,
                            onSelect: { id in
                                coordinator.selectedDisplay = coordinator.availableDisplays.first {
                                    $0.displayID == id
                                }
                            },
                            onSelectNone: {
                                coordinator.selectedDisplay = nil
                            }
                        )
                        .frame(maxWidth: .infinity)
                    }
                }
                if !coordinator.availableCameras.isEmpty {
                    LabeledContent("Camera") {
                        NativePopUpPicker(
                            selection: coordinator.selectedCamera?.uniqueID,
                            options: coordinator.availableCameras.map {
                                .init(id: $0.uniqueID, label: $0.localizedName)
                            },
                            includeNone: true,
                            onSelect: { id in
                                coordinator.selectedCamera = coordinator.availableCameras.first {
                                    $0.uniqueID == id
                                }
                            },
                            onSelectNone: {
                                coordinator.selectedCamera = nil
                            }
                        )
                        .frame(maxWidth: .infinity)
                    }
                }
                if !coordinator.availableMicrophones.isEmpty {
                    LabeledContent("Microphone") {
                        NativePopUpPicker(
                            selection: coordinator.selectedMicrophone?.uniqueID,
                            options: coordinator.availableMicrophones.map {
                                .init(id: $0.uniqueID, label: $0.localizedName)
                            },
                            includeNone: true,
                            onSelect: { id in
                                coordinator.selectedMicrophone = coordinator.availableMicrophones.first {
                                    $0.uniqueID == id
                                }
                            },
                            onSelectNone: {
                                coordinator.selectedMicrophone = nil
                            }
                        )
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .formStyle(.columns)

            // Preview area — contents depend on mode
            if coordinator.state == .idle {
                previewArea
            }

            // Mic input-level meter. Only when a microphone is selected —
            // otherwise there's nothing for it to show, and the capture
            // session wouldn't be running anyway.
            if coordinator.selectedMicrophone != nil, coordinator.state == .idle {
                AudioMeterView(manager: coordinator.microphonePreview)
            }

            Divider()

            // Camera adjustments. Only shown when a camera is selected — the
            // sliders affect nothing if there's no camera feed to filter.
            if coordinator.selectedCamera != nil {
                cameraAdjustmentsSection
            }

            // Mode picker — only shown when more than one mode is reachable.
            // With one source selected, the mode is implicit.
            if coordinator.availableModes.count > 1 {
                Picker("Mode", selection: $coordinator.mode) {
                    ForEach(coordinator.availableModes, id: \.self) { mode in
                        Label(mode.displayName, systemImage: mode.systemImage)
                            .tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            // Output preset picker. 1440p is hidden when no selected source
            // can natively feed it.
            qualityPicker

            // App exclusion — only shown when a display is selected and idle.
            if coordinator.selectedDisplay != nil, coordinator.state == .idle {
                HideAppWindowsSection(coordinator: coordinator)
            }

            // Record button — disabled if any prerequisite isn't satisfied
            let canRecord = coordinator.state == .idle
                && !coordinator.screenPermissionDenied
                && !coordinator.availableModes.isEmpty
                && coordinator.serverReachable
                && apiKeyStatus.hasKey

            Button(action: onRecord) {
                Label("Record", systemImage: "record.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(!canRecord)

            // Last video — inline metadata editor
            if let info = coordinator.lastVideo {
                LastVideoEditorView(
                    videoId: info.videoId,
                    initialURL: info.url,
                    initialSlug: info.slug,
                    initialTitle: info.title,
                    initialVisibility: info.visibility
                )
            }

            Divider()

            HStack {
                SettingsLink {
                    Text("Settings…")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .font(.caption)

                Spacer()

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .font(.caption)
            }
        }
        .padding(12)
        .frame(width: 300)
        // Re-read the Keychain whenever the popover opens, in case the
        // user edited settings since last open. `APIKeyStatus` is a cache,
        // not a live Keychain listener.
        .onChange(of: coordinator.isPopoverOpen) { _, open in
            if open { apiKeyStatus.refresh() }
        }
    }

    // MARK: - Preview Area

    /// Preview content shown in the popover when idle. Adapts to the current
    /// mode so the popover mirrors what the recording will actually produce:
    ///   - cameraOnly      → live camera feed (full frame)
    ///   - screenOnly      → periodic screenshot of the selected display
    ///   - screenAndCamera → screenshot as background + camera PiP circle
    ///   - no sources      → "Select an input above" placeholder
    @ViewBuilder
    private var previewArea: some View {
        if coordinator.availableModes.isEmpty {
            ZStack {
                Color.black.opacity(0.3)
                VStack(spacing: 4) {
                    Image(systemName: "video.slash")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("Select an input above")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 160, maxHeight: 160)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            previewContent
        }
    }

    private var previewContent: some View {
        ZStack(alignment: .bottomTrailing) {
            // Invisible flexible base layer. The ZStack's width is the max
            // of its children's returned widths, and the set of children
            // changes with mode (cameraOnly has a single NSViewRepresentable
            // child; screenAndCamera has an image plus a small fixed-size
            // camera circle; screenOnly has an image alone). With only
            // mode-dependent children, SwiftUI re-measured the ZStack on
            // every mode switch and the reported width drifted by a few
            // points, producing the small horizontal jitter. A permanent
            // `Color.clear` child pinned to the proposed size keeps the
            // ZStack's reported width locked across every mode.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Background layer — screen snapshot or placeholder.
            if coordinator.mode != .cameraOnly {
                if let img = coordinator.screenPreview.image {
                    Image(decorative: img, scale: 1.0, orientation: .up)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .clipped()
                } else {
                    Color.black.opacity(0.4)
                    ProgressView()
                        .controlSize(.small)
                }
            }

            // Camera layer — full-frame or PiP circle.
            if coordinator.mode == .cameraOnly {
                if coordinator.cameraPreview.isActive {
                    CameraPreviewView(
                        manager: coordinator.cameraPreview,
                        adjustmentsState: coordinator.cameraAdjustmentsState
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                } else {
                    Color.black.opacity(0.4)
                }
            } else if coordinator.mode == .screenAndCamera,
                      coordinator.cameraPreview.isActive
            {
                CameraPreviewView(
                    manager: coordinator.cameraPreview,
                    adjustmentsState: coordinator.cameraAdjustmentsState
                )
                .frame(width: 54, height: 54)
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .stroke(.white.opacity(0.7), lineWidth: 1.5)
                )
                .padding(8)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 160, maxHeight: 160)
        .background(Color.black.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Camera Adjustments

    @ViewBuilder
    private var cameraAdjustmentsSection: some View {
        let tempBinding = Binding<Double>(
            get: { Double(coordinator.cameraAdjustments.temperature) },
            set: { coordinator.cameraAdjustments.temperature = CGFloat($0) }
        )
        let brightnessBinding = Binding<Double>(
            get: { Double(coordinator.cameraAdjustments.brightness) },
            set: { coordinator.cameraAdjustments.brightness = CGFloat($0) }
        )

        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Camera")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Spacer()
                if !coordinator.cameraAdjustments.isDefault {
                    Button("Reset") {
                        coordinator.resetCameraAdjustments()
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                }
            }

            HStack(spacing: 8) {
                Image(systemName: "thermometer.sun")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                Slider(value: tempBinding, in: 2500 ... 10000)
                Text("\(Int(coordinator.cameraAdjustments.temperature))K")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 52, alignment: .trailing)
            }

            HStack(spacing: 8) {
                Image(systemName: "sun.max")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                Slider(value: brightnessBinding, in: -2 ... 2)
                Text(String(format: "%+.1f EV", coordinator.cameraAdjustments.brightness))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 52, alignment: .trailing)
            }
        }
    }

    // MARK: - Quality Picker

    @ViewBuilder
    private var qualityPicker: some View {
        // SwiftUI's segmented Picker has no per-option disabled state, so
        // 1440p is simply omitted when the current source can't feed it. The
        // downgrade hooks below catch the case where the user had 1440p
        // selected and the source becomes unavailable.
        let presets = OutputPreset.all.filter {
            $0 != .p1440 || coordinator.is1440pAvailable
        }
        HStack(spacing: 8) {
            Picker("Quality", selection: $coordinator.outputPreset) {
                ForEach(presets) { preset in
                    Text(preset.label)
                        .tag(preset)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            fpsPicker
        }
        // 1440p availability depends on display and camera (not mode — see
        // is1440pAvailable). Re-check whenever either changes.
        .onChange(of: coordinator.selectedDisplay?.displayID) { _, _ in
            downgradeIf1440pUnavailable()
            downgradeIf60fpsUnavailable()
        }
        .onChange(of: coordinator.selectedCamera?.uniqueID) { _, _ in
            downgradeIf1440pUnavailable()
            downgradeIf60fpsUnavailable()
        }
        // Switching to 720p forces 30fps (incoherent intent — issue #20).
        .onChange(of: coordinator.outputPreset) { _, newPreset in
            if newPreset == .p720, coordinator.frameRate == .sixtyFPS {
                coordinator.frameRate = .thirtyFPS
            }
            downgradeIf60fpsUnavailable()
        }
    }

    // MARK: - FPS Picker

    @ViewBuilder
    private var fpsPicker: some View {
        let available = coordinator.is60fpsAvailable
        Picker("FPS", selection: $coordinator.frameRate) {
            Text(FrameRate.thirtyFPS.label).tag(FrameRate.thirtyFPS)
            Text(FrameRate.sixtyFPS.label).tag(FrameRate.sixtyFPS)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 100)
        .disabled(!available && coordinator.frameRate == .thirtyFPS)
        .opacity(available || coordinator.frameRate == .sixtyFPS ? 1.0 : 0.5)
    }

    /// If the user had 1440p selected and the active source can no longer
    /// feed it (e.g. they switched from a 1440p+ display to 1080p, or to
    /// cameraOnly with a 720p webcam), fall back to 1080p silently.
    private func downgradeIf1440pUnavailable() {
        if coordinator.outputPreset == .p1440, !coordinator.is1440pAvailable {
            coordinator.outputPreset = .p1080
        }
    }

    /// If the user had 60fps selected and no source can deliver it any more
    /// (or resolution changed to 720p), fall back to 30fps silently.
    private func downgradeIf60fpsUnavailable() {
        if coordinator.frameRate == .sixtyFPS, !coordinator.is60fpsAvailable {
            coordinator.frameRate = .thirtyFPS
        }
    }

    // MARK: - API Key Banner

    private var apiKeyMissingBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "key.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text("No API key configured")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text("Add a server-issued token in Settings before recording.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                SettingsLink {
                    Text("Open Settings")
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

    // MARK: - Server Banner

    private var serverUnavailableBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Server unreachable")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text("Server is not reachable at \(AppEnvironment.serverURL). Check Settings.")
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
