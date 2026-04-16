import SwiftUI

/// Settings window content. Single responsibility today: hold the API key
/// the macOS app sends as `Authorization: Bearer <token>`. Generate a key
/// on the server with `bun run keys:create <name>` and paste it here.
struct SettingsView: View {
    @State private var keyText: String = ""
    @State private var status: SaveStatus = .idle

    private enum SaveStatus: Equatable {
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
                        .keyboardShortcut(.defaultAction)
                        .disabled(trimmedKey.isEmpty)

                    Button("Clear stored key", role: .destructive) { clear() }
                        .disabled(!APIKeyStatus.shared.hasKey)

                    Spacer()
                    statusLabel
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
                LabeledContent("Stored") {
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
        .frame(width: 520, height: 280)
    }

    private var trimmedKey: String {
        keyText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch status {
        case .idle:
            EmptyView()
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
