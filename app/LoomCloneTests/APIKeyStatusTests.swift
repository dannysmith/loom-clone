@testable import LoomClone
import XCTest

/// APIKeyStatus is a thin observable cache over APIKeyStore. The only
/// behaviour worth testing is that refresh() picks up writes/deletes.
@MainActor
final class APIKeyStatusTests: XCTestCase {
    private let store = APIKeyStore(
        service: "is.danny.loomclone.apikey-status-tests",
        account: "unit-tests"
    )

    override func setUpWithError() throws {
        try? store.delete()
    }

    override func tearDownWithError() throws {
        try? store.delete()
    }

    func testInitReflectsCurrentStoreState() throws {
        let emptyStatus = APIKeyStatus(store: store)
        XCTAssertFalse(emptyStatus.hasKey)

        try store.write("lck_abc")
        let populatedStatus = APIKeyStatus(store: store)
        XCTAssertTrue(populatedStatus.hasKey)
    }

    func testRefreshPicksUpWrites() throws {
        let status = APIKeyStatus(store: store)
        XCTAssertFalse(status.hasKey)

        try store.write("lck_abc")
        status.refresh()
        XCTAssertTrue(status.hasKey)
    }

    func testRefreshPicksUpDeletes() throws {
        try store.write("lck_abc")
        let status = APIKeyStatus(store: store)
        XCTAssertTrue(status.hasKey)

        try store.delete()
        status.refresh()
        XCTAssertFalse(status.hasKey)
    }
}
