@testable import LoomClone
import XCTest

final class JSONValueTests: XCTestCase {
    private func roundtrip(_ value: JSONValue) throws -> Any {
        let data = try JSONEncoder().encode([value])
        let array = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])
        return try XCTUnwrap(array.first)
    }

    func testStringEncodes() throws {
        let decoded = try roundtrip(.string("hello"))
        XCTAssertEqual(decoded as? String, "hello")
    }

    func testIntEncodes() throws {
        let decoded = try roundtrip(.int(42))
        XCTAssertEqual(decoded as? Int, 42)
    }

    func testDoubleEncodes() throws {
        let decoded = try roundtrip(.double(3.14))
        let value = try XCTUnwrap(decoded as? Double)
        XCTAssertEqual(value, 3.14, accuracy: 0.001)
    }

    func testBoolEncodes() throws {
        let decoded = try roundtrip(.bool(true))
        XCTAssertEqual(decoded as? Bool, true)
    }
}
