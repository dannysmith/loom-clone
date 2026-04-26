import Foundation

/// Which corner of the composited output the camera PiP circle is placed in.
/// Tracked during recording so dragging the on-screen overlay to a different
/// quadrant of the display moves the circle in the actual video output.
enum PipPosition: String, CaseIterable {
    case bottomRight
    case bottomLeft
    case topRight
    case topLeft

    /// Determine the quadrant from a point relative to a containing rect.
    /// Uses the centre of the rect as the dividing line.
    static func from(point: CGPoint, in rect: CGRect) -> PipPosition {
        let midX = rect.midX
        let midY = rect.midY
        let isRight = point.x >= midX
        let isTop = point.y >= midY
        switch (isRight, isTop) {
        case (true, true): return .topRight
        case (true, false): return .bottomRight
        case (false, true): return .topLeft
        case (false, false): return .bottomLeft
        }
    }
}
