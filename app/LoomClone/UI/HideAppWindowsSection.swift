import AppKit
import SwiftUI

/// Expandable "Hide App Windows" section in the menubar popover. Lets the user
/// toggle desktop icon hiding and select running apps to exclude from screen
/// capture. Implemented as a leaf subview so @Observable reads are scoped here
/// and don't trigger full MenuView re-renders.
struct HideAppWindowsSection: View {
    let coordinator: RecordingCoordinator

    /// Local expansion state — auto-expanded if any exclusion is active.
    @State private var isExpanded: Bool = false
    @State private var didAutoExpand: Bool = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 6) {
                desktopIconsToggle

                let recentApps = recentlyHiddenApps
                let otherApps = runningApps(excluding: Set(recentApps.map(\.bundleID)))

                if !recentApps.isEmpty {
                    ForEach(recentApps) { app in
                        appRow(app: app)
                    }
                }

                if !otherApps.isEmpty {
                    if !recentApps.isEmpty {
                        Divider()
                            .padding(.vertical, 2)
                    }
                    ForEach(otherApps) { app in
                        appRow(app: app)
                    }
                }

                if recentApps.isEmpty, otherApps.isEmpty {
                    Text("No apps running")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(maxHeight: 150)
        } label: {
            HStack(spacing: 4) {
                Text("Hide App Windows")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                let count = coordinator.excludedAppBundleIDs.count
                if count > 0 {
                    Text("(\(count))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .onAppear {
            autoExpandIfNeeded()
        }
        .onChange(of: coordinator.isPopoverOpen) { _, open in
            if open { autoExpandIfNeeded() }
        }
    }

    // MARK: - Desktop Icons Toggle

    private var desktopIconsToggle: some View {
        Toggle(isOn: Binding(
            get: { coordinator.hideDesktopIcons },
            set: { coordinator.hideDesktopIcons = $0 }
        )) {
            Text("Hide desktop icons")
                .font(.caption)
        }
        .toggleStyle(.checkbox)
        .controlSize(.small)
    }

    // MARK: - App Row

    private func appRow(app: AppInfo) -> some View {
        let isChecked = coordinator.excludedAppBundleIDs.contains(app.bundleID)
        return Toggle(isOn: Binding(
            get: { isChecked },
            set: { checked in
                if checked {
                    coordinator.excludedAppBundleIDs.insert(app.bundleID)
                } else {
                    coordinator.excludedAppBundleIDs.remove(app.bundleID)
                }
            }
        )) {
            HStack(spacing: 6) {
                if let icon = app.icon {
                    Image(nsImage: icon)
                        .resizable()
                        .frame(width: 16, height: 16)
                }
                Text(app.name)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(app.isRunning ? .primary : .secondary)
            }
        }
        .toggleStyle(.checkbox)
        .controlSize(.small)
    }

    // MARK: - Auto-expand

    private func autoExpandIfNeeded() {
        guard !didAutoExpand else { return }
        if coordinator.hideDesktopIcons || !coordinator.excludedAppBundleIDs.isEmpty {
            isExpanded = true
        }
        didAutoExpand = true
    }

    // MARK: - App Enumeration

    /// Recently-hidden apps from persisted list, regardless of whether running.
    private var recentlyHiddenApps: [AppInfo] {
        coordinator.recentlyHiddenBundleIDs.compactMap { bundleID in
            appInfo(for: bundleID)
        }
    }

    /// Currently running Dock-visible apps, excluding our own and any in the
    /// recently-hidden list.
    private func runningApps(excluding recentBundleIDs: Set<String>) -> [AppInfo] {
        let ownBundleID = Bundle.main.bundleIdentifier ?? ""
        return NSWorkspace.shared.runningApplications
            .filter {
                $0.activationPolicy == .regular
                    && $0.bundleIdentifier != ownBundleID
                    && !recentBundleIDs.contains($0.bundleIdentifier ?? "")
            }
            .compactMap { app -> AppInfo? in
                guard let bundleID = app.bundleIdentifier else { return nil }
                return AppInfo(
                    bundleID: bundleID,
                    name: app.localizedName ?? bundleID,
                    icon: app.icon,
                    isRunning: true
                )
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Resolve a bundle ID to display info. Running apps get their icon from
    /// NSRunningApplication; not-running apps fall back to NSWorkspace.
    private func appInfo(for bundleID: String) -> AppInfo? {
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleID }) {
            return AppInfo(
                bundleID: bundleID,
                name: running.localizedName ?? bundleID,
                icon: running.icon,
                isRunning: true
            )
        }
        // Not running — resolve name/icon from the file system
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return AppInfo(
                bundleID: bundleID,
                name: bundleID,
                icon: nil,
                isRunning: false
            )
        }
        let name = FileManager.default.displayName(atPath: url.path)
        let icon = NSWorkspace.shared.icon(forFile: url.path)
        return AppInfo(
            bundleID: bundleID,
            name: name,
            icon: icon,
            isRunning: false
        )
    }
}

// MARK: - AppInfo

extension HideAppWindowsSection {
    struct AppInfo: Identifiable {
        let bundleID: String
        let name: String
        let icon: NSImage?
        let isRunning: Bool

        var id: String {
            bundleID
        }
    }
}
