import Foundation

/// Staleness and hard-failure bookkeeping for the three capture sources.
///
/// The recording pipeline's *silence* watchdog: it answers "has this source
/// stopped delivering?". Its sibling `CameraCadenceMonitor` answers the
/// question a silence watchdog can't — "is this source delivering, but with a
/// corrupt timeline?".
///
/// Pure value type. It never reads a clock, never touches the timeline, and
/// never fires a warning; callers feed it host-clock seconds and act on the
/// `Transition`s it hands back. That's what makes the fire-once / clear /
/// re-fire dedup testable in isolation rather than woven through actor state.
///
/// Hard failure and staleness are tracked separately: a source that reported a
/// session error suppresses its own stale check, because the failure warning
/// is the more specific one and is already on screen.
struct SourceHealthTracker {
    /// The three capture sources. `rawValue` is the string used for `source`
    /// in `recording.json` events.
    enum Source: String, CaseIterable {
        case screen
        case camera
        case audio

        /// Seconds without delivery before the source counts as stale.
        /// Camera is tightest: at 30fps a 1s gap is ~30 missing frames, and
        /// the camera is the source most likely to be yanked mid-recording.
        var staleThreshold: Double {
            switch self {
            case .screen: 2.0
            case .camera: 1.0
            case .audio: 2.0
            }
        }

        var staleWarning: RecordingWarning.Kind {
            switch self {
            case .screen: .screenStale
            case .camera: .cameraStale
            case .audio: .audioMissing
            }
        }

        var failedWarning: RecordingWarning.Kind {
            switch self {
            case .screen: .screenFailed
            case .camera: .cameraFailed
            case .audio: .audioFailed
            }
        }
    }

    /// A change the caller must react to. Each case maps to exactly one
    /// timeline event plus one warning fire/clear.
    enum Transition: Equatable {
        /// Source crossed its staleness threshold. Fires once per stall.
        case wentStale(Source, staleSeconds: Double)
        /// Source delivered again after having been reported stale.
        case recovered(Source)
    }

    /// Host-clock seconds at the last delivery from each source. A source
    /// that has never delivered is absent, and is never reported stale — a
    /// source that failed to start at all is the prepare flow's problem, not
    /// the stall watchdog's.
    private var lastSeen: [Source: Double] = [:]

    /// The warnings this tracker owns. Exposed so the composite path can ask
    /// whether the camera is fit to render.
    private(set) var activeWarnings: Set<RecordingWarning.Kind> = []

    init() {}

    // MARK: - Ingest

    /// Record a delivery from `source` at host-clock `now`. Returns
    /// `.recovered` when this delivery cleared a standing stale warning.
    @discardableResult
    mutating func markReceived(_ source: Source, now: Double) -> Transition? {
        lastSeen[source] = now
        guard activeWarnings.remove(source.staleWarning) != nil else { return nil }
        return .recovered(source)
    }

    /// Record a hard failure (stream error, session error, interruption).
    /// Suppresses the source's stale check until it delivers again.
    mutating func markFailed(_ source: Source) {
        activeWarnings.insert(source.failedWarning)
    }

    // MARK: - Evaluate

    /// Check each source the active mode consumes against its threshold.
    /// A camera stall during a `screenOnly` stretch isn't worth warning
    /// about, so the caller passes only the sources currently in use.
    /// Fires at most once per stall; `markReceived` re-arms it.
    mutating func evaluate(now: Double, activeSources: Set<Source>) -> [Transition] {
        var transitions: [Transition] = []
        for source in Source.allCases where activeSources.contains(source) {
            guard !activeWarnings.contains(source.failedWarning),
                  !activeWarnings.contains(source.staleWarning),
                  let last = lastSeen[source]
            else { continue }
            let staleSeconds = now - last
            guard staleSeconds > source.staleThreshold else { continue }
            activeWarnings.insert(source.staleWarning)
            transitions.append(.wentStale(source, staleSeconds: staleSeconds))
        }
        return transitions
    }

    // MARK: - Queries

    /// True when the camera is known-failed or known-stale — i.e. its cached
    /// frame is not fit to go into the composite.
    var cameraIsUnusable: Bool {
        activeWarnings.contains(.cameraFailed) || activeWarnings.contains(.cameraStale)
    }
}
