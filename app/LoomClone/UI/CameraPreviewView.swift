import AVFoundation
import SwiftUI

/// SwiftUI wrapper around `CameraPreviewLayerView`. Wires the supplied
/// `CameraPreviewManager`'s sample buffer callback to the underlying display
/// layer so live camera frames render via `AVSampleBufferDisplayLayer`.
///
/// Both this view (popover preview) and `CameraOverlayWindow` (in-recording
/// overlay) use the same `CameraPreviewLayerView` underneath, just fed by
/// different capture sessions. An optional `CameraAdjustmentsState` is
/// forwarded to the layer view so slider changes are reflected in the preview
/// immediately.
struct CameraPreviewView: NSViewRepresentable {
    let manager: CameraPreviewManager
    let adjustmentsState: CameraAdjustmentsState?

    init(manager: CameraPreviewManager, adjustmentsState: CameraAdjustmentsState? = nil) {
        self.manager = manager
        self.adjustmentsState = adjustmentsState
    }

    func makeNSView(context _: Context) -> CameraPreviewLayerView {
        let view = CameraPreviewLayerView()
        view.setAdjustmentsState(adjustmentsState)
        manager.onSampleBuffer = { [weak view] sampleBuffer in
            view?.enqueue(sampleBuffer)
        }
        return view
    }

    func updateNSView(_ nsView: CameraPreviewLayerView, context _: Context) {
        // Re-wire the callback every update in case SwiftUI swaps the manager.
        nsView.setAdjustmentsState(adjustmentsState)
        manager.onSampleBuffer = { [weak nsView] sampleBuffer in
            nsView?.enqueue(sampleBuffer)
        }
    }

    static func dismantleNSView(_ nsView: CameraPreviewLayerView, coordinator _: ()) {
        nsView.flush()
    }
}
