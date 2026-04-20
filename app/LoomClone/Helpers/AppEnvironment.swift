import Foundation

/// Build-configuration-aware constants for storage namespacing.
///
/// Debug builds (run from Xcode) and release builds (archived / installed
/// in ~/Applications) use separate Keychain entries and UserDefaults suites
/// so development doesn't interfere with production configuration.
enum AppEnvironment {
    #if DEBUG
        static let isDebug = true
        static let keychainService = "is.danny.loomclone.debug.apikey"
        static let defaultsSuiteName = "is.danny.loomclone.debug"
        static let defaultServerURL = "http://127.0.0.1:3000"
        static let appSupportSubdirectory = "LoomClone-Debug"
    #else
        static let isDebug = false
        static let keychainService = "is.danny.loomclone.apikey"
        static let defaultsSuiteName = "is.danny.loomclone"
        static let defaultServerURL = ""
        static let appSupportSubdirectory = "LoomClone"
    #endif

    /// Base recordings directory, isolated per build configuration.
    static var recordingsDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("\(appSupportSubdirectory)/recordings")
    }

    /// Shared UserDefaults suite — all app preferences go here.
    /// Using a named suite (not `.standard`) ensures debug/release isolation
    /// even though the bundle identifier is the same for both.
    static let defaults: UserDefaults = .init(suiteName: defaultsSuiteName)!

    // MARK: - Preference Keys

    static let serverURLKey = "serverURL"
    static let outputPresetKey = "outputPresetID"

    // MARK: - Server URL

    /// The currently configured server URL, or the build-config default.
    static var serverURL: String {
        get {
            defaults.string(forKey: serverURLKey).flatMap { $0.isEmpty ? nil : $0 }
                ?? defaultServerURL
        }
        set {
            defaults.set(newValue, forKey: serverURLKey)
        }
    }
}
