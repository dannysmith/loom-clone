import Foundation

/// Output resolution + bitrate for the composited HLS stream.
///
/// This is what the encoder produces and what viewers stream — independent of
/// capture resolution. Capture sources (screen, camera) run at their native
/// resolution and the compositor scales down to this preset.
struct OutputPreset: Equatable, Hashable, Identifiable {
    let id: String
    let label: String
    let width: Int
    let height: Int
    let bitrate: Int // bits per second

    static let p720 = OutputPreset(
        id: "720p",
        label: "720p",
        width: 1280,
        height: 720,
        bitrate: 2_500_000
    )

    static let p1080 = OutputPreset(
        id: "1080p",
        label: "1080p",
        width: 1920,
        height: 1080,
        bitrate: 6_000_000
    )

    /// QHD / 1440p. Chosen as the top preset rather than 4K: at 4K the
    /// composited HLS writer overloads the M2 Pro H.264 engine when running
    /// alongside the raw camera writer and causes CIContext GPU timeouts.
    /// 1440p is 1.78× the pixel count of 1080p (vs 4× for 4K) and well within
    /// the H.264 engine's headroom. Raw master files (screen.mov, camera.mp4)
    /// still capture at native resolution regardless of this preset — this
    /// only bounds the composited HLS stream that gets uploaded for instant
    /// playback.
    static let p1440 = OutputPreset(
        id: "1440p",
        label: "1440p",
        width: 2560,
        height: 1440,
        bitrate: 10_000_000
    )

    static let all: [OutputPreset] = [.p720, .p1080, .p1440]
    static let `default`: OutputPreset = .p1080

    static func fromID(_ id: String) -> OutputPreset {
        all.first(where: { $0.id == id }) ?? .default
    }
}
