import AVFoundation
import CoreMedia
import Foundation

/// Writes a single capture stream (video or audio) to a standalone
/// MP4 / MOV / M4A file at native quality. Used for the local
/// "high-quality master" files that live alongside the composited HLS
/// segments — `screen.mov` (ProRes 422 Proxy), `camera.mp4` (H.264),
/// `audio.m4a` (AAC).
///
/// Deliberately much simpler than `WriterActor`:
/// - No HLS delegate, no segment stream, no `AVAssetSegmentReport`.
/// - No priming offset (raw files aren't HLS, the AAC encoder delay is
///   handled inside the MP4 itself by the framework).
/// - No internal `TimestampAdjuster`. Sample buffers are pre-retimed by
///   the caller (`RecordingActor`) so each writer's PTS values start at
///   zero on its own session timeline.
/// - One file, one input. Video writers don't take audio, audio writers
///   don't take video. Audio is a single-source recording so it's
///   captured into its own file rather than embedded in both video files.
actor RawStreamWriter {
    enum Kind {
        /// H.264 via VideoToolbox on the hardware H.264/HEVC media engine.
        /// Used for the raw camera writer. Target bitrate, H.264 High Profile,
        /// 2 s keyframe interval.
        case videoH264(width: Int, height: Int, bitrate: Int)

        /// ProRes 422 Proxy via the hardware ProRes engine — a separate
        /// silicon block on M*Pro / M*Max chips, distinct from the H.264
        /// engine that handles the composited HLS writer and the raw camera
        /// writer. Used for the raw screen writer to offload the heaviest
        /// stream off the (single, already contended) H.264 engine on
        /// M2 Pro-class hardware. ProRes is roughly CBR-per-frame based on
        /// resolution (~45 Mb/s at 1080p, ~180 Mb/s at 4K) so there's no
        /// target bitrate to pass.
        case videoProRes(width: Int, height: Int)

        case audio(bitrate: Int, sampleRate: Int, channels: Int)
    }

    let url: URL
    let kind: Kind

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var hasStartedSession = false
    private var didFinish = false

    init(url: URL, kind: Kind) {
        self.url = url
        self.kind = kind
    }

    // MARK: - Setup

    func configure() throws {
        // The destination URL must not exist when AVAssetWriter is created
        // — it will refuse to overwrite. Belt-and-braces remove.
        try? FileManager.default.removeItem(at: url)

        let fileType: AVFileType = switch kind {
        case .videoH264: .mp4
        case .videoProRes: .mov
        case .audio: .m4a
        }

        let writer = try AVAssetWriter(outputURL: url, fileType: fileType)

        let input: AVAssetWriterInput
        switch kind {
        case let .videoH264(width, height, bitrate):
            // No AVVideoColorPropertiesKey — colour space is inferred from
            // pixel buffer attachments. Declaring Rec. 709 explicitly would
            // force GPU-side colour conversion on screen-capture frames
            // (which arrive in Display P3 / sRGB), risking a GPU wedge on
            // contended pipelines. See H264Settings.rec709ColorProperties
            // for when it IS safe to declare.
            let videoSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoEncoderSpecificationKey: H264Settings.encoderSpecification as [String: Any],
                AVVideoCompressionPropertiesKey: H264Settings.compressionProperties(bitrate: bitrate) as [String: Any],
            ]
            input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)

        case let .videoProRes(width, height):
            // ProRes 422 Proxy via the hardware ProRes engine. No
            // `AVVideoCompressionPropertiesKey` — AVAssetWriter rejects any
            // compression-properties dict on a ProRes output with an
            // NSException at input construction.
            //
            // No `AVVideoColorPropertiesKey` either: we let AVFoundation
            // infer the output colour space from the input pixel buffers,
            // which avoids the GPU-side colour conversion that can cause a
            // WindowServer hang (see the H.264 case above for the full
            // context). ScreenCaptureKit frames come tagged with the
            // display's native colour space and that tag propagates through
            // to the ProRes output.
            let videoSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.proRes422Proxy,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
            ]
            input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)

        case let .audio(bitrate, sampleRate, channels):
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: bitrate,
            ]
            input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        }

        input.expectsMediaDataInRealTime = true

        guard writer.canAdd(input) else {
            throw RawWriterError.cannotAddInput
        }
        writer.add(input)

        self.writer = writer
        self.input = input
        self.hasStartedSession = false
        self.didFinish = false
    }

    func startWriting() {
        guard let writer else { return }
        writer.startWriting()
        // Caller pre-retimes buffers so PTS starts at zero on each writer's
        // own session timeline. The session origin is correspondingly zero.
        writer.startSession(atSourceTime: .zero)
        hasStartedSession = true
    }

    // MARK: - Append

    func append(_ sampleBuffer: CMSampleBuffer) {
        guard hasStartedSession,
              let input,
              input.isReadyForMoreMediaData else { return }
        input.append(sampleBuffer)
    }

    // MARK: - Finish

    func finish() async {
        guard !didFinish else { return }
        didFinish = true

        guard let writer else { return }

        // If the session never started (cancelled during prepare/countdown),
        // there's nothing to finish — finishWriting() on an unstarted writer
        // throws. Just clean up and remove the empty file if it exists.
        guard hasStartedSession else {
            try? FileManager.default.removeItem(at: url)
            self.writer = nil
            self.input = nil
            return
        }

        input?.markAsFinished()

        // CRITICAL: AVAssetWriter.finishWriting does NOT call its completion
        // handler when the writer is in .failed status (Apple docs: "If the
        // status is AVAssetWriterStatusFailed, the block might not be called").
        // Wrapping it in withCheckedContinuation would hang the actor forever.
        // Check status first and bail with a log if the writer already failed.
        if writer.status == .failed {
            print("[raw-writer] \(url.lastPathComponent) FAILED before finish: \(writer.error?.localizedDescription ?? "unknown")")
            self.writer = nil
            self.input = nil
            return
        }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting { continuation.resume() }
        }

        if let error = writer.error {
            print("[raw-writer] \(url.lastPathComponent) finished with error: \(error)")
        } else {
            print("[raw-writer] \(url.lastPathComponent) finished, status: \(writer.status.rawValue)")
        }

        self.writer = nil
        self.input = nil
    }

    // MARK: - File metadata

    /// Bytes on disk after `finish()` has run. Returns nil if the file
    /// doesn't exist (e.g. cancelled before any data was written).
    nonisolated func bytesOnDisk() -> Int64? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else {
            return nil
        }
        return (attrs[.size] as? NSNumber)?.int64Value
    }

    enum RawWriterError: Error {
        case cannotAddInput
    }
}
