import Foundation

/// Centralised facade over URLSession for every server HTTP call the app
/// makes. Owns two things that used to be scattered across three files:
/// the base URL and the `Authorization: Bearer <token>` header.
///
/// Intentionally thin — it does not know about any specific endpoint,
/// response shape, or retry logic. Callers build URLRequests through
/// `authorizedRequest` / `request`, set the method/body/content-type,
/// and hand back to `send` / `upload`.
///
/// Status-code handling: `send` and `upload` throw `.unauthorized` on 401
/// so callers don't have to repeat the check, but otherwise return the raw
/// response and let each call site interpret its own status codes (200
/// success, 404 "orphaned" in heal, etc.).
struct APIClient {
    static let shared = APIClient(
        baseURL: "http://127.0.0.1:3000",
        keyStore: .shared
    )

    /// No trailing slash. Paths passed to `request(path:)` must start with `/`.
    let baseURL: String
    let keyStore: APIKeyStore
    let session: URLSession

    init(baseURL: String, keyStore: APIKeyStore, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.keyStore = keyStore
        self.session = session
    }

    enum ClientError: Error {
        /// No API key is stored in the Keychain. Surface this distinctly in
        /// the UI so we can guide the user to Settings instead of showing a
        /// generic failure.
        case missingAPIKey
        /// Server returned 401 — the stored key is invalid or revoked.
        /// Same UX consequence as `missingAPIKey`, different cause.
        case unauthorized
        /// URLSession returned a non-HTTPURLResponse (should not happen with
        /// HTTP(S) URLs).
        case invalidResponse
    }

    /// Build a full URL for `path` on this client's base. Callers use this
    /// when they need to show the user a URL (e.g. `"\(baseURL)\(json.url)"`).
    func url(path: String) -> URL {
        // Force-unwrap matches the existing call-site pattern. Paths passed
        // here are hardcoded by callers, not untrusted input.
        URL(string: "\(baseURL)\(path)")!
    }

    /// Build an unauthenticated URLRequest. Used for `/api/health`.
    func request(path: String, timeout: TimeInterval? = nil) -> URLRequest {
        var req = URLRequest(url: url(path: path))
        if let timeout { req.timeoutInterval = timeout }
        return req
    }

    /// Build a URLRequest with `Authorization: Bearer <token>` attached.
    /// Throws `.missingAPIKey` if nothing is stored — we deliberately fail
    /// fast rather than letting the server reject the unauthed request,
    /// because the caller reaction is the same either way ("send user to
    /// Settings") and this short-circuits the network round-trip.
    func authorizedRequest(path: String, timeout: TimeInterval? = nil) throws -> URLRequest {
        guard let token = keyStore.read() else {
            throw ClientError.missingAPIKey
        }
        var req = URLRequest(url: url(path: path))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let timeout { req.timeoutInterval = timeout }
        return req
    }

    /// Thin pass-through to `session.data(for:)`. Throws `.unauthorized` on
    /// 401 and `.invalidResponse` if the response isn't HTTP; otherwise
    /// returns the raw `(Data, HTTPURLResponse)` for the caller to inspect.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }
        if http.statusCode == 401 {
            throw ClientError.unauthorized
        }
        return (data, http)
    }

    /// Thin pass-through to `session.upload(for:from:)`. Same 401 + non-HTTP
    /// behaviour as `send`.
    func upload(_ request: URLRequest, from body: Data) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.upload(for: request, from: body)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }
        if http.statusCode == 401 {
            throw ClientError.unauthorized
        }
        return (data, http)
    }
}
