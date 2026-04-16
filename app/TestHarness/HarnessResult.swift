import Foundation

// MARK: - HarnessResult

//
// What the harness writes to result.json after a run completes (or
// fails). The runner script reads this to decide pass/fail and whether
// to keep running subsequent configs.

struct HarnessResult: Codable {
    /// "pass", "degraded", "fail-recorded", "fail-killed", "dry-run".
    /// Kept as a string rather than enum so older runs stay decodable
    /// if we add new outcome classes later.
    let outcome: String

    /// Human-readable summary line. Shown in the runner script output.
    let summary: String

    /// ISO-8601 wall-clock start / end times.
    let startedAt: String
    let finishedAt: String

    /// Actual wall-clock duration in seconds.
    let elapsedSeconds: Double

    /// Per-writer final state (one entry per writer in config.writers).
    let writers: [WriterResult]

    /// Soft-fail conditions tripped during the run, each as a short
    /// human-readable string. Empty array means no issues.
    let issues: [String]

    /// Counts pulled from the event log for the summary line.
    let frameStats: FrameStats

    /// Full config echoed back for archival. Same content as config.json
    /// in the run dir, duplicated here to make results self-contained.
    let config: HarnessConfig
}

struct WriterResult: Codable {
    let name: String
    let kind: String
    /// AVAssetWriter.status rawValue ("unknown", "writing", "completed",
    /// "failed", "cancelled"), or "not-started" if the writer never
    /// reached startWriting().
    let status: String
    let errorDescription: String?
    let outputPath: String?
    let outputSizeBytes: Int64?
    /// Segment durations for HLS writers, empty otherwise.
    let segmentDurations: [Double]
}

struct FrameStats: Codable {
    let framesSubmitted: Int
    let framesDropped: Int
    let firstFrameAt: Double?
    let lastFrameAt: Double?
}

extension HarnessResult {
    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
