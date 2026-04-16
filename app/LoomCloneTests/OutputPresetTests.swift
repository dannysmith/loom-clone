@testable import LoomClone
import XCTest

final class OutputPresetTests: XCTestCase {
    func testFromIDReturnsMatchingPreset() {
        XCTAssertEqual(OutputPreset.fromID("720p"), .p720)
        XCTAssertEqual(OutputPreset.fromID("1080p"), .p1080)
        XCTAssertEqual(OutputPreset.fromID("1440p"), .p1440)
    }

    func testFromIDFallsBackToDefault() {
        XCTAssertEqual(OutputPreset.fromID("garbage"), .default)
        XCTAssertEqual(OutputPreset.fromID(""), .default)
    }

    func testDefaultIs1080p() {
        XCTAssertEqual(OutputPreset.default, .p1080)
    }

    func testAllPresetsHaveUniqueIDs() {
        let ids = OutputPreset.all.map(\.id)
        XCTAssertEqual(ids.count, Set(ids).count)
    }

    func testPresetsAreOrderedByResolution() {
        let heights = OutputPreset.all.map(\.height)
        XCTAssertEqual(heights, heights.sorted())
    }
}
