import Foundation

/// One row in the Recordings settings pane. Built by walking the on-disk
/// recording directory; never reaches the server. Identified by its
/// videoId (UUID, also the directory name).
struct RecordingEntry: Identifiable, Hashable {
    let id: String
    let slug: String
    let directory: URL
    let startedAt: Date
    let durationSeconds: Double?
    let totalBytes: Int64
    let rawBytes: Int64
    let status: Status
    let isTranscribed: Bool
    let hasRawStreams: Bool
    let hasHLS: Bool
    let allUploaded: Bool

    enum Status: Int, Hashable, Comparable {
        case uploaded
        case needsUpload
        case errored
        case orphaned

        static func < (lhs: Status, rhs: Status) -> Bool {
            lhs.rawValue < rhs.rawValue
        }
    }
}

/// Drives the Recordings settings pane. Scans
/// `AppEnvironment.recordingsDirectory`, decodes each `recording.json`,
/// checks sidecars (`.orphaned` / `.transcribed`), and sums on-disk bytes
/// per recording. Also owns the delete operations.
@MainActor
@Observable
final class RecordingsStore {
    private(set) var entries: [RecordingEntry] = []
    private(set) var isLoading = false

    /// Scan the recordings directory off-main and republish on the main
    /// actor. Cheap enough to run on every appear — the directory walk is
    /// bounded by recording count, not by total bytes.
    func refresh() async {
        isLoading = true
        let root = AppEnvironment.recordingsDirectory
        let scanned = await Task.detached(priority: .userInitiated) {
            Self.scan(root: root)
        }.value
        entries = scanned
        isLoading = false
    }

    // MARK: - Delete operations

    /// Delete raw masters (`screen.mov`, `camera.mp4`, `audio.m4a`) from
    /// the given recordings. Always safe — these are backup copies.
    func deleteRawStreams(ids: Set<RecordingEntry.ID>) async {
        let dirs = directories(for: ids)
        await Task.detached(priority: .userInitiated) {
            for dir in dirs {
                for name in Self.rawStreamFilenames {
                    try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
                }
            }
        }.value
        await refresh()
    }

    /// Delete the HLS segments (`init.mp4`, `seg_*.m4s`) from the given
    /// recordings. Caller is responsible for gating on `allUploaded` —
    /// segments are the only copy of the composited video before upload.
    func deleteHLS(ids: Set<RecordingEntry.ID>) async {
        let dirs = directories(for: ids)
        await Task.detached(priority: .userInitiated) {
            let fm = FileManager.default
            for dir in dirs {
                try? fm.removeItem(at: dir.appendingPathComponent("init.mp4"))
                if let contents = try? fm.contentsOfDirectory(atPath: dir.path) {
                    for name in contents where name.hasPrefix("seg_") && name.hasSuffix(".m4s") {
                        try? fm.removeItem(at: dir.appendingPathComponent(name))
                    }
                }
            }
        }.value
        await refresh()
    }

    /// Delete the entire recording directory.
    func deleteAll(ids: Set<RecordingEntry.ID>) async {
        let dirs = directories(for: ids)
        await Task.detached(priority: .userInitiated) {
            for dir in dirs {
                try? FileManager.default.removeItem(at: dir)
            }
        }.value
        await refresh()
    }

    private func directories(for ids: Set<RecordingEntry.ID>) -> [URL] {
        entries.filter { ids.contains($0.id) }.map(\.directory)
    }

    // MARK: - Scan (off-main)

    nonisolated static let rawStreamFilenames = ["screen.mov", "camera.mp4", "audio.m4a"]

    nonisolated private static func scan(root: URL) -> [RecordingEntry] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return dirs.compactMap { dir -> RecordingEntry? in
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
                return nil
            }
            return entry(forDirectory: dir, fm: fm)
        }
    }

    nonisolated private static func entry(forDirectory dir: URL, fm: FileManager) -> RecordingEntry? {
        let recordingJSON = dir.appendingPathComponent("recording.json")
        guard let data = try? Data(contentsOf: recordingJSON),
              let meta = try? JSONDecoder.iso8601.decode(RecordingJSONFile.self, from: data)
        else {
            return nil
        }

        let isOrphaned = fm.fileExists(atPath: dir.appendingPathComponent(".orphaned").path)
        let isTranscribed = fm.fileExists(atPath: dir.appendingPathComponent(".transcribed").path)

        let segments = meta.segments ?? []
        let allUploaded = !segments.isEmpty && segments.allSatisfy(\.uploaded)
        let anyErrored = segments.contains { $0.uploadError != nil }

        let status: RecordingEntry.Status = if isOrphaned {
            .orphaned
        } else if anyErrored {
            .errored
        } else if allUploaded {
            .uploaded
        } else {
            .needsUpload
        }

        let totalBytes = directorySize(at: dir, fm: fm)
        let rawBytes = rawStreamFilenames.reduce(Int64(0)) { acc, name in
            acc + fileSize(at: dir.appendingPathComponent(name), fm: fm)
        }
        let hasRawStreams = rawBytes > 0
        let hasHLS = fm.fileExists(atPath: dir.appendingPathComponent("init.mp4").path)

        let startedAt = ISO8601DateFormatter.iso8601WithFractional.date(from: meta.session.startedAt)
            ?? ISO8601DateFormatter.iso8601Plain.date(from: meta.session.startedAt)
            ?? Date.distantPast

        return RecordingEntry(
            id: meta.session.id,
            slug: meta.session.slug,
            directory: dir,
            startedAt: startedAt,
            durationSeconds: meta.session.durationSeconds,
            totalBytes: totalBytes,
            rawBytes: rawBytes,
            status: status,
            isTranscribed: isTranscribed,
            hasRawStreams: hasRawStreams,
            hasHLS: hasHLS,
            allUploaded: allUploaded
        )
    }

    nonisolated private static func directorySize(at url: URL, fm: FileManager) -> Int64 {
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]
        ) else {
            return 0
        }
        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            let values = try? fileURL.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey])
            if values?.isRegularFile == true, let bytes = values?.totalFileAllocatedSize {
                total += Int64(bytes)
            }
        }
        return total
    }

    nonisolated private static func fileSize(at url: URL, fm: FileManager) -> Int64 {
        guard fm.fileExists(atPath: url.path),
              let values = try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey]),
              let bytes = values.totalFileAllocatedSize
        else {
            return 0
        }
        return Int64(bytes)
    }
}

// MARK: - Decoded recording.json shape

/// Read-side mirror of the subset of `RecordingTimeline` we need.
/// Kept separate because `RecordingTimeline` is `Encodable` only.
private struct RecordingJSONFile: Decodable {
    let session: Session
    let segments: [Segment]?

    struct Session: Decodable {
        let id: String
        let slug: String
        let startedAt: String
        let durationSeconds: Double?
    }

    struct Segment: Decodable {
        let uploaded: Bool
        let uploadError: String?
    }
}

private extension JSONDecoder {
    static let iso8601: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

private extension ISO8601DateFormatter {
    static let iso8601WithFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let iso8601Plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
