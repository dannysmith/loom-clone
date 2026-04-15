import Foundation
import os

/// Thread-safe holder for the current `CameraAdjustments`. A single instance
/// is owned by `RecordingCoordinator` and shared (by reference) with:
///
/// - `CompositionActor` — reads on every frame to decide whether to apply
///   filters on the composited HLS path.
/// - `CameraPreviewLayerView` — reads on every enqueue, for both the popover
///   preview and the on-screen overlay window.
///
/// Shared state rather than per-consumer snapshots so a slider drag takes
/// effect immediately on all three surfaces without each consumer needing an
/// actor hop to pick up the new value.
final class CameraAdjustmentsState: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<CameraAdjustments>(initialState: .default)

    var value: CameraAdjustments {
        get { lock.withLock { $0 } }
        set { lock.withLock { $0 = newValue } }
    }
}
