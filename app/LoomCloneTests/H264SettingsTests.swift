import AVFoundation
@testable import LoomClone
import VideoToolbox
import XCTest

final class H264SettingsTests: XCTestCase {
    func testEncoderSpecificationRequiresHardware() {
        let spec = H264Settings.encoderSpecification
        let key = kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String
        XCTAssertNotNil(spec[key])
    }

    func testCompressionPropertiesContainExpectedKeys() {
        let props = H264Settings.compressionProperties(bitrate: 6_000_000)

        XCTAssertEqual(props[AVVideoAverageBitRateKey] as? Int, 6_000_000)
        XCTAssertEqual(props[AVVideoMaxKeyFrameIntervalDurationKey] as? Double, 2.0)
        XCTAssertEqual(props[AVVideoProfileLevelKey] as? String, AVVideoProfileLevelH264HighAutoLevel)
        XCTAssertEqual(props[AVVideoExpectedSourceFrameRateKey] as? Int, 30)
        XCTAssertEqual(props[AVVideoH264EntropyModeKey] as? String, AVVideoH264EntropyModeCABAC)
        XCTAssertEqual(props[AVVideoAllowFrameReorderingKey] as? Bool, false)
    }

    func testCompressionPropertiesBitrateVaries() {
        let low = H264Settings.compressionProperties(bitrate: 2_500_000)
        let high = H264Settings.compressionProperties(bitrate: 10_000_000)

        XCTAssertEqual(low[AVVideoAverageBitRateKey] as? Int, 2_500_000)
        XCTAssertEqual(high[AVVideoAverageBitRateKey] as? Int, 10_000_000)
    }

    func testRec709ColorProperties() {
        let props = H264Settings.rec709ColorProperties
        XCTAssertEqual(props[AVVideoColorPrimariesKey] as? String, AVVideoColorPrimaries_ITU_R_709_2)
        XCTAssertEqual(props[AVVideoTransferFunctionKey] as? String, AVVideoTransferFunction_ITU_R_709_2)
        XCTAssertEqual(props[AVVideoYCbCrMatrixKey] as? String, AVVideoYCbCrMatrix_ITU_R_709_2)
    }
}
