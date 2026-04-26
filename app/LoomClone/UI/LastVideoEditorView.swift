import SwiftUI

/// Inline display/editor for the last recorded video. Shows metadata as
/// read-only text with an Edit button; tapping Edit swaps to editable fields
/// with Save/Cancel. On successful save, snaps back to display mode with
/// the updated values.
struct LastVideoEditorView: View {
    let videoId: String
    let initialURL: String
    let initialSlug: String
    let initialTitle: String?
    let initialVisibility: String

    // Canonical values — updated on successful save.
    @State private var currentTitle: String = ""
    @State private var currentSlug: String = ""
    @State private var currentVisibility: String = "unlisted"

    // Edit-mode draft values.
    @State private var draftTitle: String = ""
    @State private var draftSlug: String = ""
    @State private var draftVisibility: String = "unlisted"

    @State private var editing = false
    @State private var saving = false
    @State private var errorMessage: String?

    private static let visibilityOptions = ["public", "unlisted", "private"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if editing {
                editMode
            } else {
                displayMode
            }
        }
        .onAppear {
            currentTitle = initialTitle ?? ""
            currentSlug = initialSlug
            currentVisibility = initialVisibility
        }
    }

    // MARK: - Display Mode

    @ViewBuilder
    private var displayMode: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(currentTitle.isEmpty ? "Untitled" : currentTitle)
                .font(.caption.bold())
                .foregroundStyle(currentTitle.isEmpty ? .tertiary : .primary)
                .lineLimit(1)

            HStack(spacing: 4) {
                Text(currentSlug)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Text("·")
                    .foregroundStyle(.quaternary)

                Text(currentVisibility.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }

        HStack {
            Button("Open") {
                if let nsURL = URL(string: initialURL) {
                    NSWorkspace.shared.open(nsURL)
                }
            }
            .font(.caption)

            Button("Admin") {
                let adminURL = "\(AppEnvironment.serverURL)/admin/videos/\(videoId)"
                if let nsURL = URL(string: adminURL) {
                    NSWorkspace.shared.open(nsURL)
                }
            }
            .font(.caption)

            Spacer()

            Button("Edit") {
                enterEditMode()
            }
            .font(.caption)
        }
    }

    // MARK: - Edit Mode

    @ViewBuilder
    private var editMode: some View {
        LabeledContent("Title") {
            TextField("Untitled", text: $draftTitle)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
        }

        LabeledContent("Slug") {
            TextField("slug", text: $draftSlug)
                .textFieldStyle(.roundedBorder)
                .font(.caption.monospaced())
        }

        Picker("Visibility", selection: $draftVisibility) {
            ForEach(Self.visibilityOptions, id: \.self) { option in
                Text(option.capitalized).tag(option)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()

        if let errorMessage {
            Text(errorMessage)
                .font(.caption)
                .foregroundStyle(.red)
        }

        HStack {
            Button("Cancel") {
                editing = false
                errorMessage = nil
            }
            .font(.caption)

            Spacer()

            Button("Save") {
                Task { await save() }
            }
            .font(.caption)
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(saving || !hasChanges)
        }
    }

    // MARK: - Logic

    private var hasChanges: Bool {
        draftTitle != currentTitle
            || draftSlug != currentSlug
            || draftVisibility != currentVisibility
    }

    private func enterEditMode() {
        draftTitle = currentTitle
        draftSlug = currentSlug
        draftVisibility = currentVisibility
        errorMessage = nil
        editing = true
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }

        // Build the patch — only include fields that changed.
        var patch: [String: Any] = [:]
        if draftTitle != currentTitle {
            patch["title"] = draftTitle.isEmpty ? NSNull() : draftTitle
        }
        if draftSlug != currentSlug {
            patch["slug"] = draftSlug
        }
        if draftVisibility != currentVisibility {
            patch["visibility"] = draftVisibility
        }
        guard !patch.isEmpty else { return }

        do {
            let client = APIClient.shared
            var request = try client.authorizedRequest(path: "/api/videos/\(videoId)")
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: patch)
            let (data, http) = try await client.send(request)

            if http.statusCode == 200 {
                // Apply canonical state from the server response.
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let s = json["slug"] as? String { currentSlug = s }
                    if let t = json["title"] as? String {
                        currentTitle = t
                    } else if json["title"] is NSNull {
                        currentTitle = ""
                    }
                    if let v = json["visibility"] as? String { currentVisibility = v }
                }
                editing = false
            } else {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let message = json["error"] as? String
                {
                    errorMessage = message
                } else {
                    errorMessage = "Save failed (\(http.statusCode))"
                }
            }
        } catch APIClient.ClientError.missingAPIKey {
            errorMessage = "No API key configured"
        } catch APIClient.ClientError.unauthorized {
            errorMessage = "API key rejected"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
