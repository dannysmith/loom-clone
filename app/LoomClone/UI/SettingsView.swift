import SwiftUI

/// Settings window content. Manages server URL and API key configuration.
/// Generate a key on the server with `bun run keys:create <name>` and paste it here.
struct SettingsView: View {
    @State private var serverURL: String = AppEnvironment.serverURL
    @State private var keyText: String = ""
    @State private var status: SaveStatus = .idle

    private enum SaveStatus: Equatable {
        case idle
        case saved
        case cleared
        case urlSaved
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
                    if status == .urlSaved {
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                    }
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
        }
        .formStyle(.grouped)
        .padding()
        .frame(width: 520, height: 340)
    }

    private var trimmedKey: String {
        keyText.trimmingCharacters(in: .whitespacesAndNewlines)
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
        let url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        AppEnvironment.serverURL = url
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
