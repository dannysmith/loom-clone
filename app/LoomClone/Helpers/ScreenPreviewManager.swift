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
    private var captureTask: Task<Void, Never>?

    @ObservationIgnored
    private var currentDisplayID: CGDirectDisplayID?

    /// Monotonically increasing generation token. Bumped on every start()
    /// and stop(); the in-flight capture compares its captured value
    /// against the current one and bails out if they differ, so a late
    /// SCK callback can't overwrite state after stop() or a display switch.
    @ObservationIgnored
    private var generation: Int = 0

    /// Maximum width of the preview image. Scaled down from the native
    /// display resolution so we don't pay a full-screen readback for a
    /// 160-point-tall preview slot.
    private static let previewWidth: Int = 640

    /// Capture a single snapshot of the given display. No-op if a capture
    /// for this display is already in flight or already produced an image.
    /// The previous design refreshed every 10s, but the popover is usually
    /// open for a few seconds; one snapshot per open is enough.
    func start(display: SCDisplay) {
        if currentDisplayID == display.displayID, image != nil || captureTask != nil { return }
        stop()
        let targetID = display.displayID
        currentDisplayID = targetID
        generation += 1
        let myGeneration = generation
        captureTask = Task { @MainActor [weak self] in
            await self?.capture(display: display, generation: myGeneration)
            // Clear our handle only if no later start() bumped the generation
            // past us. Without this guard a fast re-start() for the same
            // display could be no-op'd because the prior task is still set
            // until it returns.
            guard let self, self.generation == myGeneration else { return }
            self.captureTask = nil
        }
    }

    func stop() {
        captureTask?.cancel()
        captureTask = nil
        currentDisplayID = nil
        image = nil
        generation += 1
    }

    private func capture(display: SCDisplay, generation myGeneration: Int) async {
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
            // Only publish if we're still the active generation. A stop()
            // or display switch during the await would have bumped
            // `generation`; bailing here keeps a late SCK callback from
            // overwriting the new state.
            guard generation == myGeneration else { return }
            self.image = img
        } catch {
            Log.screenPreview.log("Capture failed: \(error)")
        }
    }
}
