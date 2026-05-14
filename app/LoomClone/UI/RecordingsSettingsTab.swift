import AppKit
import SwiftUI

/// Recordings management pane — Finder-style sortable table of local
/// recordings with batch delete actions. All data is sourced from
/// `recording.json` plus sidecar files; never hits the server.
struct RecordingsSettingsTab: View {
    @State private var store = RecordingsStore()
    @State private var selection: Set<RecordingEntry.ID> = []
    @State private var sortOrder: [KeyPathComparator<RecordingEntry>] = [
        KeyPathComparator(\.startedAt, order: .reverse),
    ]
    @State private var pendingAction: DeleteAction?

    private enum DeleteAction: Identifiable {
        case rawStreams(Set<RecordingEntry.ID>)
        case hls(Set<RecordingEntry.ID>)
        case all(Set<RecordingEntry.ID>)

        var id: String {
            switch self {
            case let .rawStreams(ids): "raw-\(ids.hashValue)"
            case let .hls(ids): "hls-\(ids.hashValue)"
            case let .all(ids): "all-\(ids.hashValue)"
            }
        }

        var ids: Set<RecordingEntry.ID> {
            switch self {
            case let .rawStreams(ids), let .hls(ids), let .all(ids): ids
            }
        }
    }

    private var sortedEntries: [RecordingEntry] {
        store.entries.sorted(using: sortOrder)
    }

    var body: some View {
        VStack(spacing: 0) {
            actionBar
            Divider()
            recordingsTable
            Divider()
            footer
        }
        .task { await store.refresh() }
        .confirmationDialog(
            confirmTitle,
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingAction
        ) { action in
            Button("Delete", role: .destructive) {
                Task { await perform(action) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { action in
            Text(confirmMessage(for: action))
        }
    }

    // MARK: - Action bar

    private var actionBar: some View {
        HStack(spacing: 8) {
            Button {
                pendingAction = .rawStreams(targetIDs(requireRaw: true))
            } label: {
                Label("Delete Raw Masters", systemImage: "film")
            }
            .disabled(targetIDs(requireRaw: true).isEmpty)

            Button {
                pendingAction = .hls(targetIDs(requireUploadedHLS: true))
            } label: {
                Label("Delete HLS Segments", systemImage: "square.stack.3d.up")
            }
            .disabled(targetIDs(requireUploadedHLS: true).isEmpty)

            Button(role: .destructive) {
                pendingAction = .all(targetIDs(any: true))
            } label: {
                Label("Delete Recording", systemImage: "trash")
            }
            .disabled(targetIDs(any: true).isEmpty)

            Spacer()

            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Reload from disk")
            .disabled(store.isLoading)
        }
        .padding(8)
    }

    // MARK: - Table

    private var recordingsTable: some View {
        Table(sortedEntries, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("") { entry in
                StatusBadge(entry: entry)
            }
            .width(min: 56, ideal: 64, max: 80)

            TableColumn("Date", value: \.startedAt) { entry in
                Text(formatRecordingDate(entry.startedAt))
                    .monospacedDigit()
            }
            .width(min: 130, ideal: 150)

            TableColumn("Initial Slug", value: \.slug) { entry in
                Text(entry.slug)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(entry.id)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Duration", value: \.durationSortKey) { entry in
                Text(formatDuration(entry.durationSeconds))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .width(min: 70, ideal: 80, max: 100)

            TableColumn("Total Size", value: \.totalBytes) { entry in
                Text(formatBytes(entry.totalBytes))
                    .monospacedDigit()
            }
            .width(min: 90, ideal: 100, max: 130)

            TableColumn("Raw Masters Size", value: \.rawBytes) { entry in
                if entry.hasRawStreams {
                    Text(formatBytes(entry.rawBytes))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                } else {
                    Text("—")
                        .foregroundStyle(.tertiary)
                }
            }
            .width(min: 130, ideal: 140, max: 170)
        }
        .contextMenu(forSelectionType: RecordingEntry.ID.self) { ids in
            contextMenu(for: ids)
        }
    }

    // MARK: - Context menu

    @ViewBuilder
    private func contextMenu(for ids: Set<RecordingEntry.ID>) -> some View {
        if ids.isEmpty {
            EmptyView()
        } else {
            let entries = sortedEntries.filter { ids.contains($0.id) }

            if entries.count == 1, let entry = entries.first {
                Button("Open URL") {
                    openInBrowser("\(AppEnvironment.serverURL)/\(entry.slug)")
                }
                Button("Open in Admin") {
                    openInBrowser("\(AppEnvironment.serverURL)/admin/videos/\(entry.id)")
                }
                Button("Open in Finder") {
                    NSWorkspace.shared.open(entry.directory)
                }
                Button("Reveal recording.json") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [entry.directory.appendingPathComponent("recording.json")]
                    )
                }
                Divider()
                Button("Copy UUID") { copy(entry.id) }
                Button("Copy Slug") { copy(entry.slug) }
                Divider()
            }

            Button("Delete Raw Masters") {
                pendingAction = .rawStreams(ids.filter { id in
                    entries.first(where: { $0.id == id })?.hasRawStreams == true
                })
            }
            .disabled(entries.allSatisfy { !$0.hasRawStreams })

            Button("Delete HLS Segments") {
                pendingAction = .hls(ids.filter { id in
                    let e = entries.first(where: { $0.id == id })
                    return e?.hasHLS == true && e?.allUploaded == true
                })
            }
            .disabled(entries.allSatisfy { !($0.hasHLS && $0.allUploaded) })

            Button("Delete Entire Recording…", role: .destructive) {
                pendingAction = .all(ids)
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        let totalBytes = store.entries.reduce(Int64(0)) { $0 + $1.totalBytes }
        let rawTotal = store.entries.reduce(Int64(0)) { $0 + $1.rawBytes }
        let rawCount = store.entries.count(where: \.hasRawStreams)

        return HStack {
            if store.isLoading {
                ProgressView().controlSize(.small)
                Text("Loading…")
                    .foregroundStyle(.secondary)
            } else {
                Text("\(store.entries.count) recordings · \(formatBytes(totalBytes)) total")
                    .foregroundStyle(.secondary)
                if rawCount > 0 {
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text("\(rawCount) with raw masters (\(formatBytes(rawTotal)))")
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: - Helpers

    /// Filter the current selection to entries that qualify for an action.
    /// Returns empty when nothing is selected — the action-bar buttons stay
    /// disabled until the user picks specific rows.
    private func targetIDs(
        requireRaw: Bool = false,
        requireUploadedHLS: Bool = false,
        any: Bool = false
    ) -> Set<RecordingEntry.ID> {
        guard !selection.isEmpty else { return [] }
        return Set(store.entries.filter { entry in
            guard selection.contains(entry.id) else { return false }
            if requireRaw { return entry.hasRawStreams }
            if requireUploadedHLS { return entry.hasHLS && entry.allUploaded }
            return any
        }.map(\.id))
    }

    private var confirmTitle: String {
        switch pendingAction {
        case .rawStreams: "Delete raw masters?"
        case .hls: "Delete HLS segments?"
        case .all: "Delete recording?"
        case .none: ""
        }
    }

    private func confirmMessage(for action: DeleteAction) -> String {
        let entries = store.entries.filter { action.ids.contains($0.id) }
        let count = entries.count
        let noun = count == 1 ? "recording" : "recordings"
        switch action {
        case .rawStreams:
            let bytes = entries.reduce(Int64(0)) { $0 + $1.rawBytes }
            return "Remove the raw screen / camera / audio masters from \(count) \(noun) "
                + "(\(formatBytes(bytes))). The composited HLS segments are not affected."
        case .hls:
            let bytes = entries.reduce(Int64(0)) { acc, entry in
                acc + entry.totalBytes - entry.rawBytes
            }
            return "Remove the HLS init + segment files from \(count) \(noun) "
                + "(\(formatBytes(bytes))). Only enabled when fully uploaded — "
                + "viewers will still get them from the server."
        case .all:
            let bytes = entries.reduce(Int64(0)) { $0 + $1.totalBytes }
            let unuploaded = entries.contains { !$0.allUploaded && $0.status != .orphaned }
            let warning = unuploaded
                ? " Some recordings are not fully uploaded — deleting them is permanent."
                : ""
            return "Delete \(count) \(noun) completely (\(formatBytes(bytes))).\(warning)"
        }
    }

    private func perform(_ action: DeleteAction) async {
        switch action {
        case let .rawStreams(ids): await store.deleteRawStreams(ids: ids)
        case let .hls(ids): await store.deleteHLS(ids: ids)
        case let .all(ids):
            await store.deleteAll(ids: ids)
            selection.subtract(ids)
        }
    }

    private func copy(_ string: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(string, forType: .string)
    }

    private func openInBrowser(_ string: String) {
        guard let url = URL(string: string) else { return }
        NSWorkspace.shared.open(url)
    }
}

// MARK: - Status badge

private struct StatusBadge: View {
    let entry: RecordingEntry

    var body: some View {
        HStack(spacing: 4) {
            statusIcon
            if entry.isTranscribed {
                Image(systemName: "waveform")
                    .foregroundStyle(.blue)
                    .help("Transcribed")
            }
        }
        .font(.caption)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch entry.status {
        case .uploaded:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .help("Uploaded")
        case .needsUpload:
            Image(systemName: "arrow.up.circle")
                .foregroundStyle(.orange)
                .help("Awaiting upload")
        case .errored:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .help("Upload error")
        case .orphaned:
            Image(systemName: "questionmark.circle")
                .foregroundStyle(.secondary)
                .help("Orphaned — server returned 404")
        }
    }
}

// MARK: - Formatting

private func formatBytes(_ bytes: Int64) -> String {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    formatter.allowedUnits = [.useKB, .useMB, .useGB, .useTB]
    return formatter.string(fromByteCount: bytes)
}

/// Year is omitted when the recording is from the current year — clutters
/// rows where everything is recent. The space-separated format avoids the
/// locale-inserted "at" that `Date.FormatStyle` produces in en_US.
private let recordingDateFormatterCurrentYear: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "d MMM HH:mm"
    return f
}()

private let recordingDateFormatterWithYear: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "d MMM yyyy HH:mm"
    return f
}()

private func formatRecordingDate(_ date: Date) -> String {
    let isCurrentYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
    let formatter = isCurrentYear ? recordingDateFormatterCurrentYear : recordingDateFormatterWithYear
    return formatter.string(from: date)
}

private func formatDuration(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite, seconds >= 0 else { return "—" }
    let total = Int(seconds.rounded())
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let secs = total % 60
    if hours > 0 {
        return String(format: "%d:%02d:%02d", hours, minutes, secs)
    }
    return String(format: "%d:%02d", minutes, secs)
}

// MARK: - Sort keys

private extension RecordingEntry {
    /// `Double.greatestFiniteMagnitude` for nil so unknown durations sort
    /// to the end on ascending order — same behavior as the macOS Finder
    /// for missing values.
    var durationSortKey: Double {
        durationSeconds ?? .greatestFiniteMagnitude
    }
}
