@testable import LoomClone
import XCTest

final class RecordingModeTests: XCTestCase {
    func testNextCyclesThroughAllModes() {
        let start = RecordingMode.cameraOnly
        var mode = start
        var visited: [RecordingMode] = [mode]
        for _ in 0 ..< RecordingMode.allCases.count {
            mode = mode.next()
            visited.append(mode)
        }
        // After cycling through all modes, we're back to the start
        XCTAssertEqual(visited.last, start)
        // We visited every mode exactly once (plus the return to start)
        XCTAssertEqual(Set(visited).count, RecordingMode.allCases.count)
    }

    func testNextWrapsAround() throws {
        let last = try XCTUnwrap(RecordingMode.allCases.last)
        let first = try XCTUnwrap(RecordingMode.allCases.first)
        XCTAssertEqual(last.next(), first)
    }

    func testAllModesHaveDisplayNames() {
        for mode in RecordingMode.allCases {
            XCTAssertFalse(mode.displayName.isEmpty)
        }
    }

    func testAllModesHaveSystemImages() {
        for mode in RecordingMode.allCases {
            XCTAssertFalse(mode.systemImage.isEmpty)
        }
    }
}
