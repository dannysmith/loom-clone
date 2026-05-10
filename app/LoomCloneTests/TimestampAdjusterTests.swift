import CoreMedia
@testable import LoomClone
import XCTest

final class TimestampAdjusterTests: XCTestCase {
    func testDefaultPrimingOffset() {
        XCTAssertEqual(TimestampAdjuster.defaultPrimingOffset.seconds, 10.0, accuracy: 0.001)
    }
}
