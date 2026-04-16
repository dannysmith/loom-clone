import AVFoundation
import CoreMedia
import Foundation

// MARK: - HarnessRawAudioWriter

//
// Minimal analogue of RawStreamWriter .audio. Writes AAC-LC to a .m4a.
// Mirrors the main-app settings; no surprises.

final class HarnessRawAudioWriter: HarnessWriter {
    let name: String
    let kind = "raw-audio"
    let outputURL: URL?

    private let sampleRate: Int
    private let channels: Int
    private let bitrate: Int
    private let events: EventLog

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var hasStartedSession = false
    private var didFinish = false

    private(set) var finalStatus: AVAssetWriter.Status = .unknown
    private(set) var finalError: Error?
    var segmentDurations: [Double] {
        []
    }

    init(
        name: String,
        sampleRate: Int,
        channels: Int,
        bitrate: Int,
        outputURL: URL,
        events: EventLog
    ) {
        self.name = name
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitrate = bitrate
        self.outputURL = outputURL
        self.events = events
    }

    func configure() throws {
        guard let url = outputURL else { throw HarnessWriterError.missingOutputURL }
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: bitrate,
        ]
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true

        guard writer.canAdd(input) else { throw HarnessWriterError.cannotAddInput }
        writer.add(input)

        self.writer = writer
        self.input = input
        events.log("writer.configured", [
            "name": name, "kind": kind,
            "sampleRate": sampleRate, "channels": channels, "bitrate": bitrate,
        ])
    }

    func startWriting() {
        guard let writer else { return }
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        hasStartedSession = true
        events.log("writer.started", ["name": name])
    }

    func appendVideo(_: CMSampleBuffer) {}

    func appendAudio(_ sample: CMSampleBuffer) {
        guard hasStartedSession, let input, input.isReadyForMoreMediaData else { return }
        input.append(sample)
    }

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
