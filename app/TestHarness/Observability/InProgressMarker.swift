import Foundation

// MARK: - InProgressMarker
//
// Last-known-good marker from the task-0C safety plan. Before a run
// starts, we write `test-runs/_in-progress.json` with the name + full
// config. On clean completion we delete it. If the Mac hangs and is
// hard-rebooted, the file persists — which is how the runner script
// detects "the previous run hung" on its next invocation.
//
// The runner script is responsible for checking this marker BEFORE
// invoking the harness. The harness itself just writes and deletes
// the file around the run.

enum InProgressMarker {

    static func url(inTestRunsRoot root: URL) -> URL {
        root.appendingPathComponent("_in-progress.json")
    }

    /// Write the marker. Called right before the harness does anything
    /// that could hang. If writing the marker itself fails, the run
    /// aborts — a missing marker is not an acceptable safety gap.
    static func write(config: HarnessConfig,
                      runDirectory: URL,
                      testRunsRoot: URL) throws {
        struct Marker: Codable {
            let name: String
            let runDirectory: String
            let startedAt: String
            let config: HarnessConfig
        }
        let marker = Marker(
            name: config.name,
            runDirectory: runDirectory.path,
            startedAt: ISO8601DateFormatter().string(from: Date()),
            config: config
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(marker)
        try FileManager.default.createDirectory(
            at: testRunsRoot,
            withIntermediateDirectories: true
        )
        try data.write(to: url(inTestRunsRoot: testRunsRoot), options: .atomic)
    }

    /// Clear the marker on successful (or "reached the end, even if
    /// degraded") completion. The runner's rule is that any file
    /// surviving a reboot means the previous run hung the machine.
    static func clear(testRunsRoot: URL) {
        try? FileManager.default.removeItem(at: url(inTestRunsRoot: testRunsRoot))
    }

    /// Check whether a previous run left a marker behind. Called by
    /// the runner script, not by the harness itself.
    static func exists(inTestRunsRoot root: URL) -> Bool {
        FileManager.default.fileExists(atPath: url(inTestRunsRoot: root).path)
    }
}
