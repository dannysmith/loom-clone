import SwiftUI

/// A drop-down selector styled to look like SwiftUI's `Picker`, but which
/// reliably fills the horizontal space it's given.
///
/// SwiftUI's `Picker` on macOS uses `NSPopUpButton` under the hood, and
/// `NSPopUpButton` always *draws* at its intrinsic size (the widest menu
/// item's text plus chrome) even when SwiftUI's frame modifiers give it a
/// larger containing rectangle. That's why the Display / Camera / Microphone
/// pickers all ended up at different visible widths.
///
/// This view uses SwiftUI's `Menu` with a fully custom label, so
/// `.frame(maxWidth: .infinity)` actually stretches the visible button.
struct DropdownMenu<ID: Hashable>: View {
    let selection: ID?
    let options: [Option]
    let onSelect: (ID) -> Void

    struct Option: Identifiable {
        let id: ID
        let label: String
    }

    private var selectedLabel: String {
        guard let selection else { return "—" }
        return options.first(where: { $0.id == selection })?.label ?? "—"
    }

    var body: some View {
        Menu {
            ForEach(options) { option in
                Button(option.label) {
                    onSelect(option.id)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(selectedLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: 22)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: 5))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: false, vertical: true)
    }
}
