import Foundation

// MARK: - HarnessConfig
//
// JSON-serialised test configuration. Decoded from the --config file on
// launch. Every field that affects the test must be here so the config
// is the single reproducible unit of "what did we actually run".
//
// Design intent:
// - Flat, boring, Codable. No inheritance, no generics. One file.
// - Tolerant to growth: new optional fields can be added without breaking
//   existing configs on disk.
// - Nothing here calls into AVFoundation. Building a HarnessConfig is
//   cheap and safe, so it can be done in --dry-run mode.

struct HarnessConfig: Codable, Sendable {

    /// Short name shown in logs and result summary. e.g. "T1.1-prores-4k-alone".
    let name: String

    /// Free-text description. Copied into result.json for archival context.
    let description: String?

    /// Tier label for the runner script: "tier-1", "tier-2", etc.
    /// The harness itself ignores this — the runner uses it to sort.
    let tier: String?

    /// How long the test should run, in seconds. Frames are generated for
    /// roughly this many seconds before the writers are told to finish.
    /// Watchdog deadline is `durationSeconds + watchdogGraceSeconds`.
    let durationSeconds: Double

    /// Extra seconds of grace on top of durationSeconds before the
    /// pthread watchdog fires and hard-kills the process with exit().
    /// Default 10s per task-0C doc.
    var watchdogGraceSeconds: Double = 10.0

    /// Target frame rate for the synthetic source. 30 fps matches the
    /// production pipeline.
    var frameRate: Int = 30

    /// Writer warm-up strategy. "serial" (default) mirrors the main app's
    /// `prepareRecording()` ordering: each writer's `startWriting()` runs
    /// and fully completes before the next one starts. "parallel" kicks
    /// every writer off at the same time via a `TaskGroup` — only useful
    /// for Tier 5 priority 7 (serialised-vs-parallel warm-up sweep).
    /// See task-1 tuning 2 for the rationale.
    var warmUp: String = "serial"

    /// Frame source configuration — synthetic by default.
    let source: SourceConfig

    /// Optional CIContext compositor stage. When nil, writers are fed
    /// directly from the source.
    let compositor: CompositorConfig?

    /// Writers to instantiate. Each one is independently configured and
    /// independently enable/disable-able by including/omitting it here.
    let writers: [WriterConfig]

    /// Expected result for this configuration, if the author of the config
    /// has an opinion. Purely informational — used by the runner summary.
    /// Values: "pass", "degraded", "fail", "fail-killed", "unknown".
    var expected: String = "unknown"

    // Swift's synthesised Codable treats defaulted `var` properties as
    // required at decode time — the Swift default only fires at
    // struct-construction time, not when decoding from JSON. That means
    // adding a new defaulted field to this schema would silently break
    // every existing config on disk. This custom decoder uses
    // `decodeIfPresent` for every defaulted field so new optional fields
    // can be added without a JSON migration, which is the "tolerant to
    // growth" property the file header calls out. `encode(to:)` is still
    // auto-synthesised.
    enum CodingKeys: String, CodingKey {
        case name, description, tier
        case durationSeconds, watchdogGraceSeconds
        case frameRate, warmUp
        case source, compositor, writers
        case expected
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decodeIfPresent(String.self, forKey: .description)
        self.tier = try c.decodeIfPresent(String.self, forKey: .tier)
        self.durationSeconds = try c.decode(Double.self, forKey: .durationSeconds)
        self.watchdogGraceSeconds = try c.decodeIfPresent(Double.self, forKey: .watchdogGraceSeconds) ?? 10.0
        self.frameRate = try c.decodeIfPresent(Int.self, forKey: .frameRate) ?? 30
        self.warmUp = try c.decodeIfPresent(String.self, forKey: .warmUp) ?? "serial"
        self.source = try c.decode(SourceConfig.self, forKey: .source)
        self.compositor = try c.decodeIfPresent(CompositorConfig.self, forKey: .compositor)
        self.writers = try c.decode([WriterConfig].self, forKey: .writers)
        self.expected = try c.decodeIfPresent(String.self, forKey: .expected) ?? "unknown"
    }
}

// MARK: - SourceConfig

struct SourceConfig: Codable, Sendable {

    /// "synthetic-screen" (420v YCbCr, matches main-app SCStream),
    /// "synthetic-screen-bgra" (32BGRA — explicit BGRA exception case),
    /// "synthetic-camera" (420v YCbCr),
    /// "synthetic-audio" (silent PCM for the audio writer),
    /// "real-screen" (ScreenCaptureKit, opt-in Tier 4),
    /// "real-camera" (AVCaptureSession, opt-in Tier 4).
    ///
    /// A single test may declare multiple sources via `additional`. This
    /// is the primary one that feeds the writers / compositor by default.
    let kind: String

    /// Output dimensions for a synthetic video source. Ignored for audio
    /// and real-capture sources (the latter uses its native resolution
    /// unless a width/height override is supplied).
    var width: Int?
    var height: Int?

    /// Content pattern: "solid", "gradient", "moving", "noise".
    /// Defaults to "moving" so the encoder isn't handed identical frames.
    var pattern: String = "moving"

    /// Colour space attachment tag on synthetic buffers:
    /// "srgb" (screen-like default), "p3", "rec709" (camera-like).
    var colorSpace: String = "srgb"

    /// Secondary sources (e.g. a camera-like stream alongside a
    /// screen-like stream for compositor tests).
    var additional: [SourceConfig]?

    // MARK: Real-capture device selection
    //
    // Ignored for synthetic sources. For real-capture sources, these
    // pin the test to a specific physical device so results are
    // reproducible. `--list-devices` on the harness binary enumerates
    // available IDs.

    /// `real-screen` only. CGDirectDisplayID of the display to capture.
    /// Overrides `displayName`. Default: `CGMainDisplayID()`.
    var displayID: UInt32?

    /// `real-screen` only. Case-insensitive prefix match against the
    /// display's `NSScreen.localizedName`. Used when `displayID` is
    /// absent.
    var displayName: String?

    /// `real-camera` only. AVCaptureDevice uniqueID (stable across
    /// launches — e.g. `"0x0000000000000000"` for a USB camera). Overrides
    /// `deviceName`. Default: `AVCaptureDevice.default(for: .video)`.
    var deviceUniqueID: String?

    /// `real-camera` only. Case-insensitive prefix match against
    /// `device.localizedName`. Used when `deviceUniqueID` is absent.
    var deviceName: String?

    /// `real-camera` only. Max height (in pixels) the selected format
    /// may deliver at ≥30fps. Defaults to unlimited; set this to cap
    /// high-res USB cameras at e.g. 720 for parity with the main app.
    var maxHeight: Int?
}

// MARK: - CompositorConfig

struct CompositorConfig: Codable, Sendable {

    let outputWidth: Int
    let outputHeight: Int

    /// Include a circular PiP camera overlay (expects a camera-like
    /// additional source).
    var includeCameraOverlay: Bool = false

    /// Use CILanczosScaleTransform for large downscales. When false, uses
    /// a cheap affine transform.
    var useLanczosScaling: Bool = true

    /// "render-to-bounds" (current main-app path) or "start-task"
    /// (task-0A Phase 3's proposed path). Controls which CIContext API
    /// the compositor uses.
    var renderMode: String = "render-to-bounds"
}

// MARK: - WriterConfig

struct WriterConfig: Codable, Sendable {

    /// "composited-hls", "raw-h264", "raw-prores", "raw-audio".
    let kind: String

    /// Friendly name shown in events and result.json. Must be unique
    /// within a run — used to derive output filenames.
    let name: String

    /// Output dimensions. For audio, ignored.
    var width: Int?
    var height: Int?

    /// Target bitrate, bits-per-second. Ignored for ProRes and audio.
    var bitrate: Int?

    /// Audio-only fields.
    var sampleRate: Int?
    var channels: Int?

    /// Optional VTCompressionSession / AVAssetWriterInput tuning knobs.
    /// See task-0C doc for the list of properties we want to be able
    /// to sweep. Kept as a free-form string->JSONValue dictionary so new
    /// keys can be added without schema changes.
    var tunings: [String: JSONValue]?
}

// MARK: - JSONValue
//
// Minimal Codable type for "any JSON scalar / array / object" used in
// the tunings field. Swift's built-in [String: Any] isn't Codable; this
// fills the gap without pulling in a third-party package.

enum JSONValue: Codable, Sendable {
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let i = try? c.decode(Int.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(
            in: c,
            debugDescription: "Unrecognised JSON value"
        )
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }

    var asBool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var asInt: Int? {
        if case .int(let i) = self { return i }
        if case .double(let d) = self { return Int(d) }
        return nil
    }
    var asString: String? { if case .string(let s) = self { return s }; return nil }
}

// MARK: - Loading

extension HarnessConfig {
    static func load(from url: URL) throws -> HarnessConfig {
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        return try decoder.decode(HarnessConfig.self, from: data)
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
