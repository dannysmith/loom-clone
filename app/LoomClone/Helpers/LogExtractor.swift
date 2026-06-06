import Foundation
import OSLog

/// Post-stop extraction of the unified-log slice for a single recording.
///
/// Why this exists: bad recordings (AV desync, raw-writer death) almost always
/// coincide with a flood of Apple CoreMediaIO synchronizer errors (`-12743`)
/// that originate *outside* our process — in the camera CMIO daemons — and so
/// never appear in our own `is.danny.LoomClone` logs. To debug them after the
/// fact we need that Apple-subsystem noise captured alongside our own logs,
/// scoped to the recording's time window. See issue #44 / #30.
///
/// Two design constraints drive the shape:
///
/// 1. **Never log to disk on the recording hot path.** Issue #3 proved that
///    high-volume logging *causes* the very frame-drops we're chasing (I/O
///    back-pressure on the capture queues). So this runs strictly *after* a
///    recording stops, reading the OS's already-persisted store — zero cost
///    while recording.
/// 2. **No on-disk script, all in the binary.** A repo script wouldn't exist
///    inside the bundled `.app`. We read the store in-process via `OSLogStore`.
///    Because the app is *not* sandboxed and runs as an admin user,
///    `OSLogStore(scope: .system)` can read the whole store — including other
///    processes' / Apple-daemon entries — without the (ungettable) private
///    `com.apple.logging.local-store` entitlement. If `.system` isn't
///    permitted (e.g. ever run as a non-admin), we degrade to our own-process
///    logs and note it in the dump.
///
/// Caveat (documented, not worked around): `OSLogStore` reads the *persisted*
/// store — `error`/`fault`/`notice` are persisted; `debug` and most `info` are
/// memory-only and may already be gone by the time we read. The `-12743` lines
/// log at error level, so they should be present; capturing debug-level context
/// would require live `log stream` during recording, which reintroduces the #3
/// back-pressure we're avoiding.
enum LogExtractor {
    /// Filename written into the recording bundle, next to `recording.json`.
    static let outputFilename = "os-log.ndjson"

    /// Our own subsystem (see `Helpers/Logging.swift`).
    private static let ownSubsystem = "is.danny.LoomClone"

    /// Apple subsystem prefixes that carry the CMIO / CoreMedia / VideoToolbox
    /// errors we care about. These are the documented *candidates* — the exact
    /// strings that carry the `-12743` synchronizer flood are not yet confirmed
    /// against a live reproduction (task 1). This is the one knob to tune: widen
    /// it if a captured flood shows the lines under a subsystem not listed here,
    /// narrow it if the dump balloons with irrelevant noise.
    private static let appleSubsystemPrefixes = [
        "com.apple.cmio",
        "com.apple.coremedia",
        "com.apple.videotoolbox",
    ]

    /// Seconds of padding added either side of the recording window so we catch
    /// device bring-up / teardown errors that bracket the recording proper.
    private static let windowPadSeconds: TimeInterval = 5

    /// Hard cap on entries written. A `-12743` flood is tens of thousands of
    /// lines; this project has an OOM history, so we stream + cap rather than
    /// building one unbounded array/file. A `_truncated` marker records when the
    /// cap was hit.
    private static let maxEntries = 50000

    /// Read `<bundleDirectory>/recording.json` for the recording's time window,
    /// then write the matching unified-log slice to `<bundleDirectory>/os-log.ndjson`.
    ///
    /// Synchronous and potentially slow (it walks the OS log store) — call it
    /// from a detached, low-priority task, never inline on the stop flow.
    /// Failure-tolerant: logs and returns `false` rather than throwing.
    @discardableResult
    static func extract(bundleDirectory: URL) -> Bool {
        guard let window = windowFromRecordingJSON(in: bundleDirectory) else {
            Log.health.log("[logs] no usable recording.json window — skipping log extraction")
            return false
        }

        let output = bundleDirectory.appendingPathComponent(outputFilename)
        do {
            let summary = try writeLogSlice(window: window, to: output)
            Log.health.log(
                "[logs] wrote \(summary.written) entries (scope=\(summary.scope), truncated=\(summary.truncated)) to \(outputFilename)"
            )
            return true
        } catch {
            Log.health.error("[logs] extraction failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Window

    private struct Window {
        let start: Date
        let end: Date
    }

    /// Minimal projection of `recording.json` — just enough to bound the window.
    private struct RecordingJSONProbe: Decodable {
        struct Session: Decodable {
            let startedAt: String?
            let endedAt: String?
            let durationSeconds: Double?
        }

        let session: Session
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        // Match the writer side (RecordingTimelineBuilder): fractional seconds.
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func windowFromRecordingJSON(in bundleDirectory: URL) -> Window? {
        let jsonURL = bundleDirectory.appendingPathComponent("recording.json")
        guard let data = try? Data(contentsOf: jsonURL),
              let raw = parseWindow(from: data)
        else {
            return nil
        }
        // Pad either side so we catch device bring-up / teardown errors that
        // bracket the recording proper.
        return Window(
            start: raw.start.addingTimeInterval(-windowPadSeconds),
            end: raw.end.addingTimeInterval(windowPadSeconds)
        )
    }

    /// Pure parse of a `recording.json` payload into an unpadded `[start, end]`
    /// window. Split out (and `internal`) so the ISO-format coupling with
    /// `RecordingTimelineBuilder` — fractional seconds — is unit-testable
    /// without touching the OS log store. Returns nil when there's no usable
    /// start. End falls back: explicit `endedAt` → `start + durationSeconds` → now.
    static func parseWindow(from data: Data) -> (start: Date, end: Date)? {
        guard let probe = try? JSONDecoder().decode(RecordingJSONProbe.self, from: data),
              let startedAt = probe.session.startedAt,
              let start = isoFormatter.date(from: startedAt)
        else {
            return nil
        }
        let end: Date = probe.session.endedAt.flatMap(isoFormatter.date(from:))
            ?? probe.session.durationSeconds.map { start.addingTimeInterval($0) }
            ?? Date()
        return (start, end)
    }

    // MARK: - Store read

    private struct WriteSummary {
        let written: Int
        let scope: String
        let truncated: Bool
    }

    private static func writeLogSlice(window: Window, to output: URL) throws -> WriteSummary {
        // Prefer system scope (reaches the Apple CMIO daemons). Fall back to our
        // own process if that's not permitted (non-admin) so we at least capture
        // is.danny.LoomClone entries.
        let store: OSLogStore
        let scope: String
        if let systemStore = try? OSLogStore(scope: .system) {
            store = systemStore
            scope = "system"
        } else {
            store = try OSLogStore(scope: .currentProcessIdentifier)
            scope = "process"
        }

        let predicate = subsystemPredicate()
        let position = store.position(date: window.start)
        let entries = try store.getEntries(at: position, matching: predicate)

        FileManager.default.createFile(atPath: output.path, contents: nil)
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }

        let encoder = JSONEncoder()

        // Leading metadata line so the dump is self-describing.
        let meta = MetaLine(
            window: [isoFormatter.string(from: window.start), isoFormatter.string(from: window.end)],
            scope: scope,
            subsystems: [ownSubsystem] + appleSubsystemPrefixes,
            cmioCaptured: scope == "system"
        )
        try writeLine(meta, encoder: encoder, to: handle)

        var written = 0
        var truncated = false
        for entry in entries {
            // Entries are time-ordered ascending; once past the window we're done.
            if entry.date > window.end { break }
            guard let log = entry as? OSLogEntryLog else { continue }

            if written >= maxEntries {
                truncated = true
                break
            }

            let line = LogLine(
                t: isoFormatter.string(from: log.date),
                sub: log.subsystem,
                cat: log.category,
                level: levelName(log.level),
                process: log.process,
                pid: Int(log.processIdentifier),
                msg: log.composedMessage
            )
            try writeLine(line, encoder: encoder, to: handle)
            written += 1
        }

        if truncated {
            try writeLine(TruncationLine(truncatedAtEntries: maxEntries), encoder: encoder, to: handle)
        }

        return WriteSummary(written: written, scope: scope, truncated: truncated)
    }

    private static func subsystemPredicate() -> NSPredicate {
        var subpredicates = [NSPredicate(format: "subsystem == %@", ownSubsystem)]
        for prefix in appleSubsystemPrefixes {
            subpredicates.append(NSPredicate(format: "subsystem BEGINSWITH %@", prefix))
        }
        return NSCompoundPredicate(orPredicateWithSubpredicates: subpredicates)
    }

    private static func levelName(_ level: OSLogEntryLog.Level) -> String {
        switch level {
        case .undefined: "undefined"
        case .debug: "debug"
        case .info: "info"
        case .notice: "notice"
        case .error: "error"
        case .fault: "fault"
        @unknown default: "unknown"
        }
    }

    // MARK: - NDJSON lines

    private struct MetaLine: Encodable {
        let isMeta = true
        let window: [String]
        let scope: String
        let subsystems: [String]
        let cmioCaptured: Bool

        enum CodingKeys: String, CodingKey {
            case isMeta = "_meta"
            case window, scope, subsystems, cmioCaptured
        }
    }

    private struct LogLine: Encodable {
        let t: String
        let sub: String
        let cat: String
        let level: String
        let process: String
        let pid: Int
        let msg: String
    }

    private struct TruncationLine: Encodable {
        let isTruncated = true
        let truncatedAtEntries: Int

        enum CodingKeys: String, CodingKey {
            case isTruncated = "_truncated"
            case truncatedAtEntries
        }
    }

    private static func writeLine(_ value: some Encodable, encoder: JSONEncoder, to handle: FileHandle) throws {
        var data = try encoder.encode(value)
        data.append(0x0A) // newline
        handle.write(data)
    }
}
