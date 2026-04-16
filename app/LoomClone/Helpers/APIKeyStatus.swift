import Foundation

/// Observable surface over `APIKeyStore` — holds a boolean so SwiftUI
/// views can react to "key is / isn't configured" without each view
/// reading the Keychain on every body invalidation.
///
/// The source of truth is still the Keychain (via `APIKeyStore`); this
/// class is a cache that must be told to `refresh()` whenever something
/// writes or deletes the stored token (currently just the Settings UI).
@MainActor
@Observable
final class APIKeyStatus {
    static let shared = APIKeyStatus()

    private(set) var hasKey: Bool

    init(store: APIKeyStore = .shared) {
        self.store = store
        self.hasKey = store.read() != nil
    }

    private let store: APIKeyStore

    /// Re-read the Keychain. Call after any write or delete — the Keychain
    /// has no notification mechanism, and we'd rather poll-on-save than
    /// poll continuously.
    func refresh() {
        hasKey = store.read() != nil
    }
}
