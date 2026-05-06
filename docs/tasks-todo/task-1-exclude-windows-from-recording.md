# Task 1: Exclude Windows and Desktop Icons from Screen Recording

GitHub: dannysmith/loom-clone#17

## Goal

Allow specific apps to be excluded from screen capture on a per-recording basis, and optionally hide desktop icons. Uses the same ScreenCaptureKit `excludingApplications` mechanism we already use to exclude our own toolbar and camera overlay.

## Use Cases

- **Teleprompter** — use TextEdit, Notes, or any text editor as a teleprompter visible to you but invisible in the recording.
- **Clean desktop** — hide desktop icons without changing OS settings.
- **Hide distractions** — exclude messaging apps, notification windows, etc.

## Current State

`ScreenCaptureManager.startCapture(display:excludingApps:)` builds the `SCContentFilter`. It already accepts an array of `SCRunningApplication` (widened from a single optional during the spike). The relevant code path:

1. `RecordingActor+Prepare.swift:resolveDisplay()` — queries `SCShareableContent`, finds our PID
2. `RecordingActor+Prepare.swift:startCaptureSources()` — wraps our app in an array and passes to screen capture
3. `ScreenCaptureManager.swift:startCapture(display:excludingApps:)` — builds the filter and starts the stream

## Research Spike (Phase 0) — Complete

Confirmed on macOS 15 (Sequoia), M2 Pro:

1. **Desktop icons**: Hidden from recording when Finder is excluded. Wallpaper remains visible (WallpaperAgent is a separate process). But app-level Finder exclusion also hides Finder browser windows — so desktop icons need surgical window-level exclusion.
2. **Third-party app exclusion**: TextEdit completely invisible in both composited HLS and raw `screen.mov`. Works as expected.
3. **Fullscreen excluded app**: Plain black screen when swiping to that Space. No artifacts. Acceptable.
4. **`onScreenWindowsOnly` behaviour**: With `true`, apps without visible windows are omitted from `SCShareableContent.applications`. Use `false` when resolving excluded bundle IDs so apps are found even if they have no on-screen windows yet.
5. **`excludingApplications` auto-covers new windows**: If an already-excluded app opens a new window mid-recording, it's automatically excluded. No filter update needed for that case.

## UX Design

### Popover: "Hide App Windows" section

An expandable disclosure section in the menubar popover, only visible when a display source is selected. It contains:

1. **Desktop icons toggle** — standalone checkbox at the top: "Hide desktop icons." Persisted to disk (survives app restarts). When checked, the section shows as expanded on popover open.

2. **App list** — two groups, no visual divider needed since recently-hidden apps may be dimmed when not running:
   - **Recently hidden** (top) — up to 5 apps that have been checked in previous recordings. Persisted to disk as bundle IDs (survives app restarts). Shown whether the app is currently running or not; dimmed if not running. If a recently-hidden app is toggled on but not yet running, it will be automatically excluded if it launches during recording (via mid-recording filter update).
   - **Other running apps** (below) — currently running Dock-visible apps (`activationPolicy == .regular`) that aren't in the recently-hidden list. These disappear from the list if they quit.

3. **Each app row** — checkbox, 16px app icon, app name. Compact single-line rows.

4. **Expansion behaviour** — the section auto-expands on popover open if any app is checked OR the desktop icons toggle is on. Otherwise collapsed.

5. **Max height** — scrollable area capped at ~150px if the list gets long.

### State lifecycle

- **Recently-hidden list** (up to 5 bundle IDs): persisted to `AppEnvironment.defaults`. Updated whenever an app is checked — most recently used at the top, oldest falls off when exceeding 5.
- **Desktop icons toggle**: persisted to `AppEnvironment.defaults`.
- **Per-app checked/unchecked state**: in-memory only on the `RecordingCoordinator`. Resets to all-unchecked on app restart. Persists across popover open/close cycles within a session.
- **The entire section**: hidden when no display source is selected (camera-only mode).

### Warning pill during recording

When the currently focused window belongs to a hidden app, show a warning pill in the recording panel: "\<AppName\> is hidden from recording" (using `NSWorkspace.shared.frontmostApplication?.localizedName`). Checked every 500ms in the existing health-check timer. Uses the existing `RecordingWarning` system with a new `.focusedWindowHidden` kind, severity `.warning` (orange pill). Clears automatically when focus moves to a non-hidden app.

### recording.json

The session metadata should include:
- `excludedApps`: array of `{ bundleID, name }` objects for apps excluded from this recording
- `desktopIconsHidden`: boolean

## Implementation Plan

### Phase 1: Core exclusion plumbing + mid-recording updates

Wire the full path from bundle IDs to an active `SCContentFilter`, including live filter updates for apps that launch during recording.

**ScreenCaptureManager changes:**
- Store the current `SCDisplay` and excluded apps list so we can rebuild filters
- Add `updateExcludedApps(_:excludingWindows:)` that calls `SCStream.updateContentFilter(_:)` on the live stream
- Already accepts `excludingApps: [SCRunningApplication]` (done in spike)

**RecordingActor changes:**
- Add `updateExcludedApps(_ apps: [SCRunningApplication])` that calls through to `ScreenCaptureManager` and logs to timeline
- Store the current excluded bundle IDs set for the focused-window warning check
- In `resolveDisplay()`, query with `onScreenWindowsOnly: false` to find apps even without visible windows

**RecordingCoordinator changes:**
- New in-memory state: `excludedBundleIDs: Set<String>` (the checked apps), resets on app launch
- Method to resolve bundle IDs → `[SCRunningApplication]` at recording start
- Pass resolved apps to `startCaptureSources` alongside our own app
- Observe `NSWorkspace.didLaunchApplicationNotification` during recording: if a newly launched app's bundle ID is in `excludedBundleIDs`, re-resolve and call `RecordingActor.updateExcludedApps()`
- Include excluded apps info in the session metadata sent to the server

**AppEnvironment changes:**
- `recentlyHiddenBundleIDsKey` — `[String]` array, capped at 5
- `hideDesktopIconsKey` — `Bool`

### Phase 2: Desktop icons exclusion

Surgical window-level exclusion for Finder's desktop icon windows, separate from app-level exclusion.

- Query `CGWindowListCopyWindowInfo` to find Finder's windows at `kCGDesktopIconWindowLevel`
- Cross-reference with `SCShareableContent.windows` to get `SCWindow` objects
- Pass these as `excludingWindows` in the `SCContentFilter` (in addition to `excludingApplications`)
- `ScreenCaptureManager.startCapture` and `updateExcludedApps` need to accept both `excludingApps` and `excludingWindows`

### Phase 3: Popover UI

The "Hide App Windows" expandable section in `MenuView`.

- New `HideAppWindowsSection` view (leaf subview to limit observable re-renders, following the `TranscriptionModelSection` pattern)
- Desktop icons checkbox at top
- App list: recently-hidden first, then other running Dock-visible apps
- Each row: checkbox + 16px icon (`NSWorkspace.shared.icon(forFile:)` via `NSWorkspace.shared.urlForApplication(withBundleIdentifier:)`) + app name
- Scrollable with max height ~150px
- Auto-expand logic: expanded if any checkbox is on or desktop icons toggle is on
- Enumerate running apps via `NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }`, excluding our own bundle ID
- Hidden entirely when `coordinator.selectedDisplay == nil`

### Phase 4: Focused-window warning pill

- Add `RecordingWarning.Kind.focusedWindowHidden` case
- In `RecordingActor+SourceHealth.swift`, add `checkFocusedWindowVisibility()` to the 500ms health check
- Check `NSWorkspace.shared.frontmostApplication?.bundleIdentifier` against the excluded set
- Fire warning: `"\(appName) is hidden from recording"`, severity `.warning`, not dismissible
- Clear when focus moves to a non-excluded app

### Phase 5: recording.json metadata

- Add `excludedApps` and `desktopIconsHidden` to the session creation payload
- Server stores these in the video's recording metadata

## Key Technical Notes

- `excludingApplications` auto-covers new windows from already-excluded apps. No polling needed.
- `SCStream.updateContentFilter(_:)` works on a live stream without interruption — ~5 lines in `ScreenCaptureManager`.
- Mid-recording filter updates follow the exact pattern of mode switching and PiP position changes (existing precedent in `RecordingActor`).
- No extra permissions beyond existing screen recording entitlement.
- `NSWorkspace.shared.frontmostApplication` provides both `bundleIdentifier` and `localizedName` for the warning pill.
- `NSRunningApplication.activationPolicy == .regular` filters to Dock-visible apps only.

## Out of Scope

- Mid-recording toggling from the popover (may revisit when adding other mid-recording features)
- Per-window exclusion within an app (e.g. exclude one TextEdit window but not another)
- Settings-based always-on exclusion list (per-recording approach chosen instead)
