@testable import LoomClone
import XCTest

/// Unit tests for the capture-source silence watchdog. The behaviour that
/// matters is the dedup contract: a stall warns exactly once, a delivery
/// clears it, and the same source can warn again on the next stall — plus the
/// mode gating that keeps an idle camera quiet during a screen-only stretch.
final class SourceHealthTrackerTests: XCTestCase {
    private let allSources: Set<SourceHealthTracker.Source> = [.screen, .camera, .audio]

    /// Sources reported stale by one `evaluate` call, in the order returned.
    private func stalled(_ transitions: [SourceHealthTracker.Transition]) -> [SourceHealthTracker.Source] {
        transitions.compactMap { transition in
            guard case let .wentStale(source, _) = transition else { return nil }
            return source
        }
    }

    /// How stale the single reported source was. Fails the test if the call
    /// reported anything other than exactly one stall.
    private func staleSeconds(_ transitions: [SourceHealthTracker.Transition]) -> Double {
        guard transitions.count == 1, case let .wentStale(_, seconds) = transitions[0] else {
            XCTFail("expected exactly one stall, got \(transitions)")
            return .nan
        }
        return seconds
    }

    // MARK: - Nothing to report

    func testSourceThatNeverDeliveredIsNeverStale() {
        // A source that never started is the prepare flow's problem. The
        // watchdog stays silent rather than firing at t = threshold.
        var tracker = SourceHealthTracker()
        XCTAssertTrue(tracker.evaluate(now: 1000, activeSources: allSources).isEmpty)
        XCTAssertTrue(tracker.activeWarnings.isEmpty)
    }

    func testFreshSourceIsNotStale() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.camera, now: 10)
        XCTAssertTrue(tracker.evaluate(now: 10.5, activeSources: allSources).isEmpty)
    }

    func testExactlyAtThresholdIsNotYetStale() {
        // The predicate is strictly-greater, so the boundary itself is healthy.
        var tracker = SourceHealthTracker()
        tracker.markReceived(.camera, now: 10)
        let atThreshold = 10 + SourceHealthTracker.Source.camera.staleThreshold
        XCTAssertTrue(tracker.evaluate(now: atThreshold, activeSources: allSources).isEmpty)
    }

    // MARK: - Going stale

    func testSourceGoesStalePastThreshold() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.camera, now: 10)
        let transitions = tracker.evaluate(now: 12, activeSources: allSources)
        XCTAssertEqual(stalled(transitions), [.camera])
        XCTAssertEqual(staleSeconds(transitions), 2, accuracy: 1e-9)
        XCTAssertTrue(tracker.activeWarnings.contains(.cameraStale))
    }

    func testStaleFiresOnlyOncePerStall() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.screen, now: 0)
        XCTAssertEqual(tracker.evaluate(now: 5, activeSources: allSources).count, 1)
        // Still stale, and getting staler — but the warning is already up.
        XCTAssertTrue(tracker.evaluate(now: 6, activeSources: allSources).isEmpty)
        XCTAssertTrue(tracker.evaluate(now: 60, activeSources: allSources).isEmpty)
    }

    func testEachSourceUsesItsOwnThreshold() {
        // At t+1.5s the camera (1s) is stale but the screen and audio (2s)
        // are not.
        var tracker = SourceHealthTracker()
        for source in SourceHealthTracker.Source.allCases {
            tracker.markReceived(source, now: 0)
        }
        XCTAssertEqual(stalled(tracker.evaluate(now: 1.5, activeSources: allSources)), [.camera])
    }

    func testMultipleSourcesCanGoStaleTogether() {
        var tracker = SourceHealthTracker()
        for source in SourceHealthTracker.Source.allCases {
            tracker.markReceived(source, now: 0)
        }
        let reported = stalled(tracker.evaluate(now: 10, activeSources: allSources))
        XCTAssertEqual(Set(reported), Set(SourceHealthTracker.Source.allCases))
    }

    // MARK: - Recovery and re-firing

    func testDeliveryAfterStaleReportsRecovery() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.audio, now: 0)
        XCTAssertFalse(tracker.evaluate(now: 5, activeSources: allSources).isEmpty)
        XCTAssertEqual(tracker.markReceived(.audio, now: 5.1), .recovered(.audio))
        XCTAssertFalse(tracker.activeWarnings.contains(.audioMissing))
    }

    func testDeliveryWithoutAStandingWarningReportsNothing() {
        var tracker = SourceHealthTracker()
        XCTAssertNil(tracker.markReceived(.audio, now: 0))
        XCTAssertNil(tracker.markReceived(.audio, now: 0.1))
    }

    func testSourceCanGoStaleAgainAfterRecovering() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.camera, now: 0)
        XCTAssertEqual(tracker.evaluate(now: 2, activeSources: allSources).count, 1)
        tracker.markReceived(.camera, now: 2.1)
        let transitions = tracker.evaluate(now: 4, activeSources: allSources)
        XCTAssertEqual(stalled(transitions), [.camera])
        XCTAssertEqual(staleSeconds(transitions), 1.9, accuracy: 1e-9)
    }

    // MARK: - Mode gating

    func testStallOfAnUnusedSourceIsNotReported() {
        // A camera left running through a screenOnly stretch keeps delivering
        // into the cadence monitor, but its silence is nobody's problem.
        var tracker = SourceHealthTracker()
        tracker.markReceived(.camera, now: 0)
        XCTAssertTrue(tracker.evaluate(now: 30, activeSources: [.screen, .audio]).isEmpty)
        XCTAssertTrue(tracker.activeWarnings.isEmpty)
    }

    func testSourceGoesStaleOnceItIsBackInUse() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.camera, now: 0)
        XCTAssertTrue(tracker.evaluate(now: 30, activeSources: [.screen, .audio]).isEmpty)
        // Mode switch brings the camera back into the composite.
        XCTAssertEqual(tracker.evaluate(now: 31, activeSources: allSources).count, 1)
    }

    // MARK: - Hard failures

    func testFailureSuppressesTheStaleCheck() {
        // The failure warning is the more specific one and is already on
        // screen — a stale warning behind it would be noise.
        var tracker = SourceHealthTracker()
        tracker.markReceived(.screen, now: 0)
        tracker.markFailed(.screen)
        XCTAssertTrue(tracker.evaluate(now: 100, activeSources: allSources).isEmpty)
        XCTAssertTrue(tracker.activeWarnings.contains(.screenFailed))
        XCTAssertFalse(tracker.activeWarnings.contains(.screenStale))
    }

    func testFailureOfOneSourceDoesNotSuppressAnother() {
        var tracker = SourceHealthTracker()
        tracker.markReceived(.screen, now: 0)
        tracker.markReceived(.camera, now: 0)
        tracker.markFailed(.screen)
        XCTAssertEqual(
            tracker.evaluate(now: 5, activeSources: allSources).count,
            1,
            "camera should still be able to go stale"
        )
    }

    // MARK: - Composite gating

    func testCameraIsUsableUntilItFailsOrStalls() {
        var tracker = SourceHealthTracker()
        XCTAssertFalse(tracker.cameraIsUnusable)

        tracker.markReceived(.camera, now: 0)
        _ = tracker.evaluate(now: 5, activeSources: allSources)
        XCTAssertTrue(tracker.cameraIsUnusable, "a stale camera must not go into the composite")

        tracker.markReceived(.camera, now: 5.1)
        XCTAssertFalse(tracker.cameraIsUnusable)

        tracker.markFailed(.camera)
        XCTAssertTrue(tracker.cameraIsUnusable)
    }
}
