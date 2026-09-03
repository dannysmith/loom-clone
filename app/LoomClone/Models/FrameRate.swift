import CoreMedia
import Foundation

/// Target frame rate for the output video timeline.
///
/// Orthogonal to `OutputPreset` (which owns resolution + base bitrate).
/// The effective bitrate for the composited HLS stream is
/// `preset.bitrate × frameRate.bitrateMultiplier`.
enum FrameRate: Int32, CaseIterable, Identifiable, Codable {
    case thirtyFPS = 30
    case sixtyFPS = 60

    var id: Int32 {
        rawValue
    }

    /// Bitrate scaling factor relative to the 30fps base. Apple's HLS
    /// Authoring Spec recommends ~1.4× for doubling the frame rate
    /// (corroborated by their published H.264 ladder: 1080p goes from
    /// ~7.8 Mbps @ 30fps to ~10.8 Mbps @ 60fps, a 1.38× ratio).
    var bitrateMultiplier: Double {
        switch self {
        case .thirtyFPS: 1.0
        case .sixtyFPS: 1.4
        }
    }

    var frameDuration: CMTime {
        CMTime(value: 1, timescale: rawValue)
    }

    var label: String {
        "\(rawValue) fps"
    }

    /// Minimum acceptable max frame rate when filtering capture formats.
    /// Uses a 1fps tolerance for NTSC cameras (29.97fps passes ≥ 29.0,
    /// 59.94fps passes ≥ 59.0).
    var minAcceptableRate: Double {
        Double(rawValue) - 1.0
    }

    /// Render a *measured* or *advertised* rate — any Double, not just the
    /// two selectable presets — for display. Whole rates stay whole
    /// ("30 fps"); NTSC-ish ones keep a single decimal ("29.9 fps") rather
    /// than showing the user 29.969999. `separator` is empty for the tighter
    /// inline contexts.
    static func formatMeasured(_ fps: Double, separator: String = " ") -> String {
        let rounded = (fps * 10).rounded() / 10
        let format = rounded == rounded.rounded() ? "%.0f" : "%.1f"
        return String(format: format, rounded) + separator + "fps"
    }
}
