import AVFoundation
import CoreMedia
import UniformTypeIdentifiers

actor WriterActor {

    // MARK: - Segment Callback

    var onSegmentReady: ((VideoSegment) -> Void)?

    // MARK: - State

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var timestampAdjuster: TimestampAdjuster
    private var writerDelegate: WriterDelegate?
    private var isPaused = false
    private var segmentIndex = 0
    private var hasStartedSession = false

    init() {
        timestampAdjuster = TimestampAdjuster()
    }

    // MARK: - Setup

    func configure() throws {
        let writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
        writer.initialSegmentStartTime = timestampAdjuster.primingOffset

        // Wire delegate
        let delegate = WriterDelegate()
        delegate.onSegment = { [weak self] data, segmentType, report in
            guard let self else { return }
            Task { await self.handleSegment(data: data, type: segmentType, report: report) }
        }
        writer.delegate = delegate
        self.writerDelegate = delegate

        // Video input: H.264 High Profile, 6 Mbps.
        // Only the 2s duration-based keyframe trigger is set — the frame-count
        // trigger (every 60 frames) would fight it at variable input rates and
        // produce unpredictable keyframe placement, which in turn skews segment
        // boundaries since AVAssetWriter closes segments at keyframes.
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: CompositionActor.outputWidth,
            AVVideoHeightKey: CompositionActor.outputHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 6_000_000,
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: 30,
                AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
            ] as [String: Any],
        ]

        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true

        // Audio input: AAC-LC, 48kHz, stereo, 128kbps
        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000,
        ]

        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput.expectsMediaDataInRealTime = true

        guard writer.canAdd(videoInput) else {
            throw WriterError.cannotAddInput("video")
        }
        writer.add(videoInput)

        guard writer.canAdd(audioInput) else {
            throw WriterError.cannotAddInput("audio")
        }
        writer.add(audioInput)

        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        self.segmentIndex = 0
        self.hasStartedSession = false

        print("[writer] Configured: H.264 High 6Mbps, AAC-LC 128kbps, 4s segments")
    }

    // MARK: - Writing

    func startWriting() {
        guard let writer else { return }
        writer.startWriting()
        writer.startSession(atSourceTime: timestampAdjuster.primingOffset)
        hasStartedSession = true
        print("[writer] Started writing")
    }

    /// Append a video sample buffer whose PTS is already in final form.
    /// The metronome in RecordingActor emits frames with PTS =
    /// `primingOffset + frameIdx / 30` and handles pause by not advancing
    /// `frameIdx`, so this path intentionally bypasses `TimestampAdjuster` —
    /// the adjuster's pause accumulator only applies to audio.
    func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        guard hasStartedSession,
              let videoInput,
              videoInput.isReadyForMoreMediaData else { return }

        videoInput.append(sampleBuffer)
    }

    func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        guard !isPaused,
              hasStartedSession,
              let audioInput,
              audioInput.isReadyForMoreMediaData else { return }

        guard let adjusted = timestampAdjuster.adjust(sampleBuffer) else { return }
        audioInput.append(adjusted)
    }

    // MARK: - Pause / Resume

    func pause(at time: CMTime) {
        isPaused = true
        timestampAdjuster.markPause(at: time)
        // Note: flushSegment() is only allowed when preferredOutputSegmentInterval is .indefinite.
        // With automatic segmentation (4s), AVAssetWriter handles segment boundaries itself.
        print("[writer] Paused")
    }

    func resume(at time: CMTime) {
        timestampAdjuster.markResume(at: time)
        isPaused = false
        print("[writer] Resumed")
    }

    // MARK: - Finish

    func finish() async {
        guard let writer else { return }

        // If the session never started (e.g. cancelled during prepare/countdown),
        // there's nothing to finish — finishWriting() on an unstarted writer
        // throws "AVAssetWriterStatusUnknown" errors. Just clean up state.
        guard hasStartedSession else {
            self.writer = nil
            self.videoInput = nil
            self.audioInput = nil
            self.hasStartedSession = false
            return
        }

        // No manual flushSegment() — only valid when preferredOutputSegmentInterval is .indefinite.
        // finishWriting() automatically flushes any remaining data as a final segment.

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                print("[writer] Finished writing, status: \(writer.status.rawValue)")
                if let error = writer.error {
                    print("[writer] Error: \(error)")
                }
                continuation.resume()
            }
        }

        self.writer = nil
        self.videoInput = nil
        self.audioInput = nil
        self.hasStartedSession = false
    }

    // MARK: - Segment Handling

    private func handleSegment(
        data: Data,
        type: AVAssetSegmentType,
        report: AVAssetSegmentReport?
    ) {
        let segment: VideoSegment

        switch type {
        case .initialization:
            segment = VideoSegment(
                index: 0,
                filename: "init.mp4",
                data: data,
                duration: 0,
                type: .initialization
            )
            print("[writer] Init segment: \(data.count) bytes")

        case .separable:
            let duration = extractDuration(from: report) ?? 4.0

            // finishWriting() emits empty trailing segments with 0 duration — skip them
            if duration < 0.01 {
                print("[writer] Skipping empty segment (\(data.count) bytes, \(String(format: "%.3f", duration))s)")
                return
            }

            segmentIndex += 1
            let filename = String(format: "seg_%03d.m4s", segmentIndex - 1)
            segment = VideoSegment(
                index: segmentIndex,
                filename: filename,
                data: data,
                duration: duration,
                type: .media
            )
            print("[writer] Segment \(filename): \(data.count) bytes, \(String(format: "%.3f", duration))s")

        @unknown default:
            print("[writer] Unknown segment type: \(type)")
            return
        }

        onSegmentReady?(segment)
    }

    private func extractDuration(from report: AVAssetSegmentReport?) -> Double? {
        guard let report,
              let trackReport = report.trackReports.first else { return nil }
        return trackReport.duration.seconds
    }

    // MARK: - Errors

    enum WriterError: Error {
        case cannotAddInput(String)
    }
}

// MARK: - ObjC Delegate Proxy

/// AVAssetWriterDelegate requires @objc, which Swift actors cannot conform to.
/// This proxy bridges the delegate callbacks into the actor.
private final class WriterDelegate: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    var onSegment: ((Data, AVAssetSegmentType, AVAssetSegmentReport?) -> Void)?

    func assetWriter(
        _ writer: AVAssetWriter,
        didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType,
        segmentReport: AVAssetSegmentReport?
    ) {
        onSegment?(segmentData, segmentType, segmentReport)
    }
}
