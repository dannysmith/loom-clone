import SwiftUI
import AVFoundation

/// SwiftUI wrapper around `CameraPreviewLayerView`. Wires the supplied
/// `CameraPreviewManager`'s sample buffer callback to the underlying display
/// layer so live camera frames render via `AVSampleBufferDisplayLayer`.
///
/// Both this view (popover preview) and `CameraOverlayWindow` (in-recording
/// overlay) use the same `CameraPreviewLayerView` underneath, just fed by
/// different capture sessions.
struct CameraPreviewView: NSViewRepresentable {
    let manager: CameraPreviewManager

    func makeNSView(context: Context) -> CameraPreviewLayerView {
        let view = CameraPreviewLayerView()
        manager.onSampleBuffer = { [weak view] sampleBuffer in
            view?.enqueue(sampleBuffer)
        }
        return view
    }

    func updateNSView(_ nsView: CameraPreviewLayerView, context: Context) {
        // Re-wire the callback every update in case SwiftUI swaps the manager.
        manager.onSampleBuffer = { [weak nsView] sampleBuffer in
            nsView?.enqueue(sampleBuffer)
        }
    }

    static func dismantleNSView(_ nsView: CameraPreviewLayerView, coordinator: ()) {
        nsView.flush()
    }
}
