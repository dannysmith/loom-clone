import Foundation

/// Output resolution + bitrate for the composited HLS stream.
///
/// This is what the encoder produces and what viewers stream — independent of
/// capture resolution. Capture sources (screen, camera) run at their native
/// resolution and the compositor scales down to this preset.
struct OutputPreset: Equatable, Hashable, Sendable, Identifiable {
    let id: String
    let label: String
    let width: Int
    let height: Int
    let bitrate: Int  // bits per second

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

    static let p4k = OutputPreset(
        id: "4k",
        label: "4K",
        width: 3840,
        height: 2160,
        bitrate: 18_000_000
    )

    static let all: [OutputPreset] = [.p720, .p1080, .p4k]
    static let `default`: OutputPreset = .p1080

    static func fromID(_ id: String) -> OutputPreset {
        all.first(where: { $0.id == id }) ?? .default
    }
}
