import AVFoundation
import CoreMedia
import UniformTypeIdentifiers

actor WriterActor {
    // MARK: - Segment Callback

    /// Raw emit shape: segment bytes plus metadata. Carries `Data` because the
    /// writer receives bytes from the AVAssetWriter delegate. Downstream
    /// (RecordingActor) writes the payload to local disk and then builds a
    /// URL-based `VideoSegment` to enqueue for upload — bytes aren't retained
    /// in memory past that write.
    struct Emission {
        let index: Int
        let filename: String
        let data: Data
        let duration: Double
        let type: VideoSegment.SegmentType
    }

    /// Called once per finalised segment. Awaited by the writer's consumer
    /// loop so that `finish()` can guarantee every segment has been fully
    /// processed downstream (timeline recorded, upload enqueued) before it
    /// returns. Making this `async` is load-bearing for stop-flow correctness.
    var onSegmentReady: (@Sendable (Emission) async -> Void)?

    // MARK: - State

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var writerDelegate: WriterDelegate?
    private var isPaused = false
    private var segmentIndex = 0
    private var hasStartedSession = false

    // MARK: - Segment Pipeline

    //
    // AVAssetWriterDelegate fires `didOutputSegmentData` on an unknown dispatch
    // queue. We can't do any async work from there directly, and spawning
    // detached Tasks makes stop-time ordering undefined (trailing segments
    // race past `finish()` and miss the timeline + upload queue).
    //
    // Instead, the delegate yields into this AsyncStream synchronously. A
    // single consumer task drains the stream in order and awaits each segment
    // through the full downstream pipeline. `finish()` closes the stream's
    // continuation and awaits the consumer — that gives us a hard guarantee
    // that every trailing segment is fully processed before the writer is
    // considered done.

    private var segmentStream: AsyncStream<PendingSegment>?
    private var segmentContinuation: AsyncStream<PendingSegment>.Continuation?
    private var consumerTask: Task<Void, Never>?

    /// Sendable payload yielded by the delegate. We extract everything we need
    /// synchronously (duration from the report) so the stream element is a
    /// fully-Sendable value type — `AVAssetSegmentReport` is not Sendable.
    private struct PendingSegment {
        let data: Data
        let isInitialization: Bool
        let duration: Double?
    }

    init() {}

    // MARK: - Setup

    /// The output preset in use for the current recording. Captured at
    /// configure() time so the timeline snapshot can include it.
    private(set) var preset: OutputPreset = .default

    /// The target fps for this recording. Captured at configure() time
    /// so it can be threaded into encoder settings and timeline metadata.
    private(set) var fps: Int32 = FrameRate.thirtyFPS.rawValue

    func configure(preset: OutputPreset, fps: Int32) throws {
        self.preset = preset
        self.fps = fps
        let writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
        writer.initialSegmentStartTime = TimestampAdjuster.defaultPrimingOffset

        // Set up the segment stream: delegate yields, consumer drains.
        let (stream, continuation) = AsyncStream.makeStream(of: PendingSegment.self)
        self.segmentStream = stream
        self.segmentContinuation = continuation

        // Wire delegate. It runs on some AVFoundation-owned queue so it must
        // do only synchronous work here: extract the duration from the report
        // (which is not Sendable and can't cross the stream boundary) and
        // yield a plain-data struct.
        let delegate = WriterDelegate()
        delegate.onSegment = { data, segmentType, report in
            let duration: Double? = {
                guard let report,
                      let trackReport = report.trackReports.first else { return nil }
                return trackReport.duration.seconds
            }()
            continuation.yield(
                PendingSegment(
                    data: data,
                    isInitialization: segmentType == .initialization,
                    duration: duration
                )
            )
        }
        writer.delegate = delegate
        self.writerDelegate = delegate

        // Consumer: drains the stream in order, awaiting each segment through
        // the full downstream pipeline. One hop into the actor per segment.
        consumerTask = Task { [weak self] in
            guard let self else { return }
            for await pending in stream {
                await self.handlePendingSegment(pending)
            }
        }

        // Video input: H.264 High Profile via H264Settings.
        // Rec. 709 colour properties declared on the output so the writer
        // doesn't do its own redundant colourspace conversion — paired with
        // the Rec. 709 tags that CameraCaptureManager attaches to camera
        // pixel buffers.
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: preset.width,
            AVVideoHeightKey: preset.height,
            AVVideoEncoderSpecificationKey: H264Settings.encoderSpecification as [String: Any],
            AVVideoColorPropertiesKey: H264Settings.rec709ColorProperties as [String: Any],
            AVVideoCompressionPropertiesKey: H264Settings.compressionProperties(bitrate: preset.bitrate, fps: fps) as [String: Any],
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

        print("[writer] Configured: H.264 High \(preset.bitrate / 1_000_000)Mbps @ \(fps)fps, AAC-LC 128kbps, 4s segments")
    }

    // MARK: - Writing

    func startWriting() throws {
        guard let writer else { return }
        // AVAssetWriter.startWriting() returns false on failure (e.g. the
        // hardware encoder is unavailable under load when
        // RequireHardwareAcceleratedVideoEncoder is set). Without a guard
        // we'd flip hasStartedSession=true and silently no-op every
        // appendVideo/appendAudio because the inputs never become ready —
        // no segment ever fires, so checkHLSWriterHealth has no boundary
        // to run on, and the failure stays invisible until finish().
        guard writer.startWriting() else {
            let detail = writer.error?.localizedDescription ?? "unknown"
            throw WriterError.startWritingFailed(detail)
        }
        writer.startSession(atSourceTime: TimestampAdjuster.defaultPrimingOffset)
        hasStartedSession = true
        print("[writer] Started writing")
    }

    /// Append a sample buffer whose PTS is already in final form. Both
    /// video and audio go through the same path: RecordingActor stamps
    /// every buffer with `primingOffset + (sourcePTS - recordingStartTime) -
    /// pauseAccumulator` before handing off, so the writer is a pure sink
    /// with no timing knowledge of its own.
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

        audioInput.append(sampleBuffer)
    }

    // MARK: - Pause / Resume

    /// Stops the audio input from accepting buffers. The actor also short-
    /// circuits HLS audio appends while paused, so this is defence-in-depth.
    /// Note: flushSegment() is only allowed when preferredOutputSegmentInterval
    /// is .indefinite. With automatic segmentation (4s), AVAssetWriter handles
    /// segment boundaries itself.
    func pause(at _: CMTime) {
        isPaused = true
        print("[writer] Paused")
    }

    func resume(at _: CMTime) {
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
            // Still tear down the consumer if one was created by configure().
            segmentContinuation?.finish()
            _ = await consumerTask?.value
            consumerTask = nil
            segmentStream = nil
            segmentContinuation = nil

            self.writer = nil
            self.videoInput = nil
            self.audioInput = nil
            self.hasStartedSession = false
            return
        }

        // No manual flushSegment() — only valid when preferredOutputSegmentInterval is .indefinite.
        // finishWriting() automatically flushes any remaining data as a final segment.

        // CRITICAL: AVAssetWriter.finishWriting does NOT call its completion
        // handler when the writer is in .failed status (Apple docs: "If the
        // status is AVAssetWriterStatusFailed, the block might not be called").
        // Wrapping it in withCheckedContinuation would hang the actor forever.
        // Check status first and bail with a log if the writer already failed.
        if writer.status == .failed {
            print("[writer] FAILED before finish: \(writer.error?.localizedDescription ?? "unknown")")
        } else {
            // Mark both inputs as finished before calling finishWriting (Apple
            // best practice — tells the writer no more samples are coming).
            videoInput?.markAsFinished()
            audioInput?.markAsFinished()

            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                writer.finishWriting { continuation.resume() }
            }
            print("[writer] Finished writing, status: \(writer.status.rawValue)")
            if let error = writer.error {
                print("[writer] Error: \(error)")
            }
        }

        // Close the segment stream and await the consumer so that every
        // trailing segment — including those flushed inside finishWriting —
        // has been fully processed by `handlePendingSegment` and the awaited
        // `onSegmentReady` callback before finish() returns.
        segmentContinuation?.finish()
        _ = await consumerTask?.value
        consumerTask = nil
        segmentStream = nil
        segmentContinuation = nil

        self.writer = nil
        self.videoInput = nil
        self.audioInput = nil
        self.hasStartedSession = false
    }

    // MARK: - Segment Handling

    /// Runs on the actor, one-at-a-time, driven by the consumer task. Awaits
    /// the downstream handler so `finish()` can be sure a segment is fully
    /// processed end-to-end before it reports completion.
    private func handlePendingSegment(_ pending: PendingSegment) async {
        let emission: Emission

        if pending.isInitialization {
            emission = Emission(
                index: 0,
                filename: "init.mp4",
                data: pending.data,
                duration: 0,
                type: .initialization
            )
            print("[writer] Init segment: \(pending.data.count) bytes")
        } else {
            let duration = pending.duration ?? 4.0

            // finishWriting() emits empty trailing segments with 0 duration — skip them
            if duration < 0.01 {
                print("[writer] Skipping empty segment (\(pending.data.count) bytes, \(String(format: "%.3f", duration))s)")
                return
            }

            segmentIndex += 1
            let filename = String(format: "seg_%03d.m4s", segmentIndex - 1)
            emission = Emission(
                index: segmentIndex,
                filename: filename,
                data: pending.data,
                duration: duration,
                type: .media
            )
            print("[writer] Segment \(filename): \(pending.data.count) bytes, \(String(format: "%.3f", duration))s")
        }

        await onSegmentReady?(emission)
    }

    // MARK: - Health Check

    /// Expose the writer's status for external health checks. Returns
    /// `.unknown` if no writer is configured.
    func writerStatus() -> AVAssetWriter.Status {
        writer?.status ?? .unknown
    }

    /// Expose the writer's error description for timeline recording.
    func writerError() -> String? {
        writer?.error?.localizedDescription
    }

    // MARK: - Errors

    enum WriterError: Error {
        case cannotAddInput(String)
        case startWritingFailed(String)
    }
}

// MARK: - ObjC Delegate Proxy

/// AVAssetWriterDelegate requires @objc, which Swift actors cannot conform to.
/// This proxy bridges the delegate callbacks into the actor.
private final class WriterDelegate: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    var onSegment: ((Data, AVAssetSegmentType, AVAssetSegmentReport?) -> Void)?

    func assetWriter(
        _: AVAssetWriter,
        didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType,
        segmentReport: AVAssetSegmentReport?
    ) {
        onSegment?(segmentData, segmentType, segmentReport)
    }
}
