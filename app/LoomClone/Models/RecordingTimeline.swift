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
            let advertisedFormats: [AdvertisedFormat]?
            /// v3+ camera-only: the format AVCaptureSession actually
            /// selected, plus whether we managed to lock the frame rate.
            /// Nil on non-camera devices and on v2-vintage recordings.
            let selectedFormat: SelectedFormat?

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
