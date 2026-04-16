@testable import LoomClone
import XCTest

/// Tests use a dedicated service id so they can't disturb the real
/// stored API key. `setUp` wipes before each test; `tearDown` cleans up.
final class APIKeyStoreTests: XCTestCase {
    private let store = APIKeyStore(
        service: "com.danny.loomclone.apikey-tests",
        account: "unit-tests"
    )

    override func setUpWithError() throws {
        try? store.delete()
    }

    override func tearDownWithError() throws {
        try? store.delete()
    }

    func testReadReturnsNilWhenNothingStored() {
        XCTAssertNil(store.read())
    }

    func testWriteAndReadRoundtrip() throws {
        try store.write("lck_roundtrip_abc")
        XCTAssertEqual(store.read(), "lck_roundtrip_abc")
    }

    func testWriteUpsertsExistingValue() throws {
        try store.write("lck_first")
        try store.write("lck_second")
        XCTAssertEqual(store.read(), "lck_second")
    }

    func testDeleteRemovesStoredValue() throws {
        try store.write("lck_delete_me")
        try store.delete()
        XCTAssertNil(store.read())
    }

    func testDeleteIsIdempotent() throws {
        // Nothing stored — delete must not throw.
        try store.delete()
        try store.delete()
    }

    func testInstancesWithDifferentServicesDoNotCollide() throws {
        let other = APIKeyStore(
            service: "com.danny.loomclone.apikey-tests-other",
            account: "unit-tests"
        )
        try? other.delete()
        defer { try? other.delete() }

        try store.write("lck_first_store")
        try other.write("lck_other_store")

        XCTAssertEqual(store.read(), "lck_first_store")
        XCTAssertEqual(other.read(), "lck_other_store")
    }
}
