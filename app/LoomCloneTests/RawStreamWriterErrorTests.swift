@testable import LoomClone
import XCTest

/// Covers the `NSUnderlyingError`-chain walk that turns a generic top-level
/// `AVErrorUnknown` (`-11800`) into the real VideoToolbox/CMIO cause for
/// `recording.json` (#30). Pure logic with real bug surface: wrong userInfo
/// key, stopping at the wrong depth, or missing the multiple-errors variant.
final class RawStreamWriterErrorTests: XCTestCase {
    func testNoUnderlyingChainReturnsNil() {
        let error = NSError(domain: "X", code: 5)
        XCTAssertNil(RawStreamWriter.deepestUnderlyingError(error))
    }

    func testWalksToDeepestError() {
        let deep = NSError(
            domain: "VTError", code: -12909,
            userInfo: [NSLocalizedFailureReasonErrorKey: "codec resources"]
        )
        let mid = NSError(domain: "CMIO", code: -12743, userInfo: [NSUnderlyingErrorKey: deep])
        let top = NSError(domain: "AVFoundationErrorDomain", code: -11800, userInfo: [NSUnderlyingErrorKey: mid])

        let deepest = RawStreamWriter.deepestUnderlyingError(top)
        XCTAssertEqual(deepest?.code, -12909)
        XCTAssertEqual(deepest?.domain, "VTError")
    }

    func testFollowsMultipleUnderlyingErrorsKey() {
        let under = NSError(domain: "Under", code: 42)
        let top = NSError(domain: "Top", code: 9, userInfo: [NSMultipleUnderlyingErrorsKey: [under]])
        XCTAssertEqual(RawStreamWriter.deepestUnderlyingError(top)?.code, 42)
    }

    func testMakeFailureCapturesTopAndUnderlying() throws {
        let deep = NSError(
            domain: "VTError", code: -12909,
            userInfo: [NSLocalizedFailureReasonErrorKey: "codec resources"]
        )
        let top = NSError(domain: "AVFoundationErrorDomain", code: -11800, userInfo: [NSUnderlyingErrorKey: deep])

        let failure = try XCTUnwrap(RawStreamWriter.makeFailure(from: top))
        XCTAssertEqual(failure.code, -11800)
        XCTAssertEqual(failure.domain, "AVFoundationErrorDomain")
        XCTAssertEqual(failure.underlyingCode, -12909)
        XCTAssertEqual(failure.underlyingDomain, "VTError")
        XCTAssertEqual(failure.underlyingDescription, "codec resources")
    }

    func testMakeFailureWithNoUnderlyingLeavesUnderlyingFieldsNil() {
        let error = NSError(domain: "X", code: 5)
        let failure = RawStreamWriter.makeFailure(from: error)
        XCTAssertEqual(failure?.code, 5)
        XCTAssertNil(failure?.underlyingCode)
        XCTAssertNil(failure?.underlyingDomain)
    }

    func testMakeFailureFromNilReturnsNil() {
        XCTAssertNil(RawStreamWriter.makeFailure(from: nil))
    }
}
