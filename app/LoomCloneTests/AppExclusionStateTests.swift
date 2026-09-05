@testable import LoomClone
import XCTest

/// Unit tests for the app-exclusion decisions: when the capture filter should
/// be re-resolved, and what the focused-window warning should say. The
/// ScreenCaptureKit side (`RecordingActor+Exclusion`) is untestable without
/// real hardware; these are the parts that aren't.
final class AppExclusionStateTests: XCTestCase {
    // MARK: - Configuration

    func testDefaultsToInactive() {
        let state = AppExclusionState()
        XCTAssertFalse(state.isActive)
        XCTAssertTrue(state.excludedBundleIDs.isEmpty)
        XCTAssertFalse(state.hideDesktopIcons)
    }

    func testEitherExcludedAppsOrDesktopIconsMakesItActive() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.a"], hideDesktopIcons: false)
        XCTAssertTrue(state.isActive)

        state.configure(excludedBundleIDs: [], hideDesktopIcons: true)
        XCTAssertTrue(state.isActive)

        state.configure(excludedBundleIDs: [], hideDesktopIcons: false)
        XCTAssertFalse(state.isActive)
    }

    func testConfigureClearsPerRecordingBookkeeping() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.a"], hideDesktopIcons: true)
        XCTAssertEqual(state.focusChanged(to: "com.example.a"), .warn(bundleID: "com.example.a"))
        _ = state.shouldRefreshFilter()

        // A fresh recording starts with no standing warning and a reset throttle.
        state.configure(excludedBundleIDs: ["com.example.a"], hideDesktopIcons: true)
        XCTAssertEqual(state.focusChanged(to: "com.example.a"), .warn(bundleID: "com.example.a"))
        for _ in 1 ..< AppExclusionState.filterRefreshTickInterval {
            XCTAssertFalse(state.shouldRefreshFilter())
        }
        XCTAssertTrue(state.shouldRefreshFilter())
    }

    // MARK: - Filter refresh throttle

    func testFilterNeverRefreshesWithoutDesktopIconHiding() {
        // A plain app exclusion is re-resolved by the app-launch observer;
        // only the Finder browser-window exception list needs polling.
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.a"], hideDesktopIcons: false)
        for _ in 0 ..< (AppExclusionState.filterRefreshTickInterval * 3) {
            XCTAssertFalse(state.shouldRefreshFilter())
        }
    }

    func testFilterRefreshesEveryNthTick() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: [], hideDesktopIcons: true)
        let interval = AppExclusionState.filterRefreshTickInterval
        var refreshes = 0
        for _ in 0 ..< (interval * 3) where state.shouldRefreshFilter() {
            refreshes += 1
        }
        XCTAssertEqual(refreshes, 3)
    }

    // MARK: - Focused-window warning

    func testFocusOnAVisibleAppSaysNothing() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.hidden"], hideDesktopIcons: false)
        XCTAssertEqual(state.focusChanged(to: "com.example.visible"), .none)
    }

    func testFocusOnAHiddenAppWarnsOnce() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.hidden"], hideDesktopIcons: false)
        XCTAssertEqual(
            state.focusChanged(to: "com.example.hidden"),
            .warn(bundleID: "com.example.hidden")
        )
        // Idempotent while focus stays put — the health task calls this at 2 Hz.
        XCTAssertEqual(state.focusChanged(to: "com.example.hidden"), .none)
        XCTAssertEqual(state.focusChanged(to: "com.example.hidden"), .none)
    }

    func testFocusMovingBetweenHiddenAppsWarnsForTheNewApp() {
        // Same warning id, different app name. The caller just re-fires and the
        // coordinator replaces the standing warning in place — clearing first
        // raced the re-fire and could leave the pill down for good.
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.a", "com.example.b"], hideDesktopIcons: false)
        _ = state.focusChanged(to: "com.example.a")
        XCTAssertEqual(state.focusChanged(to: "com.example.b"), .warn(bundleID: "com.example.b"))
    }

    func testFocusMovingToAVisibleAppClearsTheWarning() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.hidden"], hideDesktopIcons: false)
        _ = state.focusChanged(to: "com.example.hidden")
        XCTAssertEqual(state.focusChanged(to: "com.example.visible"), .clear)
        // And only once — nothing left to clear.
        XCTAssertEqual(state.focusChanged(to: "com.example.visible"), .none)
    }

    func testAppWithNoBundleIDClearsTheWarning() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.hidden"], hideDesktopIcons: false)
        _ = state.focusChanged(to: "com.example.hidden")
        XCTAssertEqual(state.focusChanged(to: nil), .clear)
    }

    func testDesktopIconHidingAloneNeverWarnsAboutFocus() {
        // The desktop isn't an app you can focus, so it can never be the
        // reason the window you're looking at is missing from the recording.
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: [], hideDesktopIcons: true)
        XCTAssertEqual(state.focusChanged(to: "com.apple.finder"), .none)
    }

    func testReturningToAHiddenAppWarnsAgain() {
        var state = AppExclusionState()
        state.configure(excludedBundleIDs: ["com.example.hidden"], hideDesktopIcons: false)
        _ = state.focusChanged(to: "com.example.hidden")
        XCTAssertEqual(state.focusChanged(to: "com.example.visible"), .clear)
        XCTAssertEqual(
            state.focusChanged(to: "com.example.hidden"),
            .warn(bundleID: "com.example.hidden")
        )
    }
}
