import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

// MARK: - HarnessRawProResWriter

//
// Minimal analogue of RawStreamWriter .videoProRes from the main app.
// Writes ProRes 422 Proxy to a .mov on the hardware ProRes engine.
// No audio input, no HLS delegate, no timestamp adjuster.
//
// Mirrors the deliberate choices in the main-app writer:
// - No AVVideoColorPropertiesKey on the output. We let AVFoundation
//   infer the output colour space from the first input buffer's
//   attachments. Declaring Rec. 709 on the output forced a GPU-side
//   conversion stage that hung the machine on 2026-04-11 — see
//   failure mode 2 in docs/m2-pro-video-pipeline-failures.md.
// - No AVVideoCompressionPropertiesKey either — ProRes settings don't
//   use the H.264 dictionary shape.

final class HarnessRawProResWriter: HarnessWriter {
    let name: String
    let kind = "raw-prores"
    let outputURL: URL?

    private let width: Int
    private let height: Int
    private let tunings: [String: JSONValue]
    private let events: EventLog

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var hasStartedSession = false
    private var didFinish = false
    private var firstAppendAt: Double?

    private(set) var finalStatus: AVAssetWriter.Status = .unknown
    private(set) var finalError: Error?
    var segmentDurations: [Double] {
        []
    }

    init(
        name: String,
        width: Int,
        height: Int,
        outputURL: URL,
        tunings: [String: JSONValue] = [:],
        events: EventLog
    ) {
        self.name = name
        self.width = width
        self.height = height
        self.outputURL = outputURL
        self.tunings = tunings
        self.events = events
    }

    // MARK: - HarnessWriter

    func configure() throws {
        guard let url = outputURL else { throw HarnessWriterError.missingOutputURL }
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)

        // Task-1 tuning 5 ProRes variant was deferred: AVAssetWriter
        // rejects any AVVideoCompressionPropertiesKey dict on a ProRes
        // output with an NSException (confirmed 2026-04-14 by T1.1
        // crashing with exit code 134). So the ProRes writer stays on
        // the bare codec+dims settings, matching the main-app constraint.
        // The `maxFrameDelayCount` tunings key is intentionally ignored
        // here — accepting it would silently crash when set.
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.proRes422Proxy,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]

        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true

        guard writer.canAdd(input) else { throw HarnessWriterError.cannotAddInput }
        writer.add(input)

        self.writer = writer
        self.input = input
        events.log("writer.configured", [
            "name": name, "kind": kind,
            "width": width, "height": height,
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
        if firstAppendAt == nil { firstAppendAt = events.elapsed() }
        input.append(sample)
    }

    func appendAudio(_: CMSampleBuffer) { /* video-only */ }

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
                "error": writer.error?.localizedDescription ?? "unknown",
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
            "error": writer.error?.localizedDescription ?? "",
        ])
    }

    var bytesOnDisk: Int64? {
        guard let url = outputURL,
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        else {
            return nil
        }
        return (attrs[.size] as? NSNumber)?.int64Value
    }
}

// MARK: - Error

enum HarnessWriterError: Error {
    case missingOutputURL
    case cannotAddInput
    case unsupportedConfig(String)
}
