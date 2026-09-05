import Foundation

/// The recording's app-exclusion configuration, plus the two pieces of
/// bookkeeping that ride along with it: the periodic filter-refresh throttle
/// and the focused-window warning state machine.
///
/// Pure value type — it holds no ScreenCaptureKit objects and performs no
/// queries. `RecordingActor+Exclusion` does the SCK work and uses this to
/// decide *when* to do it and *what to say*. That split is what makes the
/// throttle and the focus warning testable.
struct AppExclusionState {
    /// Bundle IDs the user chose to hide from the recording.
    private(set) var excludedBundleIDs: Set<String> = []

    /// Whether Finder's desktop icon windows are excluded. Finder itself is
    /// excluded and its *browser* windows re-included as exceptions, so the
    /// exception list has to be re-enumerated as windows open and close.
    private(set) var hideDesktopIcons: Bool = false

    /// Bundle ID of the app the focus warning is currently showing for, and
    /// the single source of truth for whether it's up. Don't split "which app"
    /// from "is it showing" into two variables — they can disagree, and then
    /// the state machine needs defensive re-fire branches to paper over it.
    private var warnedBundleID: String?

    /// Health-check ticks since the last filter refresh.
    private var refreshTicks = 0

    /// Refresh the capture filter every N health ticks. The health task runs
    /// at ~2 Hz, so 10 ticks is roughly every 5 seconds — often enough that a
    /// newly-opened Finder window is un-hidden promptly, rare enough that the
    /// `SCShareableContent` query never competes with the encode loop.
    static let filterRefreshTickInterval = 10

    init() {}

    /// Anything to exclude at all? When false the capture filter only needs
    /// our own app, and no `SCShareableContent` query is required.
    var isActive: Bool {
        !excludedBundleIDs.isEmpty || hideDesktopIcons
    }

    /// Set at prepare time from the user's selection. Also resets the
    /// per-recording bookkeeping.
    mutating func configure(excludedBundleIDs: Set<String>, hideDesktopIcons: Bool) {
        self.excludedBundleIDs = excludedBundleIDs
        self.hideDesktopIcons = hideDesktopIcons
        warnedBundleID = nil
        refreshTicks = 0
    }

    // MARK: - Periodic filter refresh

    /// Advance the throttle by one health tick. Returns true on the ticks
    /// where the capture filter should be re-resolved. Only desktop-icon
    /// hiding needs this — a plain app exclusion is re-resolved by the
    /// app-launch observer instead.
    mutating func shouldRefreshFilter() -> Bool {
        guard hideDesktopIcons else { return false }
        refreshTicks += 1
        return refreshTicks % Self.filterRefreshTickInterval == 0
    }

    // MARK: - Focused-window warning

    /// What the focused-window watcher should do this tick.
    enum FocusChange: Equatable {
        /// Warn that the focused app is hidden from the recording. Fires
        /// again with a new bundle ID when focus moves between two hidden
        /// apps; the caller re-fires the same warning id and the coordinator
        /// replaces the standing one in place.
        case warn(bundleID: String)
        /// Take the standing warning down — focus moved to a visible app, or
        /// there is nothing excluded any more.
        case clear
        /// Nothing changed.
        case none
    }

    /// Feed the frontmost app's bundle ID (nil when it can't be determined).
    /// Idempotent: calling repeatedly with the same focused app returns
    /// `.none` after the first warn.
    mutating func focusChanged(to bundleID: String?) -> FocusChange {
        // Desktop-icon hiding doesn't count here: the desktop isn't an app
        // the user can focus, so it can never be the reason a window is
        // invisible in the recording.
        guard !excludedBundleIDs.isEmpty else { return clearIfWarning() }
        guard let bundleID, excludedBundleIDs.contains(bundleID) else { return clearIfWarning() }
        guard warnedBundleID != bundleID else { return .none }
        warnedBundleID = bundleID
        return .warn(bundleID: bundleID)
    }

    private mutating func clearIfWarning() -> FocusChange {
        guard warnedBundleID != nil else { return .none }
        warnedBundleID = nil
        return .clear
    }
}
