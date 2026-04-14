import AVFoundation
import CoreMedia
import UniformTypeIdentifiers
import VideoToolbox

actor WriterActor {

    // MARK: - Segment Callback

    /// Called once per finalised segment. Awaited by the writer's consumer
    /// loop so that `finish()` can guarantee every segment has been fully
    /// processed downstream (timeline recorded, upload enqueued) before it
    /// returns. Making this `async` is load-bearing for stop-flow correctness.
    var onSegmentReady: (@Sendable (VideoSegment) async -> Void)?

    // MARK: - State

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var timestampAdjuster: TimestampAdjuster
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
    private struct PendingSegment: Sendable {
        let data: Data
        let isInitialization: Bool
        let duration: Double?
    }

    init() {
        timestampAdjuster = TimestampAdjuster()
    }

    // MARK: - Setup

    /// The output preset in use for the current recording. Captured at
    /// configure() time so the timeline snapshot can include it.
    private(set) var preset: OutputPreset = .default

    func configure(preset: OutputPreset) throws {
        self.preset = preset
        let writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
        writer.initialSegmentStartTime = timestampAdjuster.primingOffset

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

        // Video input: H.264 High Profile, 6 Mbps.
        // Only the 2s duration-based keyframe trigger is set — the frame-count
        // trigger (every 60 frames) would fight it at variable input rates and
        // produce unpredictable keyframe placement, which in turn skews segment
        // boundaries since AVAssetWriter closes segments at keyframes.
        //
        // `AVVideoColorPropertiesKey` declares Rec. 709 on the output so the
        // writer doesn't do its own redundant colourspace conversion — paired
        // with the Rec. 709 tags that `CameraCaptureManager` attaches to
        // camera pixel buffers (see task-0A Phase 1). Without this the output
        // colour space is unspecified and AVFoundation falls back to a
        // conservative path that costs GPU time per frame.
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: preset.width,
            AVVideoHeightKey: preset.height,
            // Task-1 tuning 6: require the hardware H.264 encoder.
            // VTCompressionProperties.h documents the failure cases
            // for this property explicitly, including "the hardware
            // encoding resources on the machine are busy" — which is
            // exactly the condition failure mode 4 suggests we're
            // brushing up against on M2 Pro. Setting this means
            // silent software fallback fails loudly at startWriting()
            // instead of dragging the GPU into a deadlock.
            // The readback form (reading
            // UsingHardwareAcceleratedVideoEncoder after session
            // creation) isn't implementable because AVAssetWriter
            // doesn't expose its internal VTCompressionSession — we
            // rely on enforcement only.
            AVVideoEncoderSpecificationKey: [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: kCFBooleanTrue as Any
            ] as [String: Any],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ] as [String: Any],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: preset.bitrate,
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: 30,
                AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
                // Task-1 tuning 3: OBS/FFmpeg/HandBrake all ship this as
                // false on Apple Silicon after OBS issue #5840 documented
                // framedrops and unreliability with it set to true on
                // M1/M2. Mechanism is undocumented but the production-app
                // convergence is strong signal, and it may affect how the
                // encoder reserves/releases IOSurface backing — the same
                // resource failure mode 4 deadlocks on.
                kVTCompressionPropertyKey_RealTime as String: kCFBooleanFalse as Any,
                // Task-1 tuning 4: disable B-frames. HLS low-latency does
                // not require frame reordering, and the reorder buffer is
                // a per-slot IOSurface reference chain inside the encoder.
                // Turning it off removes those references entirely.
                // Measurable but small bitrate-efficiency loss (a few %);
                // Cap ships this way in crates/enc-avfoundation/src/mp4.rs.
                AVVideoAllowFrameReorderingKey: false,
                // Task-1 tuning 5 (MaxFrameDelayCount) was deferred.
                // AVAssetWriter rejects any value other than 3 for
                // H.264 ("For compression property MaxFrameDelayCount,
                // video codec type avc1 only allows the value 3" — tried
                // 2026-04-14 with value 2, crashed with NSException).
                // HandBrake / OBS / FFmpeg bound this value because they
                // go directly through VTCompressionSession; we can only
                // bound it if we move off AVAssetWriter. That's a shape
                // change belonging to task-4.
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
        let segment: VideoSegment

        if pending.isInitialization {
            segment = VideoSegment(
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
            segment = VideoSegment(
                index: segmentIndex,
                filename: filename,
                data: pending.data,
                duration: duration,
                type: .media
            )
            print("[writer] Segment \(filename): \(pending.data.count) bytes, \(String(format: "%.3f", duration))s")
        }

        await onSegmentReady?(segment)
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
