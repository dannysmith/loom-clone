import SwiftUI

@main
struct LoomCloneApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // No visible windows — all functional UI is through the menu bar.
        // The Settings scene is the standard macOS preferences window
        // (Cmd+, via the main menu, or opened from the popover's
        // Settings… link).
        Settings {
            SettingsView()
        }
    }
}
