@testable import LoomClone
import XCTest

/// `LogExtractor`'s store-reading half is OS-backed and only exercised by
/// manual testing. These cover the one piece of pure logic that's easy to get
/// subtly wrong: parsing the recording window out of `recording.json`. The real
/// risk is the ISO-8601 format coupling with `RecordingTimelineBuilder`, which
/// writes timestamps *with fractional seconds* — a formatter mismatch would
/// silently yield no window and skip extraction entirely.
final class LogExtractorTests: XCTestCase {
    /// Same options the builder uses to write `startedAt`/`endedAt`.
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func json(startedAt: String?, endedAt: String?, durationSeconds: Double?) throws -> Data {
        var session: [String: Any] = [:]
        if let startedAt { session["startedAt"] = startedAt }
        if let endedAt { session["endedAt"] = endedAt }
        if let durationSeconds { session["durationSeconds"] = durationSeconds }
        return try JSONSerialization.data(withJSONObject: ["session": session])
    }

    func testParsesStartAndEndWithFractionalSeconds() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000.25)
        let end = start.addingTimeInterval(123.5)
        let data = try json(
            startedAt: iso.string(from: start),
            endedAt: iso.string(from: end),
            durationSeconds: 120
        )

        let window = try XCTUnwrap(LogExtractor.parseWindow(from: data))
        // Fractional seconds survive the round-trip (within formatter precision).
        XCTAssertEqual(window.start.timeIntervalSince1970, start.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(window.end.timeIntervalSince1970, end.timeIntervalSince1970, accuracy: 0.001)
    }

    func testFallsBackToDurationWhenNoEnd() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let data = try json(startedAt: iso.string(from: start), endedAt: nil, durationSeconds: 90)

        let window = try XCTUnwrap(LogExtractor.parseWindow(from: data))
        XCTAssertEqual(window.end.timeIntervalSince1970, start.timeIntervalSince1970 + 90, accuracy: 0.001)
    }

    func testFallsBackToNowWhenNoEndOrDuration() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let data = try json(startedAt: iso.string(from: start), endedAt: nil, durationSeconds: nil)

        let window = try XCTUnwrap(LogExtractor.parseWindow(from: data))
        // End defaults to "now", which must be well after the fixed past start.
        XCTAssertGreaterThan(window.end, start)
        XCTAssertEqual(window.end.timeIntervalSinceNow, 0, accuracy: 5)
    }

    func testReturnsNilWhenStartMissing() throws {
        let data = try json(startedAt: nil, endedAt: nil, durationSeconds: 10)
        XCTAssertNil(LogExtractor.parseWindow(from: data))
    }

    func testReturnsNilWhenStartUnparseable() throws {
        let data = try json(startedAt: "not-a-date", endedAt: nil, durationSeconds: 10)
        XCTAssertNil(LogExtractor.parseWindow(from: data))
    }
}
