import CoreMedia
@testable import LoomClone
import XCTest

final class FrameRateTests: XCTestCase {
    func testRawValues() {
        XCTAssertEqual(FrameRate.thirtyFPS.rawValue, 30)
        XCTAssertEqual(FrameRate.sixtyFPS.rawValue, 60)
    }

    func testBitrateMultiplier() {
        XCTAssertEqual(FrameRate.thirtyFPS.bitrateMultiplier, 1.0)
        XCTAssertEqual(FrameRate.sixtyFPS.bitrateMultiplier, 1.4)
    }

    func testFrameDuration() {
        XCTAssertEqual(FrameRate.thirtyFPS.frameDuration, CMTime(value: 1, timescale: 30))
        XCTAssertEqual(FrameRate.sixtyFPS.frameDuration, CMTime(value: 1, timescale: 60))
    }

    func testMinAcceptableRate() {
        // NTSC tolerance: 29.97 passes ≥ 29.0, 59.94 passes ≥ 59.0
        XCTAssertEqual(FrameRate.thirtyFPS.minAcceptableRate, 29.0)
        XCTAssertEqual(FrameRate.sixtyFPS.minAcceptableRate, 59.0)
    }

    func testEffectiveBitrateAt1080p() {
        let base = OutputPreset.p1080.bitrate // 8_000_000
        let at30 = Int(Double(base) * FrameRate.thirtyFPS.bitrateMultiplier)
        let at60 = Int(Double(base) * FrameRate.sixtyFPS.bitrateMultiplier)

        XCTAssertEqual(at30, 8_000_000)
        XCTAssertEqual(at60, 11_200_000)
    }

    func testEffectiveBitrateAt1440p() {
        let base = OutputPreset.p1440.bitrate // 13_000_000
        let at30 = Int(Double(base) * FrameRate.thirtyFPS.bitrateMultiplier)
        let at60 = Int(Double(base) * FrameRate.sixtyFPS.bitrateMultiplier)

        XCTAssertEqual(at30, 13_000_000)
        XCTAssertEqual(at60, 18_200_000)
    }

    func testInitFromRawValue() {
        XCTAssertEqual(FrameRate(rawValue: 30), .thirtyFPS)
        XCTAssertEqual(FrameRate(rawValue: 60), .sixtyFPS)
        XCTAssertNil(FrameRate(rawValue: 24))
    }

    func testLabel() {
        XCTAssertEqual(FrameRate.thirtyFPS.label, "30 fps")
        XCTAssertEqual(FrameRate.sixtyFPS.label, "60 fps")
    }
}
