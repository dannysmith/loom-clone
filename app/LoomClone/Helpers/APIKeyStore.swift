import Foundation
import Security

/// Thin wrapper around the system Keychain for the bearer token the
/// macOS app sends to the loom-clone server.
///
/// Value type — its only "state" is the service id, which tests override
/// so roundtrip tests don't touch the real stored key. Use `.shared` for
/// production code; construct a fresh instance with a test-only service
/// for unit tests.
///
/// Read returns `nil` on any failure (missing or otherwise) because
/// callers react the same way either way: prompt the user to paste a
/// key. Write and delete throw because their failures are rare and
/// actionable (e.g. surface a Settings UI error to the user).
struct APIKeyStore {
    static let shared = APIKeyStore(service: AppEnvironment.keychainService)

    let service: String
    let account: String

    init(service: String, account: String = "default") {
        self.service = service
        self.account = account
    }

    enum StoreError: Error {
        case writeFailed(OSStatus)
        case deleteFailed(OSStatus)
    }

    /// Returns the stored token, or `nil` if nothing is saved (or the
    /// Keychain can't read it for any reason).
    func read() -> String? {
        var query = baseQuery
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Upserts the token. `AfterFirstUnlockThisDeviceOnly`:
    /// - readable after the user unlocks the Mac once (so background
    ///   heal-and-retry uploads work even when the screen is locked)
    /// - doesn't sync via iCloud Keychain (the key is device-specific,
    ///   and a revoked-on-another-device key getting synced back would
    ///   be confusing)
    func write(_ token: String) throws {
        let data = Data(token.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        // Try update first; if nothing to update, insert. Keychain has
        // no "upsert" primitive — the two-step is the documented pattern.
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        if updateStatus != errSecItemNotFound {
            throw StoreError.writeFailed(updateStatus)
        }

        var insertAttrs = baseQuery
        insertAttrs.merge(attributes) { _, new in new }
        let addStatus = SecItemAdd(insertAttrs as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw StoreError.writeFailed(addStatus)
        }
    }

    /// Removes the stored token. Treats "not found" as success so callers
    /// can always "reset" without branching on pre-state.
    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return }
        throw StoreError.deleteFailed(status)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
