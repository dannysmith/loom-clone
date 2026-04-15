import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// Structured, self-describing record of what happened during a recording.
///
/// Written to `recording.json` in the local session directory alongside the
/// HLS segments, and uploaded to the server as part of the `complete` payload.
///
/// Purpose: debugging (correlate mode switches / pauses with segment boundaries),
/// server-side forensics (know what the client thought it uploaded), and a
/// foundation for a future local re-compositor. Not a log of record — the
/// segments on disk are authoritative. This is a summary.
///
/// Schema is versioned from day one so we can evolve it without ambiguity.
struct RecordingTimeline: Encodable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    var session: Session
    var app: AppInfo
    var hardware: HardwareInfo
    var inputs: Inputs
    var preset: PresetInfo
    var encoder: EncoderInfo
    var rawStreams: RawStreams?
    var compositionStats: CompositionStats?
    var segments: [SegmentEntry]
    var events: [Event]

    /// Non-zero values here are a hint that the GPU path wobbled during the
    /// recording — either a CoreImage render returned an error (typically
    /// `kIOGPUCommandBufferCallbackErrorTimeout` or its `SubmissionsIgnored`
    /// cascade, see failure mode 1/3 in `m2-pro-video-pipeline-failures.md`)
    /// or our own wait-timeout fired. Present only when at least one of the
    /// counters is non-zero; absent in healthy recordings.
    struct CompositionStats: Encodable {
        let renderErrorCount: Int
        let stallTimeoutCount: Int
        let rebuildSuccessCount: Int
        let terminalFailure: Bool
    }

    /// Local-only high-quality master files written alongside the HLS
    /// segments. Each entry is present only if its source was actually
    /// recorded (i.e. user selected that input).
    struct RawStreams: Encodable {
        let screen: VideoStream?
        let camera: VideoStream?
        let audio: AudioStream?

        struct VideoStream: Encodable {
            let filename: String
            let width: Int
            let height: Int
            let videoCodec: String
            let bitrate: Int
            let bytes: Int64
        }

        struct AudioStream: Encodable {
            let filename: String
            let audioCodec: String
            let bitrate: Int
            let sampleRate: Int
            let channels: Int
            let bytes: Int64
        }
    }

    struct PresetInfo: Encodable {
        let id: String
        let label: String
        let width: Int
        let height: Int
        let bitrate: Int
    }

    // MARK: - Nested types

    struct Session: Encodable {
        let id: String
        let slug: String
        var initialMode: String
        var startedAt: String       // ISO8601, set at commit
        var endedAt: String?         // ISO8601, set at stop
        var durationSeconds: Double? // logical duration (minus pauses)
    }

    struct AppInfo: Encodable {
        let version: String
        let build: String
        let osVersion: String
    }

    struct HardwareInfo: Encodable {
        let model: String
        let arch: String
    }

    struct Inputs: Encodable {
        let display: Display?
        let camera: Device?
        let microphone: Device?

        struct Display: Encodable {
            let id: UInt32
            let width: Int
            let height: Int
        }

        struct Device: Encodable {
            let uniqueID: String
            let name: String
        }
    }

    struct EncoderInfo: Encodable {
        let videoCodec: String
        let videoProfile: String
        let videoBitrate: Int
        let audioCodec: String
        let audioBitrate: Int
        let targetFPS: Int
        let outputWidth: Int
        let outputHeight: Int
        let segmentIntervalSeconds: Double
    }

    /// One per segment, in emission order. Captures both what was produced
    /// and what the client believes happened to it during upload.
    struct SegmentEntry: Encodable {
        let index: Int
        let filename: String
        let bytes: Int
        let durationSeconds: Double
        /// Seconds from recording start (logical timeline) when the segment
        /// was emitted by the writer.
        let emittedAt: Double
        var uploaded: Bool
        var uploadError: String?
    }

    /// Timeline event. `t` is logical seconds from recording start; `wallClock`
    /// is ISO8601 at the moment it was recorded. Both are included because the
    /// relationship between them (via pause accumulator) is itself interesting.
    struct Event: Encodable {
        let t: Double
        let wallClock: String
        let kind: String
        let data: [String: JSONValue]?
    }
}

/// Tiny JSON value enum so events can carry arbitrary small payloads without
/// dragging `Any` through Codable. Covers the shapes we actually need.
enum JSONValue: Encodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        }
    }
}

// MARK: - Builder

/// Mutable accumulator used during recording. Single-threaded access from
/// inside `RecordingActor`. Produces an immutable `RecordingTimeline` on `build()`.
final class RecordingTimelineBuilder {
    private var sessionId: String = ""
    private var slug: String = ""
    private var initialMode: RecordingMode = .screenAndCamera
    private var startedAt: Date?
    private var endedAt: Date?
    private var durationSeconds: Double?
    private var inputs: RecordingTimeline.Inputs = .init(display: nil, camera: nil, microphone: nil)
    private var preset: OutputPreset = .default
    private var rawScreen: RecordingTimeline.RawStreams.VideoStream?
    private var rawCamera: RecordingTimeline.RawStreams.VideoStream?
    private var rawAudio: RecordingTimeline.RawStreams.AudioStream?
    private var renderErrorCount: Int = 0
    private var stallTimeoutCount: Int = 0
    private var rebuildSuccessCount: Int = 0
    private var terminalCompositionFailure: Bool = false
    private var segments: [RecordingTimeline.SegmentEntry] = []
    private var events: [RecordingTimeline.Event] = []

    /// Wall clock at which t=0 on the timeline is anchored. Set at commit,
    /// matches the recording clock anchor in RecordingActor.
    private var anchorWallClock: Date?

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func setSession(id: String, slug: String, initialMode: RecordingMode) {
        self.sessionId = id
        self.slug = slug
        self.initialMode = initialMode
    }

    func setPreset(_ preset: OutputPreset) {
        self.preset = preset
    }

    func setRawScreen(filename: String, width: Int, height: Int, codec: String, bitrate: Int, bytes: Int64) {
        rawScreen = .init(
            filename: filename,
            width: width,
            height: height,
            videoCodec: codec,
            bitrate: bitrate,
            bytes: bytes
        )
    }

    func setRawCamera(filename: String, width: Int, height: Int, codec: String, bitrate: Int, bytes: Int64) {
        rawCamera = .init(
            filename: filename,
            width: width,
            height: height,
            videoCodec: codec,
            bitrate: bitrate,
            bytes: bytes
        )
    }

    func setRawAudio(filename: String, codec: String, bitrate: Int, sampleRate: Int, channels: Int, bytes: Int64) {
        rawAudio = .init(
            filename: filename,
            audioCodec: codec,
            bitrate: bitrate,
            sampleRate: sampleRate,
            channels: channels,
            bytes: bytes
        )
    }

    func setInputs(
        display: RecordingTimeline.Inputs.Display?,
        camera: RecordingTimeline.Inputs.Device?,
        microphone: RecordingTimeline.Inputs.Device?
    ) {
        self.inputs = .init(display: display, camera: camera, microphone: microphone)
    }

    /// Called at commit — anchors t=0 and marks the session start.
    func markStarted() {
        let now = Date()
        anchorWallClock = now
        startedAt = now
        appendEvent(t: 0, kind: "recording.committed", data: nil)
    }

    func markStopped(logicalDuration: Double) {
        endedAt = Date()
        durationSeconds = logicalDuration
        appendEvent(t: logicalDuration, kind: "recording.stopped", data: nil)
    }

    func recordModeSwitch(from: RecordingMode, to: RecordingMode, t: Double) {
        appendEvent(
            t: t,
            kind: "mode.switched",
            data: [
                "from": .string(from.rawValue),
                "to": .string(to.rawValue),
            ]
        )
    }

    func recordPaused(t: Double) {
        appendEvent(t: t, kind: "paused", data: nil)
    }

    func recordResumed(t: Double, pauseDuration: Double) {
        appendEvent(
            t: t,
            kind: "resumed",
            data: ["pauseDurationSeconds": .double(pauseDuration)]
        )
    }

    func recordSegment(
        index: Int,
        filename: String,
        bytes: Int,
        duration: Double,
        emittedAt: Double
    ) {
        segments.append(
            .init(
                index: index,
                filename: filename,
                bytes: bytes,
                durationSeconds: duration,
                emittedAt: emittedAt,
                uploaded: false,
                uploadError: nil
            )
        )
        appendEvent(
            t: emittedAt,
            kind: "segment.emitted",
            data: [
                "filename": .string(filename),
                "bytes": .int(bytes),
                "durationSeconds": .double(duration),
            ]
        )
    }

    func recordUploadResult(filename: String, success: Bool, error: String?, t: Double) {
        if let idx = segments.firstIndex(where: { $0.filename == filename }) {
            segments[idx].uploaded = success
            segments[idx].uploadError = error
        }
        var data: [String: JSONValue] = ["filename": .string(filename)]
        if let error { data["error"] = .string(error) }
        appendEvent(
            t: t,
            kind: success ? "segment.uploaded" : "segment.uploadFailed",
            data: data
        )
    }

    func recordError(message: String, t: Double) {
        appendEvent(t: t, kind: "error", data: ["message": .string(message)])
    }

    /// Called by RecordingActor when the compositor reports a render failure
    /// or a stall. `kind` is `"renderError"` or `"stallTimeout"`. Emits an
    /// event and increments the matching counter.
    func recordCompositionFailure(kind: String, t: Double, detail: String?) {
        switch kind {
        case "renderError": renderErrorCount += 1
        case "stallTimeout": stallTimeoutCount += 1
        default: break
        }
        var data: [String: JSONValue] = ["kind": .string(kind)]
        if let detail { data["detail"] = .string(detail) }
        appendEvent(t: t, kind: "composition.failed", data: data)
    }

    /// Called after a successful `CompositionActor.rebuildContext()`.
    func recordCompositionRebuilt(t: Double) {
        rebuildSuccessCount += 1
        appendEvent(t: t, kind: "composition.rebuilt", data: nil)
    }

    /// Called once if rebuild itself fails and the recording escalates to a
    /// clean terminal stop. The `recording.stopped` event still fires at the
    /// usual stop-time path.
    func recordCompositionTerminalFailure(t: Double, detail: String?) {
        terminalCompositionFailure = true
        var data: [String: JSONValue] = [:]
        if let detail { data["detail"] = .string(detail) }
        appendEvent(
            t: t,
            kind: "composition.terminalFailure",
            data: data.isEmpty ? nil : data
        )
    }

    /// Seconds since t=0 (the commit anchor). Safe to call before the anchor
    /// is set — returns 0.
    func now() -> Double {
        guard let anchor = anchorWallClock else { return 0 }
        return Date().timeIntervalSince(anchor)
    }

    // MARK: - Build

    func build() -> RecordingTimeline {
        // Sort events by logical time so the timeline reads in chronological
        // order even when events were appended slightly out of order (e.g.
        // `recording.stopped` is recorded before `writer.finish()` runs, but
        // the final segment is emitted *during* finish — both have correct
        // `t` values, they just get inserted in the wrong order). Stable sort
        // preserves insertion order for events that share a `t` (e.g. paused
        // and resumed at the same frozen logical time).
        let sortedEvents = events
            .enumerated()
            .sorted { lhs, rhs in
                if lhs.element.t != rhs.element.t { return lhs.element.t < rhs.element.t }
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        return RecordingTimeline(
            schemaVersion: RecordingTimeline.currentSchemaVersion,
            session: .init(
                id: sessionId,
                slug: slug,
                initialMode: initialMode.rawValue,
                startedAt: startedAt.map { Self.isoFormatter.string(from: $0) } ?? "",
                endedAt: endedAt.map { Self.isoFormatter.string(from: $0) },
                durationSeconds: durationSeconds
            ),
            app: Self.currentAppInfo(),
            hardware: Self.currentHardware(),
            inputs: inputs,
            preset: .init(
                id: preset.id,
                label: preset.label,
                width: preset.width,
                height: preset.height,
                bitrate: preset.bitrate
            ),
            encoder: Self.currentEncoder(preset: preset),
            rawStreams: (rawScreen == nil && rawCamera == nil && rawAudio == nil)
                ? nil
                : .init(screen: rawScreen, camera: rawCamera, audio: rawAudio),
            compositionStats: compositionStatsIfInteresting(),
            segments: segments,
            events: sortedEvents
        )
    }

    // MARK: - Internals

    /// Only emit compositionStats when something worth recording happened.
    /// Healthy recordings carry no counters — the field is absent rather than
    /// zero-valued, so the common-case JSON stays small.
    private func compositionStatsIfInteresting() -> RecordingTimeline.CompositionStats? {
        guard renderErrorCount > 0
                || stallTimeoutCount > 0
                || rebuildSuccessCount > 0
                || terminalCompositionFailure else { return nil }
        return .init(
            renderErrorCount: renderErrorCount,
            stallTimeoutCount: stallTimeoutCount,
            rebuildSuccessCount: rebuildSuccessCount,
            terminalFailure: terminalCompositionFailure
        )
    }

    private func appendEvent(t: Double, kind: String, data: [String: JSONValue]?) {
        events.append(
            .init(
                t: t,
                wallClock: Self.isoFormatter.string(from: Date()),
                kind: kind,
                data: data
            )
        )
    }

    // MARK: - Environment

    private static func currentAppInfo() -> RecordingTimeline.AppInfo {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info?["CFBundleVersion"] as? String ?? "unknown"
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return .init(
            version: version,
            build: build,
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        )
    }

    private static func currentHardware() -> RecordingTimeline.HardwareInfo {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var model = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &model, &size, nil, 0)
        let modelName = String(cString: model)

        #if arch(arm64)
        let arch = "arm64"
        #elseif arch(x86_64)
        let arch = "x86_64"
        #else
        let arch = "unknown"
        #endif

        return .init(model: modelName, arch: arch)
    }

    private static func currentEncoder(preset: OutputPreset) -> RecordingTimeline.EncoderInfo {
        .init(
            videoCodec: "h264",
            videoProfile: "High",
            videoBitrate: preset.bitrate,
            audioCodec: "aac-lc",
            audioBitrate: 128_000,
            targetFPS: 30,
            outputWidth: preset.width,
            outputHeight: preset.height,
            segmentIntervalSeconds: 4.0
        )
    }
}
