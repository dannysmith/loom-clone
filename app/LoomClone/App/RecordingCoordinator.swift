import AVFoundation
import Foundation
import ScreenCaptureKit

/// UI-observable state for the recording pipeline.
/// Lives on the main actor so SwiftUI views can bind directly.
/// Delegates actual recording work to RecordingActor.
///
/// Lifecycle methods (start / stop / pause / resume / cancel / terminal-error
/// handling / camera overlay / app-launch observer / timer) live in
/// `RecordingCoordinator+Lifecycle.swift`. Device enumeration lives in
/// `RecordingCoordinator+Devices.swift`. This file holds the observable state
/// and the popover-lifecycle plumbing that owns it.
@MainActor
@Observable
final class RecordingCoordinator {
    // MARK: - Recording State

    var state: RecordingState = .idle
    var mode: RecordingMode = .screenAndCamera {
        didSet {
            if state == .recording || state == .paused {
                Task { await recordingActor?.switchMode(to: mode) }
                updateCameraOverlayVisibility()
            } else if isPopoverOpen {
                // Mode changed from the picker while idle — re-evaluate which
                // previews should be running.
                updatePreviewsForCurrentState()
            }
        }
    }

    // MARK: - Device Selection

    var availableDisplays: [SCDisplay] = []
    var availableCameras: [AVCaptureDevice] = []
    var availableMicrophones: [AVCaptureDevice] = []

    /// Modes that are reachable given the currently-selected sources.
    /// Used to gate the mode picker (and to filter the recording panel's
    /// mode strip during recording, since devices can't change mid-session).
    var availableModes: [RecordingMode] {
        let hasScreen = selectedDisplay != nil
        let hasCamera = selectedCamera != nil
        var modes: [RecordingMode] = []
        if hasScreen { modes.append(.screenOnly) }
        if hasCamera { modes.append(.cameraOnly) }
        if hasScreen, hasCamera { modes.append(.screenAndCamera) }
        return modes
    }

    var selectedDisplay: SCDisplay? {
        didSet {
            // Source change: ensure the current mode is still reachable.
            demoteModeIfUnavailable()
            // Refresh idle-state previews for the new selection.
            if isPopoverOpen, state == .idle {
                updatePreviewsForCurrentState()
            }
        }
    }

    var selectedCamera: AVCaptureDevice? {
        didSet {
            demoteModeIfUnavailable()
            // Only act on the preview if it's actually running right now.
            // Starting the preview is owned by `updatePreviewsForCurrentState()`
            // — not by the selection itself — so that the camera hardware
            // (and the macOS green indicator) is only active while the popover
            // is open and a camera-bearing mode is selected.
            guard cameraPreview.isActive || selectedCamera == nil else { return }
            let camera = selectedCamera
            Task { @MainActor in
                if let camera {
                    await cameraPreview.start(device: camera)
                } else {
                    await cameraPreview.stop()
                }
            }
        }
    }

    var selectedMicrophone: AVCaptureDevice? {
        didSet {
            // Mirror the camera-preview pattern: only act if a preview is
            // already running (or the user just cleared the selection). The
            // popover-lifecycle path in `updatePreviewsForCurrentState()` owns
            // starting the preview, so the mic hardware (and macOS's orange
            // indicator) is only live while the popover is open.
            guard microphonePreview.isActive || selectedMicrophone == nil else { return }
            let mic = selectedMicrophone
            Task { @MainActor in
                if let mic {
                    await microphonePreview.start(device: mic)
                } else {
                    await microphonePreview.stop()
                }
            }
        }
    }

    /// If `mode` is no longer in `availableModes` (because a source went
    /// away), pick the first available mode. If none are available, leave
    /// `mode` alone — the record button is disabled separately.
    private func demoteModeIfUnavailable() {
        let modes = availableModes
        guard !modes.isEmpty else { return }
        if !modes.contains(mode) {
            mode = modes.first!
        }
    }

    // MARK: - Output Preset

    /// Resolution + bitrate of the encoded HLS stream. Capture happens at
    /// native resolution regardless; this controls what the compositor
    /// renders into and what the encoder produces.
    var outputPreset: OutputPreset = .fromID(
        AppEnvironment.defaults.string(forKey: AppEnvironment.outputPresetKey) ?? OutputPreset.default.id
    ) {
        didSet {
            AppEnvironment.defaults.set(outputPreset.id, forKey: AppEnvironment.outputPresetKey)
        }
    }

    /// True if 1440p is meaningful for *any* mode the user could switch into
    /// during this recording. Devices can't change mid-recording, but mode
    /// can — so 1440p is offered whenever EITHER the selected display or the
    /// selected camera can natively feed it. (There is no 4K preset — see
    /// `OutputPreset.p1440` for the reasoning.)
    var is1440pAvailable: Bool {
        let displayOK: Bool = {
            guard let display = selectedDisplay else { return false }
            return Int(ScreenCaptureManager.nativePixelSize(for: display).height) >= 1440
        }()
        let cameraOK: Bool = {
            guard let cam = selectedCamera else { return false }
            return CameraCaptureManager.maxNativeHeight(for: cam) >= 1440
        }()
        return displayOK || cameraOK
    }

    // MARK: - Frame Rate

    /// Target fps for the output video. Orthogonal to resolution — the
    /// effective bitrate is `outputPreset.bitrate × frameRate.bitrateMultiplier`.
    var frameRate: FrameRate = {
        guard let raw = AppEnvironment.defaults.object(forKey: AppEnvironment.frameRateKey) as? Int32 else {
            return .thirtyFPS
        }
        return FrameRate(rawValue: raw) ?? .thirtyFPS
    }() {
        didSet {
            AppEnvironment.defaults.set(frameRate.rawValue, forKey: AppEnvironment.frameRateKey)
        }
    }

    /// True if 60fps is meaningful given the current source selection and
    /// resolution. Uses permissive gating: shown whenever ANY non-None
    /// selected source can deliver 60fps at the current resolution.
    /// Always false for 720p (incoherent intent — see issue #20 decision 6).
    var is60fpsAvailable: Bool {
        guard outputPreset != .p720 else { return false }
        // Screen: any display ≥60Hz supports 60fps capture
        let displayOK: Bool = {
            guard let display = selectedDisplay else { return false }
            return ScreenCaptureManager.refreshRate(for: display.displayID) >= 60
        }()
        let cameraOK: Bool = {
            guard let cam = selectedCamera else { return false }
            return CameraCaptureManager.supports60fps(for: cam, maxHeight: outputPreset.height)
        }()
        return displayOK || cameraOK
    }

    // MARK: - App Exclusion

    /// Bundle IDs currently selected for exclusion. In-memory only — resets
    /// on app restart. Persists across popover open/close within a session.
    var excludedAppBundleIDs: Set<String> = [] {
        didSet { updateRecentlyHidden() }
    }

    /// Whether desktop icons are hidden from recording. Persisted.
    var hideDesktopIcons: Bool = AppEnvironment.hideDesktopIcons {
        didSet { AppEnvironment.hideDesktopIcons = hideDesktopIcons }
    }

    /// Most-recently-hidden bundle IDs (up to 5), persisted across restarts.
    /// Displayed at the top of the app exclusion list in the popover.
    private(set) var recentlyHiddenBundleIDs: [String] = AppEnvironment.recentlyHiddenBundleIDs

    /// Promotes any checked bundle IDs to the front of the recently-hidden list.
    private func updateRecentlyHidden() {
        var recent = recentlyHiddenBundleIDs
        for id in excludedAppBundleIDs {
            recent.removeAll { $0 == id }
            recent.insert(id, at: 0)
        }
        recent = Array(recent.prefix(5))
        recentlyHiddenBundleIDs = recent
        AppEnvironment.recentlyHiddenBundleIDs = recent
    }

    /// NSWorkspace observer token for app launches during recording.
    var appLaunchObserver: NSObjectProtocol?

    // MARK: - Camera Preview & Overlay

    let cameraPreview = CameraPreviewManager()
    let screenPreview = ScreenPreviewManager()
    let microphonePreview = MicrophonePreviewManager()
    var cameraOverlay: CameraOverlayWindow?

    // MARK: - Camera Adjustments

    /// Live white-balance + brightness for the camera feed. Applied to every
    /// live preview surface and the composited HLS stream, but never to the
    /// raw `camera.mp4` master file. Session-only state — intentionally not
    /// persisted in UserDefaults, matching the existing stance on source
    /// selection.
    ///
    /// Mutations flow through to the shared `cameraAdjustmentsState` box in
    /// `didSet` so the compositor and every preview layer pick up the new
    /// value without an actor hop.
    var cameraAdjustments: CameraAdjustments = .default {
        didSet {
            cameraAdjustmentsState.value = cameraAdjustments
        }
    }

    /// Shared reference handed to `CompositionActor`, the popover
    /// `CameraPreviewLayerView`, and the on-screen overlay's layer view. All
    /// three read from it on every frame; none mutate it.
    let cameraAdjustmentsState = CameraAdjustmentsState()

    func resetCameraAdjustments() {
        cameraAdjustments = .default
    }

    // MARK: - Source Health Warnings

    /// Active warnings surfaced by the recording pipeline. Observed by the
    /// floating toolbar to show warning pills above the controls.
    var activeWarnings: [RecordingWarning] = []

    /// Called from RecordingActor's warning callback (via MainActor hop).
    func handleWarningChanged(_ warning: RecordingWarning, isActive: Bool) {
        if isActive {
            if !activeWarnings.contains(where: { $0.id == warning.id }) {
                activeWarnings.append(warning)
            }
        } else {
            activeWarnings.removeAll { $0.id == warning.id }
        }
    }

    /// Dismiss a warning (for dismissible warnings like tier 2 silence).
    func dismissWarning(_ warning: RecordingWarning) {
        activeWarnings.removeAll { $0.id == warning.id }
    }

    // MARK: - Permissions

    var screenPermissionDenied = false

    // MARK: - Server Reachability

    /// Set by `checkServerHealth()`. `true` when the recording server
    /// responded 200 to GET /api/health. Default is `false` so the Record
    /// button is disabled until we've confirmed the server is up.
    private(set) var serverReachable: Bool = false

    private static let healthCheckTimeout: TimeInterval = 2.0

    func checkServerHealth() async {
        do {
            let request = try APIClient.shared.request(
                path: "/api/health",
                timeout: Self.healthCheckTimeout
            )
            let (_, http) = try await APIClient.shared.send(request)
            serverReachable = (http.statusCode == 200)
        } catch {
            serverReachable = false
        }
    }

    // MARK: - Countdown

    /// Seconds remaining in the pre-recording countdown. nil when not counting.
    /// 3 → 2 → 1 → nil (then state transitions to .recording).
    var countdownSeconds: Int?

    /// Total countdown duration. Match Loom's pattern.
    static let countdownDuration: Int = 3

    // MARK: - Timer

    var elapsedSeconds: TimeInterval = 0
    var timerTask: Task<Void, Never>?
    var recordingStartDate: Date?
    var accumulatedBeforePause: TimeInterval = 0

    // MARK: - Chapter Markers

    /// Number of anonymous chapter markers the user has added during the
    /// current recording. Reset at each new recording start. Drives the
    /// badge on the recording-panel chapter button.
    var chapterMarkerCount: Int = 0

    /// Wall-clock timestamp of the last marker press, used to coalesce
    /// rapid double-clicks. A real "I want two chapters here" press
    /// pattern is many seconds apart; anything sub-quarter-second is
    /// accidental.
    var lastChapterMarkerPressAt: Date?
    static let chapterMarkerDebounceInterval: TimeInterval = 0.25

    // MARK: - Result

    struct LastVideoInfo {
        let url: String
        let videoId: String
        let slug: String
        let title: String?
        let visibility: String
    }

    var lastVideo: LastVideoInfo?

    /// Set by `AppDelegate` at launch. Owned there because heal work spans
    /// app lifetime (startup scan + post-stop handoff).
    var healAgent: HealAgent?

    /// Set by `AppDelegate` at launch. Runs Whisper transcription in the
    /// background after recording completes, uploads SRT to the server.
    var transcribeAgent: TranscribeAgent?

    // MARK: - Pipeline

    var recordingActor: RecordingActor?

    /// In-flight startup task — prepare + countdown + commit. Tracked so the
    /// user can cancel mid-countdown by hitting Stop.
    var startupTask: Task<Void, Never>?

    /// Fired when the recording ends via a path that the AppDelegate didn't
    /// trigger itself — currently just the terminal-error escalation, where
    /// `handleTerminalRecordingError` stops the recording in response to a GPU
    /// failure rather than a user click. AppDelegate sets this to hide the
    /// floating RecordingPanel (which it owns) so the UI doesn't get left in a
    /// zombie state.
    ///
    /// Not used by the normal `stopRecording()` / `cancelRecording()` flows —
    /// AppDelegate hides the panel directly in its handlers for those.
    var onTerminalRecordingStop: (@MainActor () -> Void)?

    // MARK: - Popover Lifecycle

    /// True while the menu-bar popover is visible. Used to gate camera-preview
    /// session startup so the macOS camera indicator is only on when the user
    /// is actually looking at the popover (or a recording is running).
    private(set) var isPopoverOpen: Bool = false

    /// Background task that re-enumerates devices while the popover is open,
    /// so newly-plugged-in cameras / mics / displays appear without having
    /// to close and reopen the popover.
    private var deviceRefreshTask: Task<Void, Never>?

    /// How often to re-poll the device lists while the popover is open.
    private static let devicePollInterval: Duration = .seconds(2)

    /// Wait between flipping `state` to `.stopped` (post-recording) and
    /// flipping it back to `.idle`. Long enough for the user to glance at
    /// the toast / pasteboard-grab confirmation, short enough that
    /// reopening the popover shortly after a stop doesn't feel laggy.
    static let stoppedToIdleDelay: Duration = .seconds(8)

    /// Notification observers active while the popover is open. Used to
    /// drive device list refreshes on hot-plug instead of polling.
    private var deviceHotPlugObservers: [NSObjectProtocol] = []

    /// Called when the menu-bar popover is about to become visible.
    /// Kicks off device enumeration + starts the relevant previews + begins
    /// polling for server health (devices use hot-plug notifications).
    func popoverDidOpen() {
        guard !isPopoverOpen else { return }
        isPopoverOpen = true

        Task { @MainActor in
            await self.checkServerHealth()
            await self.refreshDevices()
            self.updatePreviewsForCurrentState()
        }

        installDeviceHotPlugObservers()

        deviceRefreshTask?.cancel()
        deviceRefreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.devicePollInterval)
                if Task.isCancelled { break }
                if !self.isPopoverOpen { break }
                await self.checkServerHealth()
            }
        }
    }

    /// Called when the popover has closed. Stops previews and tears down
    /// the device polling task.
    func popoverWillClose() {
        guard isPopoverOpen else { return }
        isPopoverOpen = false

        deviceRefreshTask?.cancel()
        deviceRefreshTask = nil
        removeDeviceHotPlugObservers()

        // Only stop previews if we're idle. If recording is starting or in
        // progress, the recording flow manages the camera itself.
        if state == .idle {
            Task { @MainActor in
                await cameraPreview.stop()
                await microphonePreview.stop()
            }
            screenPreview.stop()
        }
    }

    private func installDeviceHotPlugObservers() {
        removeDeviceHotPlugObservers()
        let nc = NotificationCenter.default
        let names: [NSNotification.Name] = [
            .AVCaptureDeviceWasConnected,
            .AVCaptureDeviceWasDisconnected,
            NSApplication.didChangeScreenParametersNotification,
        ]
        deviceHotPlugObservers = names.map { name in
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in
                    await self?.refreshDevices()
                }
            }
        }
    }

    private func removeDeviceHotPlugObservers() {
        for observer in deviceHotPlugObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        deviceHotPlugObservers = []
    }

    /// Reconcile camera and screen preview lifecycles with the current
    /// popover + state + mode + selection. Call this after any of those
    /// change while in the idle/popover-open phase.
    private func updatePreviewsForCurrentState() {
        let idleInPopover = isPopoverOpen && state == .idle

        // Camera preview: needed whenever a camera is selected AND the
        // current mode includes camera.
        let wantsCamera = idleInPopover && selectedCamera != nil && mode != .screenOnly
        if wantsCamera, let camera = selectedCamera {
            Task { @MainActor in await cameraPreview.start(device: camera) }
        } else {
            Task { @MainActor in await cameraPreview.stop() }
        }

        // Screen preview: needed whenever a display is selected AND the
        // current mode includes screen.
        let wantsScreen = idleInPopover && selectedDisplay != nil && mode != .cameraOnly
        if wantsScreen, let display = selectedDisplay {
            screenPreview.start(display: display)
        } else {
            screenPreview.stop()
        }

        // Microphone preview: drives the input-level meter. Runs whenever a
        // mic is selected and the popover is open — independent of mode.
        let wantsMic = idleInPopover && selectedMicrophone != nil
        if wantsMic, let mic = selectedMicrophone {
            Task { @MainActor in await microphonePreview.start(device: mic) }
        } else {
            Task { @MainActor in await microphonePreview.stop() }
        }
    }

    // MARK: - Device Enumeration

    /// True after the first successful `refreshDevices` call has populated
    /// initial source selections. Once set, subsequent refreshes don't
    /// override `nil` selections — that lets the user explicitly choose
    /// "None" without it being clobbered by the next device-poll tick.
    var didApplyInitialDefaults = false
}
