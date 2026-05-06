import Foundation

/// A warning surfaced to the user during recording when a capture source
/// fails, goes stale, or the HLS writer enters a failed state.
struct RecordingWarning: Identifiable, Equatable {
    let id: Kind
    let severity: Severity
    let message: String
    let dismissible: Bool

    enum Severity {
        /// Source completely lost, data at risk.
        case critical
        /// Degraded but still recording something useful.
        case warning
    }

    /// Stable identity per warning type so the UI can deduplicate and animate
    /// transitions. Using the kind as the id means at most one warning of each
    /// type is active at a time.
    enum Kind: Hashable {
        case screenFailed
        case screenStale
        case cameraFailed
        case cameraStale
        case audioFailed
        case audioMissing
        case hlsWriterFailed
        case focusedWindowHidden
    }
}
