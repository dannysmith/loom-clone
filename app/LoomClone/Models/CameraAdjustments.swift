import Foundation

/// User-controlled camera adjustments applied live to the composited HLS
/// stream and every live preview surface, but *not* to the raw `camera.mp4`
/// master file. The raw file is always the sensor's natural output, so the
/// user can re-process it later if they change their mind about the
/// adjustments.
struct CameraAdjustments: Equatable, Sendable {
    /// Target white-balance temperature in Kelvin. The `CITemperatureAndTint`
    /// filter treats the image's current neutral as 6500 K and shifts it so
    /// the new neutral is `temperature` K. Values below 6500 warm the image,
    /// above cool it. Range enforced at the UI layer (2500–10000 K).
    var temperature: CGFloat

    /// Exposure offset in EV stops. Feeds directly to `CIExposureAdjust`'s
    /// `inputEV`. Range enforced at the UI layer (±2 EV).
    var brightness: CGFloat

    static let defaultTemperature: CGFloat = 6500
    static let defaultBrightness: CGFloat = 0

    static let `default` = CameraAdjustments(
        temperature: defaultTemperature,
        brightness: defaultBrightness
    )

    /// Fast-path check. When true, every downstream filter path can skip the
    /// render-and-re-wrap work and pass sample buffers through unchanged.
    var isDefault: Bool {
        temperature == Self.defaultTemperature && brightness == Self.defaultBrightness
    }
}
