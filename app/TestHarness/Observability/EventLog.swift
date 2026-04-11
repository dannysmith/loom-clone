import Foundation

// MARK: - EventLog
//
// Timestamped JSONL of everything notable that happens during a run.
// One file per run at `<run-dir>/events.jsonl`. Each line is a single
// JSON object with a fixed shape so the file is easy to grep and jq.
//
// Events are written synchronously under a lock so ordering is strict
// and nothing is lost if the harness is killed mid-run. The cost is
// one small write per event — negligible at our event rates (~dozens
// per second in the worst case).
//
// All public methods are safe to call from any thread / actor /
// dispatch queue — this is deliberate because AVFoundation delegate
// callbacks land on arbitrary queues and we still want to log from
// them.

final class EventLog: @unchecked Sendable {

    private let url: URL
    private let handle: FileHandle
    private let lock = NSLock()
    private let startMonotonic: UInt64
    private let startDate: Date

    init(runDirectory: URL) throws {
        self.url = runDirectory.appendingPathComponent("events.jsonl")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try FileHandle(forWritingTo: url)
        self.startMonotonic = DispatchTime.now().uptimeNanoseconds
        self.startDate = Date()
    }

    /// Wall-clock seconds since the EventLog was created. Used as the
    /// canonical "t" field on every event.
    func elapsed() -> Double {
        let now = DispatchTime.now().uptimeNanoseconds
        return Double(now - startMonotonic) / 1_000_000_000.0
    }

    /// Log a structured event. `kind` is the event family (e.g.
    /// "writer.started", "frame.submitted", "gpu.error"). `fields` is
    /// an arbitrary bag of primitive values that get inlined into the
    /// event line.
    func log(_ kind: String, _ fields: [String: Any] = [:]) {
        var obj: [String: Any] = [
            "t": elapsed(),
            "kind": kind,
        ]
        for (k, v) in fields { obj[k] = v }

        guard let data = serialize(obj) else { return }
        lock.lock()
        handle.write(data)
        handle.write(Data([0x0A])) // newline
        lock.unlock()
    }

    /// Flush pending output and close the underlying file. Safe to call
    /// more than once.
    func close() {
        lock.lock()
        try? handle.synchronize()
        try? handle.close()
        lock.unlock()
    }

    /// JSONSerialization over a dictionary containing only JSON-friendly
    /// primitives. Keys that are non-serialisable are stringified.
    private func serialize(_ obj: [String: Any]) -> Data? {
        // JSONSerialization rejects non-JSON types (e.g. CMTime, errors)
        // so we coerce everything to string-or-primitive up front.
        var clean: [String: Any] = [:]
        for (k, v) in obj {
            clean[k] = jsonFriendly(v)
        }
        return try? JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys])
    }

    private func jsonFriendly(_ v: Any) -> Any {
        switch v {
        case let n as Int: return n
        case let n as Int64: return n
        case let n as Double: return n
        case let b as Bool: return b
        case let s as String: return s
        case let a as [Any]: return a.map(jsonFriendly)
        case let d as [String: Any]:
            var out: [String: Any] = [:]
            for (k, v) in d { out[k] = jsonFriendly(v) }
            return out
        default:
            return String(describing: v)
        }
    }
}
