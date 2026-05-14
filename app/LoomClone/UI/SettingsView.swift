import AppKit
import SwiftUI

/// Settings window — sidebar layout, System-Settings-style.
///
/// Built on `NavigationSplitView` (not `TabView` + `.sidebarAdaptable`)
/// because Settings needs an explicit fixed sidebar width and no collapse
/// toggle — both of which `.sidebarAdaptable` doesn't expose. Each pane is
/// its own subview so `@Observable` reads scope tightly and a single pane's
/// state change doesn't reflow the whole window. The shared
/// `SettingsWindowConfigurator` runs once on appear to activate the app,
/// key the window, and set collection behavior so the window follows the
/// user across spaces and floats over full-screen apps.
struct SettingsView: View {
    @State private var selection: Pane = .general
    var transcribeAgent: TranscribeAgent?

    private enum Pane: Hashable {
        case general
        case apiKey
        case transcription
        case recordings
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("General", systemImage: "gear")
                    .tag(Pane.general)
                Label("API Key", systemImage: "key.fill")
                    .tag(Pane.apiKey)
                Label("Transcription", systemImage: "waveform")
                    .tag(Pane.transcription)
                Label("Recordings", systemImage: "tray.full")
                    .tag(Pane.recordings)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 220)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            Group {
                switch selection {
                case .general:
                    GeneralSettingsTab()
                case .apiKey:
                    APIKeySettingsTab()
                case .transcription:
                    TranscriptionSettingsTab(transcribeAgent: transcribeAgent)
                case .recordings:
                    RecordingsSettingsTab()
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 820, minHeight: 500)
        .background(SettingsWindowConfigurator())
    }
}

// MARK: - General Tab

private struct GeneralSettingsTab: View {
    @State private var serverURL: String = AppEnvironment.serverURL
    @State private var status: Status = .idle

    private enum Status: Equatable {
        case idle
        case saved
        case cleared
        case invalid(String)
    }

    var body: some View {
        Form {
            Section {
                TextField("Server URL", text: $serverURL, prompt: Text("http://127.0.0.1:3000"))
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onChange(of: serverURL) { _, _ in
                        if status != .idle { status = .idle }
                    }
                    .onSubmit { save() }

                HStack(spacing: 8) {
                    // Save is always available — an empty field clears the
                    // saved override (reverts to the build-config default).
                    Button("Save") { save() }
                        .buttonStyle(.borderedProminent)
                    Spacer()
                    statusLabel
                }
            } footer: {
                if AppEnvironment.isDebug {
                    Text("Debug build — defaults to localhost:3000. Release builds require explicit configuration.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                LabeledContent("App data") {
                    Button("Show in Finder") {
                        let url = AppEnvironment.appSupportDirectory
                        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch status {
        case .saved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
        case .cleared:
            Label("Cleared — using default", systemImage: "arrow.uturn.backward")
                .foregroundStyle(.secondary)
                .font(.caption)
        case let .invalid(message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.caption)
                .lineLimit(2)
        case .idle:
            EmptyView()
        }
    }

    private func save() {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)

        // Empty trimmed value is an explicit "clear the override" — reverts
        // to AppEnvironment.defaultServerURL (the build-config default).
        if trimmed.isEmpty {
            AppEnvironment.serverURL = ""
            serverURL = ""
            status = .cleared
            return
        }

        // Strip trailing slash so APIClient can append paths without doubling
        // the separator.
        let normalised = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed

        guard let parsed = URL(string: normalised),
              let scheme = parsed.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              parsed.host != nil
        else {
            status = .invalid("Enter a full URL like https://v.danny.is")
            return
        }

        AppEnvironment.serverURL = normalised
        serverURL = normalised
        status = .saved
    }
}

// MARK: - API Key Tab

private struct APIKeySettingsTab: View {
    @State private var keyText: String = ""
    @State private var status: Status = .idle
    @State private var apiKeyStatus = APIKeyStatus.shared

    private enum Status: Equatable {
        case idle
        case saved
        case cleared
        case error(String)
    }

    var body: some View {
        Form {
            Section {
                SecureField("Paste token", text: $keyText, prompt: Text("lck_…"))
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onChange(of: keyText) { _, _ in
                        if status != .idle { status = .idle }
                    }

                HStack(spacing: 8) {
                    Button("Save") { save() }
                        .buttonStyle(.borderedProminent)
                        .disabled(trimmedKey.isEmpty)

                    Button("Clear stored key", role: .destructive) { clear() }
                        .disabled(!apiKeyStatus.hasKey)

                    Spacer()
                    statusLabel
                }
            } footer: {
                Text(
                    "Generate a token on the server with `bun run keys:create <name>`. " +
                        "The token is shown once; paste it here. " +
                        "It is stored in the system Keychain."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Section {
                LabeledContent("Key stored") {
                    if apiKeyStatus.hasKey {
                        Text("Yes").foregroundStyle(.secondary)
                    } else {
                        Text("No").foregroundStyle(.orange)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private var trimmedKey: String {
        keyText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch status {
        case .saved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
        case .cleared:
            Label("Cleared", systemImage: "trash")
                .foregroundStyle(.secondary)
                .font(.caption)
        case let .error(message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.caption)
                .lineLimit(2)
        case .idle:
            EmptyView()
        }
    }

    private func save() {
        let token = trimmedKey
        guard !token.isEmpty else { return }
        do {
            try APIKeyStore.shared.write(token)
            APIKeyStatus.shared.refresh()
            keyText = ""
            status = .saved
        } catch {
            status = .error("Save failed: \(error)")
        }
    }

    private func clear() {
        do {
            try APIKeyStore.shared.delete()
            APIKeyStatus.shared.refresh()
            status = .cleared
        } catch {
            status = .error("Clear failed: \(error)")
        }
    }
}

// MARK: - Transcription Tab

private struct TranscriptionSettingsTab: View {
    let transcribeAgent: TranscribeAgent?
    private var modelStatus: TranscriptionModelStatus {
        .shared
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    switch modelStatus.state {
                    case .notDownloaded:
                        Label("Not downloaded", systemImage: "arrow.down.circle")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Download") {
                            guard let agent = transcribeAgent else { return }
                            Task { await agent.downloadModel() }
                        }
                        .buttonStyle(.borderedProminent)

                    case .downloading:
                        Label("Downloading…", systemImage: "arrow.down.circle.dotted")
                            .foregroundStyle(.secondary)
                        Spacer()
                        ProgressView()
                            .controlSize(.small)

                    case .ready:
                        Label("Ready", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Spacer()
                        Button("Remove", role: .destructive) {
                            modelStatus.deleteModel()
                        }

                    case let .failed(message):
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                            .lineLimit(2)
                        Spacer()
                        Button("Retry") {
                            guard let agent = transcribeAgent else { return }
                            Task { await agent.downloadModel() }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            } footer: {
                Text(
                    "Downloads the Whisper large-v3-turbo model (~626 MB). Recordings are transcribed automatically after this model is installed."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Window Configurator

/// Runs once when the Settings window appears: activates the app, makes the
/// window key, and sets collection behavior so the window follows the user
/// across spaces and floats over full-screen apps.
///
/// Required because the app is `LSUIElement` (menubar accessory). Without
/// this, the Settings window opens but the app doesn't become active —
/// `.borderedProminent` buttons render as faded greys until the user clicks
/// inside the window. The `.moveToActiveSpace` + `.fullScreenAuxiliary`
/// pair fixes the "Settings opens on the wrong space when I'm in a
/// full-screen app" papercut.
private struct SettingsWindowConfigurator: NSViewRepresentable {
    func makeNSView(context _: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.collectionBehavior.formUnion([.moveToActiveSpace, .fullScreenAuxiliary])
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
        }
        return view
    }

    func updateNSView(_: NSView, context _: Context) {}
}
