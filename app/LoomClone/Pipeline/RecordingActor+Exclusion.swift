import AppKit
import ScreenCaptureKit

extension RecordingActor {
    // MARK: - App Exclusion

    //
    // Everything that turns the user's "hide these apps" selection into a live
    // ScreenCaptureKit content filter. The decisions — when to refresh, what
    // to say about a focused hidden app — live in `AppExclusionState`; this
    // file is the ScreenCaptureKit glue around them.

    /// Build the app and window exclusion lists for the screen capture filter
    /// from a fresh `SCShareableContent` query.
    ///
    /// Callers pass `ourApp` when they already have a handle from an earlier
    /// query (prepare resolves the display and our own app in one go); the
    /// mid-recording refresh passes nil and we find ourselves in the content
    /// we just fetched. Either way our own app is always excluded.
    func resolveExclusions(
        ourApp: SCRunningApplication?
    ) async -> (apps: [SCRunningApplication], exceptingWindows: [SCWindow]) {
        var appsToExclude: [SCRunningApplication] = []
        if let ourApp { appsToExclude.append(ourApp) }

        // Nothing configured — the filter only needs our own app. Skip the
        // query when the caller already handed us that (the prepare path
        // always does), saving a second `SCShareableContent` round-trip in
        // the common case. Without a handle we still have to query, or we'd
        // hand back a filter that doesn't exclude LoomClone's own windows.
        if !exclusion.isActive, ourApp != nil { return (appsToExclude, []) }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            Log.exclusion.log("SCShareableContent query failed: \(error)")
            return (appsToExclude, [])
        }

        if ourApp == nil,
           let us = content.applications.first(where: { $0.processID == ProcessInfo.processInfo.processIdentifier })
        {
            appsToExclude.append(us)
        }

        // User-selected apps
        for app in content.applications where exclusion.excludedBundleIDs.contains(app.bundleIdentifier) {
            appsToExclude.append(app)
            Log.exclusion.log("Excluding \(app.bundleIdentifier) (pid: \(app.processID))")
        }

        var exceptingWindows: [SCWindow] = []

        // Desktop icons: exclude Finder, but re-include its browser windows
        if exclusion.hideDesktopIcons {
            if let finder = content.applications.first(where: { $0.bundleIdentifier == "com.apple.finder" }) {
                if !appsToExclude.contains(where: { $0.processID == finder.processID }) {
                    appsToExclude.append(finder)
                    Log.exclusion.log("Excluding Finder for desktop icons")
                }
                // Re-include Finder windows at normal window level (browser windows).
                // Desktop icon windows sit at kCGDesktopIconWindowLevel and stay excluded.
                exceptingWindows = content.windows.filter {
                    $0.owningApplication?.processID == finder.processID && $0.windowLayer == 0
                }
                if !exceptingWindows.isEmpty {
                    Log.exclusion.log("Excepting \(exceptingWindows.count) Finder browser window(s)")
                }
            }
        }

        return (appsToExclude, exceptingWindows)
    }

    /// Re-resolve exclusions and push the result onto the live stream filter.
    /// Called when an excluded app launches mid-recording, and periodically to
    /// pick up newly-opened Finder browser windows.
    func updateExcludedApps() async {
        guard modeUsesScreen else { return }
        let (apps, exceptingWindows) = await resolveExclusions(ourApp: nil)
        do {
            try await screenCapture.updateFilter(excludingApps: apps, exceptingWindows: exceptingWindows)
        } catch {
            Log.exclusion.log("Filter update failed: \(error)")
        }
    }

    /// Called once per health-check tick. Refreshes the capture filter on the
    /// ticks the throttle says are due.
    func tickFilterRefresh() async {
        guard exclusion.shouldRefreshFilter() else { return }
        await updateExcludedApps()
    }

    // MARK: - Focused Window Visibility

    /// Warn when the window the user is looking at won't be in the recording.
    /// Hops to MainActor to read `NSWorkspace`, then hands the bundle ID to
    /// the state machine and dispatches whatever it decides.
    func checkFocusedWindowVisibility() async {
        guard isRecording, !isStopping else { return }

        let frontmost = await MainActor.run {
            NSWorkspace.shared.frontmostApplication.map {
                (bundleID: $0.bundleIdentifier, name: $0.localizedName ?? "App")
            }
        }
        // Nothing is frontmost — no evidence either way, so leave any standing
        // warning alone rather than flickering it off and back on.
        guard let frontmost else { return }

        switch exclusion.focusChanged(to: frontmost.bundleID) {
        case .warn:
            fireWarning(.init(
                id: .focusedWindowHidden,
                severity: .warning,
                message: "\(frontmost.name) is hidden from recording",
                dismissible: false
            ))
        case .clear:
            clearWarning(.focusedWindowHidden)
        case .none:
            break
        }
    }
}
