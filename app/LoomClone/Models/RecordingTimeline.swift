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
    /// v3 introduced the top-level `runtime` block and the optional
    /// `advertisedFormats` / `selectedFormat` fields on `Inputs.Device`
    /// for cameras. All new fields are optional / `encodeIfPresent`, so
    /// v3 documents are forwards-compatible with v2-aware consumers.
    static let currentSchemaVersion = 3

    let schemaVersion: Int
    var session: Session
    var app: AppInfo
    var hardware: HardwareInfo
    var inputs: Inputs
    var preset: PresetInfo
    var encoder: EncoderInfo
    var rawStreams: RawStreams?
    var compositionStats: CompositionStats?
    var runtime: Runtime?
    var segments: [SegmentEntry]
    var events: [Event]

    /// v3+ aggregate runtime metrics. Computed at stop time from
    /// `MetronomeDiagnostics`. Lets downstream code answer "what
    /// actually happened during this recording?" without parsing the
    /// full diagnostics.json. Absent (`nil`) on recordings where no
    /// runtime data was captured — e.g. a prepare-only run that never
    /// committed.
    struct Runtime: Encodable {
        /// Frames received from the camera per second of recording
        /// duration. May be less than the camera's advertised rate
        /// during periods of low light or USB contention.
        let effectiveCameraFps: Double?
        /// Frames received from ScreenCaptureKit per second of recording
        /// duration. SCK only delivers `.complete` frames so this is
        /// content-dependent — a static screen produces near zero.
        let effectiveScreenFps: Double?
        /// Frames the metronome successfully emitted (real + keep-alive)
        /// per second of recording duration. This is the rate of frames
        /// that actually reach the encoder.
        let outputFps: Double?
        /// Median camera capture-to-capture interval, in milliseconds.
        /// Computed from the bucketed histogram so this is the upper
        /// edge of the bucket containing the median — coarse but
        /// useful for "is camera delivery healthy at ~33ms (30fps)?"
        let cameraIntervalP50Ms: Double?
        let cameraIntervalP95Ms: Double?
        let screenIntervalP50Ms: Double?
        let screenIntervalP95Ms: Double?
        let metronome: MetronomeCounters

        struct MetronomeCounters: Encodable {
            let iterations: Int64
            let emitOK: Int64
            let skipsStale: Int64
            let keepAliveEmits: Int64
            let monoRejects: Int64
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(effectiveCameraFps, forKey: .effectiveCameraFps)
            try c.encodeIfPresent(effectiveScreenFps, forKey: .effectiveScreenFps)
            try c.encodeIfPresent(outputFps, forKey: .outputFps)
            try c.encodeIfPresent(cameraIntervalP50Ms, forKey: .cameraIntervalP50Ms)
            try c.encodeIfPresent(cameraIntervalP95Ms, forKey: .cameraIntervalP95Ms)
            try c.encodeIfPresent(screenIntervalP50Ms, forKey: .screenIntervalP50Ms)
            try c.encodeIfPresent(screenIntervalP95Ms, forKey: .screenIntervalP95Ms)
            try c.encode(metronome, forKey: .metronome)
        }

        private enum CodingKeys: String, CodingKey {
            case effectiveCameraFps
            case effectiveScreenFps
            case outputFps
            case cameraIntervalP50Ms
            case cameraIntervalP95Ms
            case screenIntervalP50Ms
            case screenIntervalP95Ms
            case metronome
        }
    }

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
            /// True when AVAssetWriter failed — file is truncated. Nil on healthy recordings.
            let failed: Bool? // swiftlint:disable:this discouraged_optional_boolean

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(filename, forKey: .filename)
                try c.encode(width, forKey: .width)
                try c.encode(height, forKey: .height)
                try c.encode(videoCodec, forKey: .videoCodec)
                try c.encode(bitrate, forKey: .bitrate)
                try c.encode(bytes, forKey: .bytes)
                try c.encodeIfPresent(failed, forKey: .failed)
            }

            private enum CodingKeys: String, CodingKey {
                case filename, width, height, videoCodec, bitrate, bytes, failed
            }
        }

        struct AudioStream: Encodable {
            let filename: String
            let audioCodec: String
            let bitrate: Int
            let sampleRate: Int
            let channels: Int
            let bytes: Int64
            /// True when AVAssetWriter failed — file is truncated. Nil on healthy recordings.
            let failed: Bool? // swiftlint:disable:this discouraged_optional_boolean

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(filename, forKey: .filename)
                try c.encode(audioCodec, forKey: .audioCodec)
                try c.encode(bitrate, forKey: .bitrate)
                try c.encode(sampleRate, forKey: .sampleRate)
                try c.encode(channels, forKey: .channels)
                try c.encode(bytes, forKey: .bytes)
                try c.encodeIfPresent(failed, forKey: .failed)
            }

            private enum CodingKeys: String, CodingKey {
                case filename, audioCodec, bitrate, sampleRate, channels, bytes, failed
            }
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
        var initialPipPosition: String
        var startedAt: String // ISO8601, set at commit
        var endedAt: String? // ISO8601, set at stop
        var durationSeconds: Double? // logical duration (minus pauses)
        var exclusions: Exclusions?
    }

    /// Apps and windows excluded from the screen capture for this recording.
    struct Exclusions: Encodable {
        let excludedApps: [ExcludedApp]
        let desktopIconsHidden: Bool

        struct ExcludedApp: Encodable {
            let bundleID: String
            let name: String
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            if !excludedApps.isEmpty {
                try c.encode(excludedApps, forKey: .excludedApps)
            }
            if desktopIconsHidden {
                try c.encode(desktopIconsHidden, forKey: .desktopIconsHidden)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case excludedApps, desktopIconsHidden
        }
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
            /// HAL-reported input latency in milliseconds (audio devices only).
            /// Nil for non-audio devices (camera).
            let halInputLatencyMs: Double?
            /// v3+ camera-only: trimmed advertised formats list. Nil on
            /// non-camera devices and on v2-vintage recordings.
            var advertisedFormats: [AdvertisedFormat]?
            /// v3+ camera-only: the format AVCaptureSession actually
            /// selected, plus whether we managed to lock the frame rate.
            /// Nil on non-camera devices and on v2-vintage recordings.
            var selectedFormat: SelectedFormat?

            init(
                uniqueID: String,
                name: String,
                halInputLatencyMs: Double? = nil,
                advertisedFormats: [AdvertisedFormat]? = nil,
                selectedFormat: SelectedFormat? = nil
            ) {
                self.uniqueID = uniqueID
                self.name = name
                self.halInputLatencyMs = halInputLatencyMs
                self.advertisedFormats = advertisedFormats
                self.selectedFormat = selectedFormat
            }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(uniqueID, forKey: .uniqueID)
                try c.encode(name, forKey: .name)
                try c.encodeIfPresent(halInputLatencyMs, forKey: .halInputLatencyMs)
                try c.encodeIfPresent(advertisedFormats, forKey: .advertisedFormats)
                try c.encodeIfPresent(selectedFormat, forKey: .selectedFormat)
            }

            private enum CodingKeys: String, CodingKey {
                case uniqueID, name, halInputLatencyMs, advertisedFormats, selectedFormat
            }
        }

        /// v3+ trimmed camera advertised-format entry. One row per unique
        /// (width, height, maxFrameRate) — the full per-rate-range list
        /// stays in diagnostics.json. Nil minFrameRate / maxFrameRate
        /// when the device reported no rate ranges.
        struct AdvertisedFormat: Encodable {
            let width: Int
            let height: Int
            let pixelFormat: String
            let minFrameRate: Double
            let maxFrameRate: Double
        }

        /// v3+ post-`AVCaptureSession.startRunning()` snapshot of what
        /// format the camera ended up running. `didLockRate` is false
        /// when `1/targetFPS` wasn't strictly inside the format's rate
        /// range (e.g. Opal Tadpole's UVC quirk), in which case the
        /// camera runs at its own rate.
        struct SelectedFormat: Encodable {
            let width: Int
            let height: Int
            let pixelFormat: String
            let didLockRate: Bool
            let activeMinFrameDurationSeconds: Double
            let activeMaxFrameDurationSeconds: Double
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
enum JSONValue: Encodable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(v): try c.encode(v)
        case let .int(v): try c.encode(v)
        case let .double(v): try c.encode(v)
        case let .bool(v): try c.encode(v)
        }
    }
}

// MARK: - Builder

/// Mutable accumulator used during recording. Confined to `RecordingActor` —
/// all access is serialised by the actor. `@unchecked Sendable` so the builder
/// can be stored as actor state without tripping strict concurrency checks.
final class RecordingTimelineBuilder: @unchecked Sendable {
    private var sessionId: String = ""
    private var slug: String = ""
    private var initialMode: RecordingMode = .screenAndCamera
    private var initialPipPosition: PipPosition = .bottomRight
    private var startedAt: Date?
    private var endedAt: Date?
    private var durationSeconds: Double?
    private var inputs: RecordingTimeline.Inputs = .init(display: nil, camera: nil, microphone: nil)
    private var preset: OutputPreset = .default
    private var fps: Int32 = FrameRate.thirtyFPS.rawValue
    private var rawScreen: RecordingTimeline.RawStreams.VideoStream?
    private var rawCamera: RecordingTimeline.RawStreams.VideoStream?
    private var rawAudio: RecordingTimeline.RawStreams.AudioStream?
    private var exclusions: RecordingTimeline.Exclusions?
    private var renderErrorCount: Int = 0
    private var stallTimeoutCount: Int = 0
    private var rebuildSuccessCount: Int = 0
    private var terminalCompositionFailure: Bool = false
    private var runtime: RecordingTimeline.Runtime?
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

    func setSession(id: String, slug: String, initialMode: RecordingMode, initialPipPosition: PipPosition) {
        self.sessionId = id
        self.slug = slug
        self.initialMode = initialMode
        self.initialPipPosition = initialPipPosition
    }

    func setPreset(_ preset: OutputPreset, fps: Int32 = FrameRate.thirtyFPS.rawValue) {
        self.preset = preset
        self.fps = fps
    }

    func setExclusions(_ exclusions: RecordingTimeline.Exclusions?) {
        self.exclusions = exclusions
    }

    func setRawScreen(filename: String, width: Int, height: Int, codec: String, bitrate: Int, bytes: Int64, failed: Bool = false) {
        rawScreen = .init(
            filename: filename,
            width: width,
            height: height,
            videoCodec: codec,
            bitrate: bitrate,
            bytes: bytes,
            failed: failed ? true : nil
        )
    }

    func setRawCamera(filename: String, width: Int, height: Int, codec: String, bitrate: Int, bytes: Int64, failed: Bool = false) {
        rawCamera = .init(
            filename: filename,
            width: width,
            height: height,
            videoCodec: codec,
            bitrate: bitrate,
            bytes: bytes,
            failed: failed ? true : nil
        )
    }

    func setRawAudio(filename: String, codec: String, bitrate: Int, sampleRate: Int, channels: Int, bytes: Int64, failed: Bool = false) {
        rawAudio = .init(
            filename: filename,
            audioCodec: codec,
            bitrate: bitrate,
            sampleRate: sampleRate,
            channels: channels,
            bytes: bytes,
            failed: failed ? true : nil
        )
    }

    func setInputs(
        display: RecordingTimeline.Inputs.Display?,
        camera: RecordingTimeline.Inputs.Device?,
        microphone: RecordingTimeline.Inputs.Device?
    ) {
        self.inputs = .init(display: display, camera: camera, microphone: microphone)
    }

    /// Phase 4 (task-21): attach the camera's advertised + selected
    /// format details to the existing `inputs.camera` entry. Called
    /// after camera capture has actually started and we know what
    /// AVCaptureSession picked.
    func setCameraFormatDetails(
        advertised: [RecordingTimeline.Inputs.AdvertisedFormat]?,
        selected: RecordingTimeline.Inputs.SelectedFormat?
    ) {
        guard var camera = inputs.camera else { return }
        camera.advertisedFormats = advertised
        camera.selectedFormat = selected
        self.inputs = .init(display: inputs.display, camera: camera, microphone: inputs.microphone)
    }

    /// Phase 4: aggregate runtime metrics computed at stop time from
    /// diagnostic histograms + counters.
    func setRuntime(_ runtime: RecordingTimeline.Runtime) {
        self.runtime = runtime
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

    func recordPipPositionChanged(from: PipPosition, to: PipPosition, t: Double) {
        appendEvent(
            t: t,
            kind: "pip.position.changed",
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

    /// Called when a raw stream writer begins accepting samples.
    func recordRawWriterStarted(file: String, t: Double) {
        appendEvent(
            t: t,
            kind: "raw.writer.started",
            data: ["file": .string(file)]
        )
    }

    /// Called when a raw stream writer finished in `.failed` state — the file
    /// is truncated and unplayable. Records a timeline event for diagnostics.
    func recordRawWriterFailed(file: String, error: String, t: Double) {
        appendEvent(
            t: t,
            kind: "raw.writer.failed",
            data: [
                "file": .string(file),
                "error": .string(error),
            ]
        )
    }

    // MARK: - Source Failure Events

    func recordSourceFailed(source: String, error: String, t: Double) {
        appendEvent(
            t: t,
            kind: "source.\(source).failed",
            data: ["error": .string(error)]
        )
    }

    func recordSourceStale(source: String, t: Double, staleDuration: Double) {
        appendEvent(
            t: t,
            kind: "source.\(source).stale",
            data: ["staleDurationSeconds": .double(staleDuration)]
        )
    }

    func recordSourceRecovered(source: String, t: Double) {
        appendEvent(t: t, kind: "source.\(source).recovered", data: nil)
    }

    func recordHLSWriterFailed(error: String, t: Double) {
        appendEvent(
            t: t,
            kind: "writer.hls.failed",
            data: ["error": .string(error)]
        )
    }

    /// Logged when the camera + mic shared session dies and HLS audio
    /// failover routes through the standalone mic instead. Forensic only —
    /// the user is already alerted via the camera-failed warning.
    func recordAudioFailover(reason: String, t: Double) {
        appendEvent(
            t: t,
            kind: "audio.failover",
            data: ["reason": .string(reason)]
        )
    }

    /// Phase 3 keep-alive emit (one per static run, not per tick). Fired
    /// when the source has been static for ≥ `keepAliveThresholdSeconds`
    /// and the metronome emits a synthetic-PTS repeat of the last cached
    /// frame to keep HLS segments well-formed.
    func recordKeepaliveEmitted(staleDurationSeconds: Double, t: Double) {
        appendEvent(
            t: t,
            kind: "keepalive.emitted",
            data: ["staleDurationSeconds": .double(staleDurationSeconds)]
        )
    }

    /// Phase 4: the encoder-level monotonicity safety net rejected a
    /// frame. Should never fire post task-21 — the source-PTS freshness
    /// check is the primary defence. Any non-zero count in a recording
    /// is a regression hint. `branch` is the composite-mode label
    /// (`"pop"`, `"skipStale"`, etc.) so forensics can tell where the
    /// rejection originated.
    func recordMonotonicityRejected(deltaMs: Double, branch: String, t: Double) {
        appendEvent(
            t: t,
            kind: "monotonicity.rejected",
            data: [
                "deltaMs": .double(deltaMs),
                "branch": .string(branch),
            ]
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
                initialPipPosition: initialPipPosition.rawValue,
                startedAt: startedAt.map { Self.isoFormatter.string(from: $0) } ?? "",
                endedAt: endedAt.map { Self.isoFormatter.string(from: $0) },
                durationSeconds: durationSeconds,
                exclusions: exclusions
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
            encoder: Self.currentEncoder(preset: preset, fps: fps),
            rawStreams: (rawScreen == nil && rawCamera == nil && rawAudio == nil)
                ? nil
                : .init(screen: rawScreen, camera: rawCamera, audio: rawAudio),
            compositionStats: compositionStatsIfInteresting(),
            runtime: runtime,
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

    private static func currentEncoder(preset: OutputPreset, fps: Int32) -> RecordingTimeline.EncoderInfo {
        let frameRate = FrameRate(rawValue: fps) ?? .thirtyFPS
        let effectiveBitrate = Int(Double(preset.bitrate) * frameRate.bitrateMultiplier)
        return .init(
            videoCodec: "h264",
            videoProfile: "High",
            videoBitrate: effectiveBitrate,
            audioCodec: "aac-lc",
            audioBitrate: 128_000,
            targetFPS: Int(fps),
            outputWidth: preset.width,
            outputHeight: preset.height,
            segmentIntervalSeconds: 4.0
        )
    }
}
