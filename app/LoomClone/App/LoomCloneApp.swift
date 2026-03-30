import SwiftUI

@main
struct LoomCloneApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // No visible windows — all UI is through the menu bar
        Settings {
            EmptyView()
        }
    }
}
