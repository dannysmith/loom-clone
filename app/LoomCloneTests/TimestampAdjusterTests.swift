import CoreMedia
@testable import LoomClone
import XCTest

final class TimestampAdjusterTests: XCTestCase {
    func testDefaultPrimingOffset() {
        let adjuster = TimestampAdjuster()
        XCTAssertEqual(adjuster.primingOffset.seconds, 10.0, accuracy: 0.001)
    }

    func testCustomPrimingOffset() {
        let offset = CMTime(seconds: 5, preferredTimescale: 600)
        let adjuster = TimestampAdjuster(primingOffset: offset)
        XCTAssertEqual(adjuster.primingOffset.seconds, 5.0, accuracy: 0.001)
    }

    func testPauseAccumulatorStartsAtZero() {
        let adjuster = TimestampAdjuster()
        XCTAssertEqual(adjuster.pauseAccumulator.seconds, 0, accuracy: 0.001)
    }

    func testSinglePauseResumeCycle() {
        var adjuster = TimestampAdjuster()
        let pauseAt = CMTime(seconds: 2, preferredTimescale: 600)
        let resumeAt = CMTime(seconds: 5, preferredTimescale: 600)

        adjuster.markPause(at: pauseAt)
        adjuster.markResume(at: resumeAt)

        XCTAssertEqual(adjuster.pauseAccumulator.seconds, 3.0, accuracy: 0.001)
    }

    func testMultiplePauseResumeCycles() {
        var adjuster = TimestampAdjuster()

        adjuster.markPause(at: CMTime(seconds: 1, preferredTimescale: 600))
        adjuster.markResume(at: CMTime(seconds: 3, preferredTimescale: 600))

        adjuster.markPause(at: CMTime(seconds: 5, preferredTimescale: 600))
        adjuster.markResume(at: CMTime(seconds: 8, preferredTimescale: 600))

        // 2s + 3s = 5s total paused
        XCTAssertEqual(adjuster.pauseAccumulator.seconds, 5.0, accuracy: 0.001)
    }

    func testResumeWithoutPauseIsNoOp() {
        var adjuster = TimestampAdjuster()
        adjuster.markResume(at: CMTime(seconds: 5, preferredTimescale: 600))
        XCTAssertEqual(adjuster.pauseAccumulator.seconds, 0, accuracy: 0.001)
    }
}
