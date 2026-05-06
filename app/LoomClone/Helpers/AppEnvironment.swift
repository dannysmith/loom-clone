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
        static let defaultsSuiteName = "is.danny.loomclone.settings"
        static let defaultServerURL = ""
        static let appSupportSubdirectory = "LoomClone"
    #endif

    /// App support root, isolated per build configuration.
    static var appSupportDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent(appSupportSubdirectory)
    }

    /// Base recordings directory, isolated per build configuration.
    static var recordingsDirectory: URL {
        appSupportDirectory.appendingPathComponent("recordings")
    }

    /// Shared UserDefaults suite — all app preferences go here.
    /// Using a named suite (not `.standard`) ensures debug/release isolation
    /// even though the bundle identifier is the same for both.
    static let defaults: UserDefaults = .init(suiteName: defaultsSuiteName)!

    // MARK: - Preference Keys

    static let serverURLKey = "serverURL"
    static let outputPresetKey = "outputPresetID"
    static let recentlyHiddenBundleIDsKey = "recentlyHiddenBundleIDs"
    static let hideDesktopIconsKey = "hideDesktopIcons"

    // MARK: - Server URL

    // MARK: - App Exclusion

    /// Bundle IDs of recently-hidden apps, most-recent first. Capped at 5.
    static var recentlyHiddenBundleIDs: [String] {
        get { defaults.stringArray(forKey: recentlyHiddenBundleIDsKey) ?? [] }
        set { defaults.set(Array(newValue.prefix(5)), forKey: recentlyHiddenBundleIDsKey) }
    }

    /// Whether desktop icons should be hidden from screen recording.
    static var hideDesktopIcons: Bool {
        get { defaults.bool(forKey: hideDesktopIconsKey) }
        set { defaults.set(newValue, forKey: hideDesktopIconsKey) }
    }

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
