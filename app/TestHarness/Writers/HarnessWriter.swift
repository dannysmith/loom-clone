import AVFoundation
import CoreMedia
import Foundation

// MARK: - HarnessWriter

//
// Common surface area for all writer types inside the harness. Each
// concrete writer is a minimal analogue of the main-app WriterActor /
// RawStreamWriter — enough to exercise AVAssetWriter + VideoToolbox
// with realistic inputs, but not the full production abstractions.
//
// Writers are classes (not actors) so that HarnessRunner can drive
// them synchronously from a single metronome thread without async
// hops — that matches the "minimal ceremony" brief in task-0C and
// makes event-log ordering trivial.
//
// Thread safety: HarnessRunner is the only caller. It calls methods
// serially from its own dispatch queue. Nothing else touches these
// objects.

protocol HarnessWriter: AnyObject {
    /// Unique display name from the config. Used in event log lines
    /// and in the result summary.
    var name: String { get }

    /// "composited-hls", "raw-h264", "raw-prores", "raw-audio".
    var kind: String { get }

    /// URL the writer is writing to. nil for writers that don't write
    /// to disk (currently none — all of ours do).
    var outputURL: URL? { get }

    /// Called once after instantiation. May throw if AVAssetWriter
    /// refuses the configuration (bad codec, unsupported combination).
    func configure() throws

    /// Start the AVAssetWriter session. Must be called before any
    /// append*() call.
    func startWriting()

    /// Submit a video frame. No-op for audio writers.
    func appendVideo(_ sample: CMSampleBuffer)

    /// Submit an audio sample buffer. No-op for video writers.
    func appendAudio(_ sample: CMSampleBuffer)

    /// Stop the writer and wait for finishWriting to complete. Called
    /// once at the end of the run (and again by the watchdog if it
    /// fires, defensively).
    func finish() async

    /// Post-run status — populated after finish() returns.
    var finalStatus: AVAssetWriter.Status { get }
    var finalError: Error? { get }
    var bytesOnDisk: Int64? { get }

    /// HLS-only: segment durations observed during the run. Empty for
    /// other writer types.
    var segmentDurations: [Double] { get }
}

// MARK: - Helpers

extension HarnessWriter {
    /// True if finish() has been called at least once. Concrete writers
    /// maintain their own `didFinish` flag; this is a fallback for
    /// callers who only care that "the writer has been shut down".
    func hasFinished() -> Bool {
        finalStatus == .completed || finalStatus == .failed || finalStatus == .cancelled
    }
}
