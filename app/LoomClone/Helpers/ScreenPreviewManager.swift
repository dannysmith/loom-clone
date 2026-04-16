import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Captures periodic still snapshots of a display for the popover preview.
///
/// Unlike `CameraPreviewManager` this isn't a live video feed — we only
/// refresh the image every few seconds, which is enough for the popover's
/// "what does the screen look like" purpose and avoids running a full
/// `SCStream` just to display the desktop in the menu UI.
@MainActor
@Observable
final class ScreenPreviewManager {
    /// The latest captured image of the selected display. `nil` while the
    /// first capture is in flight or while no display is selected.
    private(set) var image: CGImage?

    @ObservationIgnored
    private var refreshTask: Task<Void, Never>?

    @ObservationIgnored
    private var currentDisplayID: CGDirectDisplayID?

    /// How often to re-snapshot the display while the popover is open.
    /// Screens don't change often and the popover is typically only open for
    /// a few seconds, so this can be quite lax.
    private static let refreshInterval: Duration = .seconds(10)

    /// Maximum width of the preview image. Scaled down from the native
    /// display resolution so we don't pay a full-screen readback for a
    /// 160-point-tall preview slot.
    private static let previewWidth: Int = 640

    /// Start capturing snapshots of the given display. No-op if already
    /// capturing the same display.
    func start(display: SCDisplay) {
        if currentDisplayID == display.displayID, refreshTask != nil { return }
        stop()
        currentDisplayID = display.displayID

        refreshTask = Task { @MainActor in
            await self.capture(display: display)
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.refreshInterval)
                if Task.isCancelled { break }
                await self.capture(display: display)
            }
        }
    }

    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
        currentDisplayID = nil
        image = nil
    }

    private func capture(display: SCDisplay) async {
        do {
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()

            // Downsample to a fixed preview width while preserving the
            // display's actual aspect ratio.
            let aspectRatio = Double(display.width) / Double(display.height)
            let width = Self.previewWidth
            let height = max(1, Int(Double(width) / aspectRatio))
            config.width = width
            config.height = height
            config.showsCursor = true

            let img = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
            self.image = img
        } catch {
            print("[screen-preview] Capture failed: \(error)")
        }
    }
}
