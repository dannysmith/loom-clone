import Foundation

/// Conventions for the local recordings directory, shared by the two
/// background agents that walk it (`HealAgent`, `TranscribeAgent`).
///
/// Both scan the same directories on launch and both mark the same sidecars,
/// so the window and the sidecar semantics belong in one place — a heal that
/// disagreed with a transcription about which recordings are still live would
/// be very hard to spot.
enum LocalRecordings {
    /// Recordings older than this are not scanned at startup. In practice a
    /// recording that didn't heal or transcribe on the day it was made is
    /// unlikely to ever complete cleanly, and re-attempting the whole history
    /// on every launch costs more than it recovers.
    static let startupWindow: TimeInterval = 3 * 24 * 60 * 60

    /// Marker files written next to a session's media. Their presence is the
    /// only state the agents keep between launches.
    enum Sidecar: String {
        /// The server 404'd for this video — it was deleted upstream, so stop
        /// retrying it forever.
        case orphaned = ".orphaned"
        /// Transcription finished and the artifacts were uploaded.
        case transcribed = ".transcribed"
    }

    static func url(of sidecar: Sidecar, in localDir: URL) -> URL {
        localDir.appendingPathComponent(sidecar.rawValue)
    }

    static func exists(_ sidecar: Sidecar, in localDir: URL) -> Bool {
        FileManager.default.fileExists(atPath: url(of: sidecar, in: localDir).path)
    }

    /// Write a sidecar stamped with the current time. Best-effort: a failure
    /// here costs a redundant retry next launch, not data.
    static func write(_ sidecar: Sidecar, in localDir: URL, note: String) {
        let now = ISO8601DateFormatter().string(from: Date())
        try? Data("\(note) at \(now)\n".utf8).write(to: url(of: sidecar, in: localDir))
    }

    /// Record that the server no longer has this video. `log` is the calling
    /// agent's category so the line lands where that agent's other output does.
    static func markOrphaned(localDir: URL, log: LoomLogger) {
        write(.orphaned, in: localDir, note: "orphaned: server returned 404")
        log.log("marked orphaned: \(localDir.lastPathComponent)")
    }

    /// True when `path`'s modification date is older than the startup window.
    /// Both agents use a file inside the session directory (`recording.json`,
    /// `audio.m4a`) as a proxy for when the session ended.
    static func isOutsideStartupWindow(_ path: URL, now: Date = Date()) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path.path),
              let modDate = attrs[.modificationDate] as? Date
        else { return false }
        return modDate < now.addingTimeInterval(-startupWindow)
    }
}
