import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

// MARK: - HarnessRawH264Writer
//
// Minimal analogue of RawStreamWriter .videoH264. Writes H.264 High
// Profile to a plain .mp4. No HLS segmentation, no audio input.
// Mirrors the deliberate choice in the main-app writer to omit
// AVVideoColorPropertiesKey — see the ProRes writer's doc for the
// full context and failure mode 2 in m2-pro-video-pipeline-failures.

final class HarnessRawH264Writer: HarnessWriter {

    let name: String
    let kind = "raw-h264"
    let outputURL: URL?

    private let width: Int
    private let height: Int
    private let bitrate: Int
    private let tunings: [String: JSONValue]
    private let events: EventLog

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var hasStartedSession = false
    private var didFinish = false

    private(set) var finalStatus: AVAssetWriter.Status = .unknown
    private(set) var finalError: Error?
    var segmentDurations: [Double] { [] }

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

    func configure() throws {
        guard let url = outputURL else { throw HarnessWriterError.missingOutputURL }
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)

        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: 30,
            AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
            // Task-1 tuning 4: disable B-frames (see WriterActor).
            // Overridable via the `allowFrameReordering` tunings key.
            AVVideoAllowFrameReorderingKey: tunings["allowFrameReordering"]?.asBool ?? false,
            // Task-1 tuning 5 (MaxFrameDelayCount) was deferred — see
            // HarnessCompositedHLSWriter for the full context.
        ]
        // Task-1 tuning 3: RealTime = false by default. Overridable
        // via the `realTime` tunings key for Tier 5 priority 4 sweeps
        // across {unset, false, true}. A JSONValue.null override
        // leaves the property unset (matching the macOS default of
        // "unknown") for the comparison against an explicit bool.
        switch tunings["realTime"] {
        case .some(.bool(let b)):
            compression[kVTCompressionPropertyKey_RealTime as String] = (b ? kCFBooleanTrue : kCFBooleanFalse) as Any
        case .some(.null):
            break
        case .none:
            compression[kVTCompressionPropertyKey_RealTime as String] = kCFBooleanFalse as Any
        default:
            compression[kVTCompressionPropertyKey_RealTime as String] = kCFBooleanFalse as Any
        }
        // Surface a handful of tunings so parameter sweeps can flip
        // them from the config without new code. Anything not listed
        // here is ignored — new knobs get added as task-0B findings
        // land.
        if let v = tunings["expectedFrameRate"]?.asInt {
            compression[AVVideoExpectedSourceFrameRateKey] = v
        }
        if let v = tunings["maxKeyFrameIntervalDuration"]?.asInt {
            compression[AVVideoMaxKeyFrameIntervalDurationKey] = Double(v)
        }
        if let v = tunings["averageBitRate"]?.asInt {
            compression[AVVideoAverageBitRateKey] = v
        }

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression,
        ]

        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true

        guard writer.canAdd(input) else { throw HarnessWriterError.cannotAddInput }
        writer.add(input)

        self.writer = writer
        self.input = input
        events.log("writer.configured", [
            "name": name, "kind": kind,
            "width": width, "height": height, "bitrate": bitrate,
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
        guard hasStartedSession, let input, input.isReadyForMoreMediaData else {
            if hasStartedSession, let input, !input.isReadyForMoreMediaData {
                events.log("writer.dropped", ["name": name, "reason": "not-ready"])
            }
            return
        }
        input.append(sample)
    }

    func appendAudio(_ sample: CMSampleBuffer) {}

    func finish() async {
        guard !didFinish else { return }
        didFinish = true
        guard let writer else { return }
        guard hasStartedSession else {
            if let url = outputURL { try? FileManager.default.removeItem(at: url) }
            return
        }

        if writer.status == .failed {
            finalStatus = .failed
            finalError = writer.error
            events.log("writer.failed-before-finish", [
                "name": name,
                "error": writer.error?.localizedDescription ?? "unknown"
            ])
            return
        }

        input?.markAsFinished()
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

    var bytesOnDisk: Int64? {
        guard let url = outputURL,
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else {
            return nil
        }
        return (attrs[.size] as? NSNumber)?.int64Value
    }
}
