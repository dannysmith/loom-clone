import CoreMedia

/// Handles audio priming offset and pause/resume timestamp manipulation.
/// Used within WriterActor — not thread-safe on its own.
struct TimestampAdjuster {
    /// Canonical offset applied to all timestamps to handle AAC audio priming.
    /// The metronome in RecordingActor references this so video and audio PTS
    /// land on the same zero-point after the writer starts its session.
    static let defaultPrimingOffset = CMTime(seconds: 10, preferredTimescale: 600)

    /// Offset applied to all timestamps to handle AAC audio priming.
    /// All appended CMSampleBuffers have their PTS shifted by this amount.
    let primingOffset: CMTime

    /// Accumulated pause duration to subtract from timestamps.
    private(set) var pauseAccumulator: CMTime = .zero

    /// Timestamp when the last pause started.
    private var pauseStartTime: CMTime?

    init(primingOffset: CMTime = Self.defaultPrimingOffset) {
        self.primingOffset = primingOffset
    }

    /// Adjust a sample buffer's timing for priming offset and pauses.
    /// Returns nil if the buffer cannot be retimed.
    func adjust(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let originalDuration = CMSampleBufferGetDuration(sampleBuffer)
        let newPTS = originalPTS + primingOffset - pauseAccumulator

        var timing = CMSampleTimingInfo(
            duration: originalDuration,
            presentationTimeStamp: newPTS,
            decodeTimeStamp: .invalid
        )

        var outputBuffer: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &outputBuffer
        )

        guard status == noErr else { return nil }
        return outputBuffer
    }

    mutating func markPause(at time: CMTime) {
        pauseStartTime = time
    }

    mutating func markResume(at time: CMTime) {
        guard let start = pauseStartTime else { return }
        let duration = time - start
        pauseAccumulator = pauseAccumulator + duration // swiftlint:disable:this shorthand_operator
        pauseStartTime = nil
    }
}
