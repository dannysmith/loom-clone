import AVFoundation
import CoreMedia
import Foundation

// MARK: - HarnessCompositedHLSWriter
//
// Minimal analogue of WriterActor. AVAssetWriter with HLS profile,
// 4-second automatic segment interval, H.264 High. Captures the
// delegate callbacks to record segment durations into the event log
// so pass/fail can assert cadence stability.
//
// Mirrors the main-app settings shape, including AVVideoColorPropertiesKey
// set to Rec. 709 — this is SAFE here for the same reason it's safe in
// WriterActor: in the real pipeline the compositor renders directly
// into Rec. 709 via ciContext.render(.., colorSpace: .itur_709) so the
// declared output matches the input, and no GPU conversion stage is
// inserted. When running WITHOUT the compositor we feed raw synthetic
// BGRA frames directly, which means the Rec. 709 declaration WILL
// trigger a conversion — that's a tunable we can flip off via config.

final class HarnessCompositedHLSWriter: HarnessWriter, @unchecked Sendable {

    let name: String
    let kind = "composited-hls"
    let outputURL: URL?

    private let width: Int
    private let height: Int
    private let bitrate: Int
    private let tunings: [String: JSONValue]
    private let events: EventLog

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var delegateProxy: HLSDelegateProxy?
    private var hasStartedSession = false
    private var didFinish = false

    private(set) var finalStatus: AVAssetWriter.Status = .unknown
    private(set) var finalError: Error?
    private(set) var segmentDurations: [Double] = []

    // Serialises segment-duration append from the delegate callback
    // (which fires on an arbitrary AVFoundation queue) against the
    // main consumer.
    private let segmentLock = NSLock()

    init(name: String,
         width: Int,
         height: Int,
         bitrate: Int,
         outputURL: URL,
         tunings: [String: JSONValue] = [:],
         events: EventLog) {
        self.name = name
        self.width = width
        self.height = height
        self.bitrate = bitrate
        self.outputURL = outputURL
        self.tunings = tunings
        self.events = events
    }

    // MARK: - Configure

    func configure() throws {
        // HLS segment writers use an outputURL pattern: a directory
        // where init.mp4 and seg_NNN.m4s land. For the harness, though,
        // we use the AVAssetWriter HLS profile with a single output
        // file and capture segment data via the delegate. The URL here
        // is the "seed" URL and doesn't need to exist on disk — we
        // don't actually write segments to disk in the harness.
        //
        // Using AVAssetWriter(contentType:) (not URL-based) matches
        // the main-app WriterActor, which uses the contentType init
        // because there is no stable single-file output for HLS.
        let writer = AVAssetWriter(contentType: .mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
        writer.initialSegmentStartTime = .zero

        let proxy = HLSDelegateProxy()
        // Capture references needed inside the delegate without
        // capturing self (the delegate retains it to avoid dangling).
        let eventsRef = events
        let nameRef = name
        let lock = segmentLock
        proxy.onSegment = { [weak self] data, segmentType, report in
            let isInit = segmentType == .initialization
            let duration = report?.trackReports.first?.duration.seconds
            eventsRef.log("writer.segment", [
                "name": nameRef,
                "init": isInit,
                "bytes": data.count,
                "duration": duration ?? -1,
            ])
            if !isInit, let duration {
                lock.lock()
                self?.segmentDurations.append(duration)
                lock.unlock()
            }
        }
        writer.delegate = proxy

        let colorProps: [String: Any] = [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ]

        var settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: 30,
                AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
            ] as [String: Any],
        ]

        // Tuning: allow opting the Rec.709 output declaration on or
        // off. Defaults to on (main-app default) because that's the
        // configuration we want to exercise.
        let includeColorProps = tunings["declareRec709Output"]?.asBool ?? true
        if includeColorProps {
            settings[AVVideoColorPropertiesKey] = colorProps
        }

        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true

        guard writer.canAdd(input) else { throw HarnessWriterError.cannotAddInput }
        writer.add(input)

        self.writer = writer
        self.videoInput = input
        self.delegateProxy = proxy
        events.log("writer.configured", [
            "name": name, "kind": kind,
            "width": width, "height": height, "bitrate": bitrate,
            "declareRec709Output": includeColorProps,
        ])
    }

    func startWriting() {
        guard let writer else { return }
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        hasStartedSession = true
        events.log("writer.started", ["name": name])
    }

    func appendVideo(_ sample: CMSampleBuffer) {
        guard hasStartedSession, let videoInput, videoInput.isReadyForMoreMediaData else {
            if hasStartedSession, let videoInput, !videoInput.isReadyForMoreMediaData {
                events.log("writer.dropped", ["name": name, "reason": "not-ready"])
            }
            return
        }
        videoInput.append(sample)
    }

    func appendAudio(_ sample: CMSampleBuffer) {}

    func finish() async {
        guard !didFinish else { return }
        didFinish = true
        guard let writer else { return }
        guard hasStartedSession else { return }

        if writer.status == .failed {
            finalStatus = .failed
            finalError = writer.error
            events.log("writer.failed-before-finish", [
                "name": name,
                "error": writer.error?.localizedDescription ?? "unknown"
            ])
            return
        }

        videoInput?.markAsFinished()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            writer.finishWriting { cont.resume() }
        }
        finalStatus = writer.status
        finalError = writer.error
        events.log("writer.finished", [
            "name": name,
            "status": writer.status.rawValue,
            "error": writer.error?.localizedDescription ?? ""
        ])
    }

    /// HLS writer doesn't write to a single file on disk — segments
    /// come through the delegate. Total bytes is the sum of segment
    /// sizes we saw in the callback, approximated as "not tracked here".
    var bytesOnDisk: Int64? { nil }
}

// MARK: - Delegate proxy
//
// AVAssetWriterDelegate is @objc; Swift classes can conform but we
// isolate it into a small proxy to keep the writer itself Sendable-ish.

private final class HLSDelegateProxy: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    var onSegment: ((Data, AVAssetSegmentType, AVAssetSegmentReport?) -> Void)?

    func assetWriter(_ writer: AVAssetWriter,
                     didOutputSegmentData segmentData: Data,
                     segmentType: AVAssetSegmentType,
                     segmentReport: AVAssetSegmentReport?) {
        onSegment?(segmentData, segmentType, segmentReport)
    }
}
