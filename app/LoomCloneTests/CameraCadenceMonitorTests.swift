@testable import LoomClone
import XCTest

/// Unit tests for the camera capture-PTS cadence monitor. The monitor keys on
/// a *categorical* invariant — a healthy camera produces exactly zero
/// non-monotonic frames at any rate — so these tests assert the shape
/// (monotonic / VFR / dropped = healthy; backward / duplicate = degraded) plus
/// the debounce and recovery behaviour, not tuned numeric boundaries.
final class CameraCadenceMonitorTests: XCTestCase {
    // MARK: - Healthy feeds (no false positives)

    func testMonotonic30fpsIsHealthy() {
        var m = CameraCadenceMonitor()
        // 100 frames at a clean 30fps. Capture PTS and host clock advance
        // together.
        for i in 0 ..< 100 {
            let t = Double(i) / 30.0
            m.recordFrame(capturePTSSeconds: t, now: t)
        }
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
        XCTAssertFalse(m.evaluateHealth(now: 100.0 / 30.0))
    }

    func testMonotonic24fpsBelowTargetButSteadyIsHealthy() {
        // The re-scope's hard requirement: a camera at 24fps (steady, below a
        // 30fps target) must not trip the monitor — it only sees direction.
        var m = CameraCadenceMonitor()
        for i in 0 ..< 100 {
            let t = Double(i) / 24.0
            m.recordFrame(capturePTSSeconds: t, now: t)
        }
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
        XCTAssertFalse(m.evaluateHealth(now: 100.0 / 24.0))
    }

    func testHonestVFRIsHealthy() {
        // Irregular but always-forward gaps (honest VFR). Must stay healthy.
        let gaps = [0.030, 0.045, 0.020, 0.060, 0.033, 0.050, 0.025, 0.040]
        var m = CameraCadenceMonitor()
        var t = 0.0
        for _ in 0 ..< 10 {
            for g in gaps {
                t += g
                m.recordFrame(capturePTSSeconds: t, now: t)
            }
        }
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
        XCTAssertFalse(m.evaluateHealth(now: t))
    }

    func testDroppedFramesAreHealthy() {
        // A stuttering camera that drops frames produces large *forward* gaps —
        // a drop is not a corruption.
        let frames: [(Double, Double)] = [
            (0.000, 0.000),
            (0.033, 0.033),
            (0.500, 0.500), // big gap — dropped frames
            (0.533, 0.533),
            (1.200, 1.200), // another big gap
            (1.233, 1.233),
        ]
        var m = CameraCadenceMonitor()
        for f in frames {
            m.recordFrame(capturePTSSeconds: f.0, now: f.1)
        }
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
        XCTAssertFalse(m.evaluateHealth(now: 1.4))
    }

    func testFirstFrameNeverCounts() {
        var m = CameraCadenceMonitor()
        XCTAssertFalse(m.recordFrame(capturePTSSeconds: 5.0, now: 5.0))
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
    }

    func testInvalidNaNPTSDoesNotFalseFire() {
        // An invalid CMTime surfaces as a NaN seconds value; comparisons are
        // false so it must not register as non-monotonic.
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.0)
        XCTAssertFalse(m.recordFrame(capturePTSSeconds: .nan, now: 0.033))
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
    }

    // MARK: - Non-monotonic detection

    func testBackwardJumpIsNonMonotonic() {
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 1.0, now: 1.0)
        // Frame arrives ~2s in the past (the CMIO meltdown signature).
        XCTAssertTrue(m.recordFrame(capturePTSSeconds: -1.0, now: 1.033))
        XCTAssertEqual(m.totalNonMonotonicEvents, 1)
    }

    func testDuplicatePTSIsNonMonotonic() {
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 1.0, now: 1.0)
        // Exact-repeat / fabricated frame: zero gap.
        XCTAssertTrue(m.recordFrame(capturePTSSeconds: 1.0, now: 1.033))
        XCTAssertEqual(m.totalNonMonotonicEvents, 1)
    }

    func testSubMillisecondGapIsNonMonotonic() {
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 1.0, now: 1.0)
        // 0.5ms forward — physically impossible for a real camera.
        XCTAssertTrue(m.recordFrame(capturePTSSeconds: 1.0005, now: 1.033))
        XCTAssertEqual(m.totalNonMonotonicEvents, 1)
    }

    func testGapJustAboveThresholdIsHealthy() {
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 1.0, now: 1.0)
        // 2ms forward — above the 1ms threshold, so monotonic.
        XCTAssertFalse(m.recordFrame(capturePTSSeconds: 1.002, now: 1.033))
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
    }

    func testSustainedBackwardShiftFlagsEveryCatchUpFrame() {
        // The real ZV-1 meltdown signature (recording 2dee88cf): the timeline
        // jumps ~4s into the past, then runs *forward* at the normal interval.
        // Against the previous frame those catch-up frames look healthy (+33ms);
        // against the high-water mark every one is behind and must be flagged.
        // A previous-frame predicate counted the whole flood as ONE event and
        // never fired — this is the regression guard for that miss.
        var m = CameraCadenceMonitor()
        var now = 40.0
        // Healthy run establishes a high-water mark near 4.0s.
        for i in 0 ..< 4 {
            m.recordFrame(capturePTSSeconds: 3.9 + Double(i) * 0.033, now: now)
            now += 0.033
        }
        XCTAssertEqual(m.totalNonMonotonicEvents, 0)
        // Backward shift: ~4s in the past, then 32 frames each +33ms forward
        // from the corrupt one but all behind the high-water mark.
        var pts = 0.0
        for _ in 0 ..< 32 {
            XCTAssertTrue(m.recordFrame(capturePTSSeconds: pts, now: now))
            pts += 0.033
            now += 0.033
        }
        XCTAssertEqual(m.totalNonMonotonicEvents, 32)
        // Clustered well inside the window — the warning fires.
        XCTAssertTrue(m.evaluateHealth(now: now))
    }

    func testHealthyAdvanceAfterBackwardShiftDoesNotReFlag() {
        // Once the timeline climbs back above the old high-water mark, frames
        // are healthy again — the mark wasn't corrupted by the catch-up frames.
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 4.0, now: 40.0) // mark = 4.0
        XCTAssertTrue(m.recordFrame(capturePTSSeconds: 0.0, now: 40.033)) // behind
        XCTAssertTrue(m.recordFrame(capturePTSSeconds: 0.033, now: 40.066)) // still behind
        // A frame past the original mark is healthy again.
        XCTAssertFalse(m.recordFrame(capturePTSSeconds: 4.1, now: 40.1))
        XCTAssertEqual(m.totalNonMonotonicEvents, 2)
    }

    // MARK: - Debounce

    func testSingleEventDoesNotDegrade() {
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.0)
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.033) // 1 non-monotonic
        XCTAssertFalse(m.evaluateHealth(now: 0.05))
    }

    func testTwoEventsDoNotDegrade() {
        // degradeCount is 3 — two glitches are tolerated.
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.0)
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.033) // 1
        m.recordFrame(capturePTSSeconds: 0.5, now: 0.1)
        m.recordFrame(capturePTSSeconds: 0.5, now: 0.133) // 2
        XCTAssertFalse(m.evaluateHealth(now: 0.15))
    }

    func testThreeEventsInWindowDegrades() {
        var m = CameraCadenceMonitor()
        var t = 0.0
        var pts = 0.0
        // Produce 3 duplicate-PTS events within the window.
        for _ in 0 ..< 3 {
            m.recordFrame(capturePTSSeconds: pts, now: t)
            t += 0.033
            m.recordFrame(capturePTSSeconds: pts, now: t) // duplicate -> event
            t += 0.033
            pts += 0.5 // advance so the next pair is a fresh duplicate
        }
        XCTAssertGreaterThanOrEqual(m.totalNonMonotonicEvents, 3)
        XCTAssertTrue(m.evaluateHealth(now: t))
    }

    func testEventsSpreadBeyondWindowDoNotDegrade() {
        // 3 events but each separated by more than the window, so never 3
        // co-resident — must not degrade.
        var m = CameraCadenceMonitor()
        let window = CameraCadenceMonitor.windowS
        var pts = 0.0
        for i in 0 ..< 3 {
            let t = Double(i) * (window + 1.0)
            m.recordFrame(capturePTSSeconds: pts, now: t)
            m.recordFrame(capturePTSSeconds: pts, now: t + 0.01) // duplicate event
            pts += 0.5
            XCTAssertFalse(m.evaluateHealth(now: t + 0.02))
        }
    }

    // MARK: - Recovery (hysteresis)

    func testRecoversAfterQuietWindow() {
        var m = CameraCadenceMonitor()
        // Drive it degraded with 3 fast duplicate events.
        var t = 0.0
        var pts = 0.0
        for _ in 0 ..< 3 {
            m.recordFrame(capturePTSSeconds: pts, now: t)
            t += 0.01
            m.recordFrame(capturePTSSeconds: pts, now: t)
            t += 0.01
            pts += 0.5
        }
        XCTAssertTrue(m.evaluateHealth(now: t))

        // After a quiet period longer than the window with no new events, it
        // recovers.
        let later = t + CameraCadenceMonitor.windowS + 0.5
        XCTAssertFalse(m.evaluateHealth(now: later))
    }

    func testStaysDegradedWhileEventsPersistInWindow() {
        var m = CameraCadenceMonitor()
        var t = 0.0
        var pts = 0.0
        for _ in 0 ..< 3 {
            m.recordFrame(capturePTSSeconds: pts, now: t)
            t += 0.01
            m.recordFrame(capturePTSSeconds: pts, now: t)
            t += 0.01
            pts += 0.5
        }
        XCTAssertTrue(m.evaluateHealth(now: t))
        // A fresh event keeps the window non-empty — still degraded even a bit
        // later (hysteresis: only fully-quiet recovers).
        m.recordFrame(capturePTSSeconds: pts, now: t + 0.5)
        m.recordFrame(capturePTSSeconds: pts, now: t + 0.51)
        XCTAssertTrue(m.evaluateHealth(now: t + 0.6))
    }

    func testWindowedEventCountReflectsPrune() {
        var m = CameraCadenceMonitor()
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.0)
        m.recordFrame(capturePTSSeconds: 0.0, now: 0.01) // event at 0.01
        XCTAssertEqual(m.windowedEventCount, 1)
        // Evaluate well past the window — the event should be pruned out.
        XCTAssertFalse(m.evaluateHealth(now: CameraCadenceMonitor.windowS + 1.0))
        XCTAssertEqual(m.windowedEventCount, 0)
    }
}
