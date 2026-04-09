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
    /// When true, prepend a "None" item to the menu. Choosing it calls
    /// `onSelectNone`. The picker shows the None item as selected when
    /// `selection == nil`.
    let includeNone: Bool
    let noneLabel: String
    let onSelect: (ID) -> Void
    let onSelectNone: () -> Void

    init(
        selection: ID?,
        options: [Option],
        includeNone: Bool = false,
        noneLabel: String = "None",
        onSelect: @escaping (ID) -> Void,
        onSelectNone: @escaping () -> Void = {}
    ) {
        self.selection = selection
        self.options = options
        self.includeNone = includeNone
        self.noneLabel = noneLabel
        self.onSelect = onSelect
        self.onSelectNone = onSelectNone
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect, onSelectNone: onSelectNone)
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
        if includeNone {
            button.addItem(withTitle: noneLabel)
        }
        button.addItems(withTitles: options.map(\.label))

        if let selection,
           let index = options.firstIndex(where: { $0.id == selection }) {
            button.selectItem(at: index + (includeNone ? 1 : 0))
        } else if includeNone {
            // selection == nil → None row is at index 0
            button.selectItem(at: 0)
        } else if button.numberOfItems > 0 {
            button.selectItem(at: 0)
        }

        // Keep the coordinator's view of the option list current so action
        // callbacks can map index → ID.
        context.coordinator.ids = options.map(\.id)
        context.coordinator.includeNone = includeNone
        context.coordinator.onSelect = onSelect
        context.coordinator.onSelectNone = onSelectNone
    }

    @MainActor
    final class Coordinator: NSObject {
        var ids: [ID] = []
        var includeNone: Bool = false
        var onSelect: (ID) -> Void
        var onSelectNone: () -> Void

        init(onSelect: @escaping (ID) -> Void, onSelectNone: @escaping () -> Void) {
            self.onSelect = onSelect
            self.onSelectNone = onSelectNone
        }

        @objc func handleAction(_ sender: NSPopUpButton) {
            let index = sender.indexOfSelectedItem
            if includeNone {
                if index == 0 {
                    onSelectNone()
                    return
                }
                let realIndex = index - 1
                guard realIndex >= 0, realIndex < ids.count else { return }
                onSelect(ids[realIndex])
            } else {
                guard index >= 0, index < ids.count else { return }
                onSelect(ids[index])
            }
        }
    }
}
