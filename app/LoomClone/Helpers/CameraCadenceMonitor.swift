import Foundation

/// Detects the camera-capture-PTS corruption that the CMIO synchronizer
/// meltdown (#30 / #44) produces — frames that keep arriving at roughly the
/// right *rate* while carrying **non-monotonic capture timestamps** (jumping
/// backward, repeating, or fabricated). That broken timeline is the A/V desync,
/// and the existing source-health watchdogs are blind to it because the camera
/// never goes fully silent.
///
/// The signal is a direct question asked at the source, keyed on the one
/// invariant the whole pipeline rests on:
///
/// > Video PTS = the camera frame's hardware capture time. A/V sync is *defined*
/// > by trusting that the camera's capture-PTS timeline advances monotonically.
///
/// So: **does each frame's capture PTS advance past the highest PTS seen so
/// far — its high-water mark?** A real camera at any rate (24 / 25 / 29.97 /
/// 30 / 60 / honest VFR) produces forward-advancing PTS; a dropped/stuttering
/// frame produces a *large forward* gap (also fine). Only a frame that fails to
/// advance past the high-water mark — by ≤ `nonMonotonicGapThresholdS`, which
/// covers backward jumps, zero gaps, and duplicate/fabricated PTS — is a
/// violation. This is rate-agnostic and VFR-safe by construction: a healthy
/// camera produces **exactly zero** non-monotonic frames.
///
/// The reference is the **high-water mark**, not the immediately-previous
/// frame, and that distinction is load-bearing — confirmed against a real ZV-1
/// meltdown (recording `2dee88cf`, 2026-06-09). The meltdown's severe form is
/// not sub-millisecond jitter but a *sustained backward shift*: the timeline
/// jumps ~4s into the past, then runs *forward* at the normal frame interval
/// from there. Against the previous frame those catch-up frames look healthy
/// (+33ms forward); against the high-water mark every one of them is behind,
/// which is what actually desyncs the output (the encoder's own monotonicity
/// guard uses the same high-water comparison). A previous-frame predicate
/// counted that 32-frame flood as a single event and never fired.
///
/// The numbers below are **debounce / fluke-protection on a categorical
/// signal**, not calibrated discriminators — see
/// `docs/tasks-todo/task-2-live-quality-degradation-warning.md` ("Design",
/// Part 1). The data confirms the *shape* (healthy = monotonic; corruption =
/// non-monotonic); it does not source these thresholds. Bias is toward zero
/// false positives over catching every mild burst.
///
/// Pure value type so it can be unit-tested in isolation and shared by both the
/// recording pipeline (`RecordingActor`) and the pre-record preview
/// (`CameraPreviewManager`). Times are passed in as seconds on a monotonic
/// host clock; the monitor never reads a real clock itself.
struct CameraCadenceMonitor {
    // MARK: - Tuning (debounce, not calibration)

    /// A capture-PTS gap at or below this counts as non-monotonic. Covers
    /// backward jumps (negative gap), exact repeats (zero), and the
    /// sub-millisecond fabricated PTS CMIO emits during a meltdown. A real
    /// camera frame is never this close to its predecessor at any rate.
    static let nonMonotonicGapThresholdS: Double = 0.001

    /// Length of the trailing window over which non-monotonic events are
    /// counted. Also serves as the recovery quiet-period: once the window
    /// empties, the feed is considered healthy again.
    static let windowS: Double = 3.0

    /// Number of non-monotonic events within the window required to flag the
    /// feed as degraded. Small, so a single fluke can't fire; > 1 so a lone
    /// glitch is tolerated.
    static let degradeCount: Int = 3

    // MARK: - State

    /// Whether the feed is currently considered degraded. Hysteretic: set when
    /// the window reaches `degradeCount`, cleared only when the window is fully
    /// quiet (no non-monotonic event for `windowS`).
    private(set) var isDegraded: Bool = false

    /// Lifetime count of non-monotonic events seen. Surfaced for forensic
    /// instrumentation; not used in the health decision.
    private(set) var totalNonMonotonicEvents: Int64 = 0

    /// Highest capture PTS (seconds) seen so far — the high-water mark every
    /// frame is judged against. Only ever advances. Nil until the first valid
    /// frame.
    private var maxCapturePTS: Double?

    /// Host-clock timestamps (seconds) of recent non-monotonic events, pruned
    /// to the trailing window.
    private var eventTimes: [Double] = []

    init() {}

    /// Number of non-monotonic events currently inside the trailing window.
    /// Reflects the last `prune` (i.e. the most recent `recordFrame` /
    /// `evaluateHealth`). Reported in the degraded timeline event.
    var windowedEventCount: Int {
        eventTimes.count
    }

    // MARK: - Ingest

    /// Feed one camera frame's capture PTS (seconds) plus the host-clock time
    /// (seconds) at which it arrived. Returns `true` if this frame was a
    /// non-monotonic event — i.e. it failed to advance past the high-water
    /// mark. The window uses host time — not capture PTS — because capture PTS
    /// is precisely the thing that's corrupt during a meltdown; timing the
    /// window with it would be circular.
    @discardableResult
    mutating func recordFrame(capturePTSSeconds pts: Double, now: Double) -> Bool {
        prune(now: now)
        guard let maxSeen = maxCapturePTS else {
            // First valid frame establishes the high-water mark.
            if !pts.isNaN { maxCapturePTS = pts }
            return false
        }
        let gap = pts - maxSeen
        // Healthy: advanced meaningfully past the high-water mark. NaN gap (an
        // invalid PTS) is not `> threshold`, so it falls through and is
        // discarded below rather than advancing the mark or firing.
        if gap > Self.nonMonotonicGapThresholdS {
            maxCapturePTS = pts
            return false
        }
        // A garbage (NaN) timestamp must never false-fire and must not corrupt
        // the high-water mark.
        if gap.isNaN { return false }
        // Non-monotonic: at, below, or barely above the highest PTS seen — a
        // backward jump (incl. the sustained catch-up after a backward shift),
        // a duplicate, or a sub-ms fabricated creep. The mark is left untouched.
        eventTimes.append(now)
        totalNonMonotonicEvents += 1
        return true
    }

    // MARK: - Evaluate

    /// Recompute health at `now` (seconds, host clock) and return the current
    /// degraded state. Call from a low-frequency timer (recording) or per
    /// delivered frame (preview). Schmitt-trigger hysteresis: flags degraded at
    /// `degradeCount` events in-window, recovers only once the window is fully
    /// quiet — so it won't flap around the threshold.
    @discardableResult
    mutating func evaluateHealth(now: Double) -> Bool {
        prune(now: now)
        if isDegraded {
            if eventTimes.isEmpty { isDegraded = false }
        } else if eventTimes.count >= Self.degradeCount {
            isDegraded = true
        }
        return isDegraded
    }

    // MARK: - Internals

    /// Drop events older than the trailing window.
    private mutating func prune(now: Double) {
        let cutoff = now - Self.windowS
        if eventTimes.isEmpty { return }
        if let firstFresh = eventTimes.firstIndex(where: { $0 >= cutoff }) {
            if firstFresh > 0 { eventTimes.removeFirst(firstFresh) }
        } else {
            eventTimes.removeAll(keepingCapacity: true)
        }
    }
}
