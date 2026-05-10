import SwiftUI

/// Settings window content. Manages server URL, API key, and transcription model.
struct SettingsView: View {
    @State private var serverURL: String = AppEnvironment.serverURL
    @State private var keyText: String = ""
    @State private var status: SaveStatus = .idle
    var transcribeAgent: TranscribeAgent?

    private enum SaveStatus: Equatable {
        case idle
        case saved
        case cleared
        case urlSaved
        case urlInvalid(String)
        case error(String)
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
                    .onSubmit { saveURL() }

                HStack(spacing: 8) {
                    Button("Save") { saveURL() }
                        .buttonStyle(.borderedProminent)
                        .disabled(serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Spacer()
                    urlStatusLabel
                }
            } header: {
                Text("Server")
            } footer: {
                if AppEnvironment.isDebug {
                    Text("Debug build — defaults to localhost:3000. Release builds require explicit configuration.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                SecureField("Paste token", text: $keyText, prompt: Text("lck_…"))
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onChange(of: keyText) { _, _ in
                        if status != .idle { status = .idle }
                    }

                HStack(spacing: 8) {
                    Button("Save") { saveKey() }
                        .buttonStyle(.borderedProminent)
                        .disabled(trimmedKey.isEmpty)

                    Button("Clear stored key", role: .destructive) { clearKey() }
                        .disabled(!APIKeyStatus.shared.hasKey)

                    Spacer()
                    keyStatusLabel
                }
            } header: {
                Text("API Key")
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
                    if APIKeyStatus.shared.hasKey {
                        Text("Yes").foregroundStyle(.secondary)
                    } else {
                        Text("No").foregroundStyle(.orange)
                    }
                }
            }

            TranscriptionModelSection(transcribeAgent: transcribeAgent)
        }
        .formStyle(.grouped)
        .padding()
        .frame(width: 520, height: 420)
    }

    private var trimmedKey: String {
        keyText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private var urlStatusLabel: some View {
        switch status {
        case .urlSaved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
        case let .urlInvalid(message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.caption)
                .lineLimit(2)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var keyStatusLabel: some View {
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
        default:
            EmptyView()
        }
    }

    private func saveURL() {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Strip trailing slash so APIClient can append paths without doubling
        // the separator.
        let normalised = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed

        // Validate: must parse as a URL with an http or https scheme. Reject
        // anything else here so APIClient never has to fall back on its
        // .invalidBaseURL throw at runtime.
        guard let parsed = URL(string: normalised),
              let scheme = parsed.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              parsed.host != nil
        else {
            status = .urlInvalid("Enter a full URL like https://v.danny.is")
            return
        }

        AppEnvironment.serverURL = normalised
        serverURL = normalised
        status = .urlSaved
    }

    private func saveKey() {
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

    private func clearKey() {
        do {
            try APIKeyStore.shared.delete()
            APIKeyStatus.shared.refresh()
            status = .cleared
        } catch {
            status = .error("Clear failed: \(error)")
        }
    }
}

/// Leaf subview for the transcription model section. Reads from
/// TranscriptionModelStatus in its own observation scope so changes
/// don't trigger a full SettingsView re-render.
private struct TranscriptionModelSection: View {
    let transcribeAgent: TranscribeAgent?
    private var modelStatus: TranscriptionModelStatus {
        .shared
    }

    var body: some View {
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
        } header: {
            Text("Transcription")
        } footer: {
            Text(
                "Downloads the Whisper large-v3-turbo model (~626 MB). Recordings are transcribed automatically after this model is installed."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}
