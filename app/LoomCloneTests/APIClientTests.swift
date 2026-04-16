@testable import LoomClone
import XCTest

/// Network behaviour is covered by end-to-end manual testing and the
/// server's own test suite. These tests cover only APIClient's pure
/// request-construction logic — base URL + auth header — which is the
/// part that's easiest to get subtly wrong and hardest to catch in
/// manual testing.
final class APIClientTests: XCTestCase {
    private let testKeyStore = APIKeyStore(
        service: "com.danny.loomclone.apikey-apiclient-tests",
        account: "unit-tests"
    )

    override func setUpWithError() throws {
        try? testKeyStore.delete()
    }

    override func tearDownWithError() throws {
        try? testKeyStore.delete()
    }

    func testURLComposition() {
        let client = APIClient(baseURL: "http://127.0.0.1:3000", keyStore: testKeyStore)
        XCTAssertEqual(
            client.url(path: "/api/videos").absoluteString,
            "http://127.0.0.1:3000/api/videos"
        )
    }

    func testUnauthedRequestHasNoAuthorizationHeader() {
        let client = APIClient(baseURL: "http://127.0.0.1:3000", keyStore: testKeyStore)
        let req = client.request(path: "/api/health", timeout: 2)
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(req.timeoutInterval, 2)
    }

    func testAuthorizedRequestAttachesBearerHeader() throws {
        try testKeyStore.write("lck_test_token")
        let client = APIClient(baseURL: "http://127.0.0.1:3000", keyStore: testKeyStore)
        let req = try client.authorizedRequest(path: "/api/videos")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer lck_test_token")
    }

    func testAuthorizedRequestThrowsWhenNoKeyStored() {
        let client = APIClient(baseURL: "http://127.0.0.1:3000", keyStore: testKeyStore)
        XCTAssertThrowsError(try client.authorizedRequest(path: "/api/videos")) { error in
            guard case APIClient.ClientError.missingAPIKey = error else {
                XCTFail("Expected missingAPIKey, got \(error)")
                return
            }
        }
    }

    func testAuthorizedRequestAppliesTimeoutOverride() throws {
        try testKeyStore.write("lck_test_token")
        let client = APIClient(baseURL: "http://127.0.0.1:3000", keyStore: testKeyStore)
        let req = try client.authorizedRequest(path: "/x", timeout: 5)
        XCTAssertEqual(req.timeoutInterval, 5)
    }
}
