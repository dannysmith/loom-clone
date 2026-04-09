import SwiftUI
import AppKit

/// A native `NSPopUpButton` wrapped in `NSViewRepresentable` so that SwiftUI
/// frame modifiers actually stretch the button.
///
/// Why this exists:
/// SwiftUI's own `Picker` on macOS wraps `NSPopUpButton`, but the wrapping
/// leaves the button's Auto Layout horizontal content-hugging priority at
/// `NSLayoutConstraint.Priority.defaultHigh` (the NSPopUpButton default).
/// That means the button actively resists being stretched beyond its
/// intrinsic width (which is computed from the widest menu item's title
/// plus button chrome). `.frame(maxWidth: .infinity)` creates a larger
/// layout rectangle but the NSPopUpButton stays at its intrinsic width and
/// gets left- or center-aligned inside the rectangle.
///
/// Dropping the horizontal hugging priority to `.defaultLow` on the
/// underlying NSView tells Auto Layout "I'm fine being stretched," which
/// lets SwiftUI frame modifiers (and `Form`'s columns layout) actually
/// resize the button.
struct NativePopUpPicker<ID: Hashable>: NSViewRepresentable {

    struct Option {
        let id: ID
        let label: String
    }

    let selection: ID?
    let options: [Option]
    let onSelect: (ID) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect)
    }

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.target = context.coordinator
        button.action = #selector(Coordinator.handleAction(_:))
        button.autoenablesItems = false

        // Allow the button to stretch horizontally to whatever SwiftUI /
        // Auto Layout proposes, instead of clinging to its intrinsic width.
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        // Rebuild the menu in place. `removeAllItems()` + `addItems(withTitles:)`
        // is cheap enough for the tiny device-list cases this is used for.
        button.removeAllItems()
        button.addItems(withTitles: options.map(\.label))

        if let selection,
           let index = options.firstIndex(where: { $0.id == selection }) {
            button.selectItem(at: index)
        } else if button.numberOfItems > 0 {
            button.selectItem(at: 0)
        }

        // Keep the coordinator's view of the option list current so action
        // callbacks can map index → ID.
        context.coordinator.ids = options.map(\.id)
        context.coordinator.onSelect = onSelect
    }

    @MainActor
    final class Coordinator: NSObject {
        var ids: [ID] = []
        var onSelect: (ID) -> Void

        init(onSelect: @escaping (ID) -> Void) {
            self.onSelect = onSelect
        }

        @objc func handleAction(_ sender: NSPopUpButton) {
            let index = sender.indexOfSelectedItem
            guard index >= 0, index < ids.count else { return }
            onSelect(ids[index])
        }
    }
}
