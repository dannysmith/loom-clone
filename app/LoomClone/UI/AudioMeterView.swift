import SwiftUI

/// Horizontal input-level meter — matches the style of macOS System Settings →
/// Sound → Input. A 6pt capsule filled with a green→yellow→red gradient whose
/// width tracks the normalised input level (0…1).
///
/// Takes the observable manager directly (not the level value) so that the
/// `@Observable` read happens *inside this view's body*, not the parent's.
/// Otherwise the 20 Hz level updates would invalidate the parent `MenuView`,
/// which rebuilds the `NativePopUpPicker`s and renders the mic picker
/// un-clickable (NSMenuItems get recreated faster than a click completes).
struct AudioMeterView: View {
    let manager: MicrophonePreviewManager

    var body: some View {
        // Reading manager.level here is the whole point — observation is
        // scoped to this view only.
        let level = manager.level

        HStack(spacing: 8) {
            Image(systemName: "mic.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.18))

                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [.green, .green, .yellow, .red],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(0, CGFloat(clamped(level)) * geo.size.width))
                        .animation(.linear(duration: 0.08), value: level)
                }
            }
            .frame(height: 6)
        }
        .frame(height: 16)
    }

    private func clamped(_ x: Float) -> Float {
        min(1, max(0, x))
    }
}
