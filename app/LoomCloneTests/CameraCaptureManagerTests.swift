import CoreMedia
@testable import LoomClone
import XCTest

/// Unit tests for the pure-logic surface of `CameraCaptureManager`.
/// The AVCaptureSession lifecycle is impossible to test without device
/// hardware (and AVFrameRateRange has no public initialiser), so we test
/// the extracted predicate that decides whether the device-side lock will
/// succeed.
final class CameraCaptureManagerTests: XCTestCase {
    // MARK: - targetRateFits

    /// Continuous-range camera (built-in FaceTime HD / Opal / iPhone
    /// Continuity) — target is comfortably inside the range.
    func testTargetRateFitsContinuousRange() {
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 30, minRate: 1, maxRate: 60))
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 60, minRate: 1, maxRate: 60))
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 1, minRate: 1, maxRate: 60))
    }

    /// Discrete single-rate range (ZV-1 over USB, Cam Link 4K discrete rate
    /// list). Target equals the single supported rate.
    func testTargetRateFitsDiscreteExactMatch() {
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 30, minRate: 30, maxRate: 30))
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 60, minRate: 60, maxRate: 60))
    }

    /// NTSC fractional rates: a camera reporting 29.97 or 59.94 should
    /// accept a 30 / 60 target (the user-facing labels everyone uses).
    func testTargetRateFitsNTSCFractional() {
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 30, minRate: 29.97, maxRate: 29.97))
        XCTAssertTrue(CameraCaptureManager.targetRateFits(target: 60, minRate: 59.94, maxRate: 59.94))
    }

    /// Target outside the range — no match.
    func testTargetRateFitsRejectsOutOfRange() {
        XCTAssertFalse(CameraCaptureManager.targetRateFits(target: 60, minRate: 25, maxRate: 30))
        XCTAssertFalse(CameraCaptureManager.targetRateFits(target: 24, minRate: 25, maxRate: 30))
    }

    /// The 0.5fps tolerance must not falsely bridge adjacent standard rates.
    /// 25 and 30 are 5 apart — must never collide.
    func testTargetRateFitsToleranceDoesNotBridgeAdjacentStandardRates() {
        XCTAssertFalse(CameraCaptureManager.targetRateFits(target: 30, minRate: 25, maxRate: 25))
        XCTAssertFalse(CameraCaptureManager.targetRateFits(target: 25, minRate: 30, maxRate: 30))
        XCTAssertFalse(CameraCaptureManager.targetRateFits(target: 60, minRate: 50, maxRate: 50))
    }

    /// Cam Link 4K shape: format reports four discrete single-rate ranges.
    /// Exactly one matches the target.
    func testTargetRateFitsCamLinkDiscreteListExactlyOneMatches() {
        let ranges: [(min: Double, max: Double)] = [
            (60, 60),
            (50, 50),
            (30, 30),
            (25, 25),
        ]
        let target = 30.0
        let matches = ranges.filter { CameraCaptureManager.targetRateFits(target: target, minRate: $0.min, maxRate: $0.max) }
        XCTAssertEqual(matches.count, 1)
        XCTAssertEqual(matches.first?.min, 30)
    }

    // MARK: - shouldCapRate (the ZV-1 floor fix)

    /// ZV-1 over native USB: a single discrete 30-30 format, target 30. The
    /// format is rate-locked to the target, so setting the ceiling would drag
    /// the floor up to 30 and trigger the CMIO meltdown (#30). Must NOT cap.
    func testShouldCapRateZV1DiscreteLockedToTargetIsFalse() {
        XCTAssertFalse(CameraCaptureManager.shouldCapRate(formatMinRate: 30, formatMaxRate: 30, target: 30))
        // NTSC variant (29.97 reported) is still target-locked → no cap.
        XCTAssertFalse(CameraCaptureManager.shouldCapRate(formatMinRate: 29.97, formatMaxRate: 29.97, target: 30))
    }

    /// Cam Link 4K: format advertises 25-60 (multiple discrete rates). It can
    /// run slower than 30, so the ceiling is safe (floor stays at 25). Cap.
    func testShouldCapRateCamLinkHasHeadroomIsTrue() {
        XCTAssertTrue(CameraCaptureManager.shouldCapRate(formatMinRate: 25, formatMaxRate: 60, target: 30))
        XCTAssertTrue(CameraCaptureManager.shouldCapRate(formatMinRate: 25, formatMaxRate: 60, target: 60))
    }

    /// FaceTime / built-in: continuous 1-60. Plenty of headroom below target. Cap.
    func testShouldCapRateContinuousRangeIsTrue() {
        XCTAssertTrue(CameraCaptureManager.shouldCapRate(formatMinRate: 1, formatMaxRate: 60, target: 30))
    }

    /// A format that can exceed the target but not go below it (30-60). The
    /// camera can sustain 30, so capping at 30 is safe (no fabrication). Cap.
    func testShouldCapRateFasterOnlyHeadroomIsTrue() {
        XCTAssertTrue(CameraCaptureManager.shouldCapRate(formatMinRate: 30, formatMaxRate: 60, target: 30))
    }

    // MARK: - finiteSeconds

    /// A valid frame duration passes through unchanged.
    func testFiniteSecondsValidPassesThrough() {
        XCTAssertEqual(CameraCaptureManager.finiteSeconds(CMTime(value: 1, timescale: 30)), 1.0 / 30.0, accuracy: 1e-9)
        XCTAssertEqual(CameraCaptureManager.finiteSeconds(.zero), 0)
    }

    /// `kCMTimeInvalid` (an unset `activeVideoMaxFrameDuration` now that we
    /// don't set the floor) has NaN seconds — must be coerced to 0 so the
    /// diagnostics JSON encode doesn't choke on a non-finite float.
    func testFiniteSecondsInvalidBecomesZero() {
        XCTAssertEqual(CameraCaptureManager.finiteSeconds(.invalid), 0)
        XCTAssertEqual(CameraCaptureManager.finiteSeconds(.positiveInfinity), 0)
        XCTAssertEqual(CameraCaptureManager.finiteSeconds(.negativeInfinity), 0)
    }
}
