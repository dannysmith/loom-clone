import SwiftUI

/// The orange "something needs your attention before you record" strip shown
/// at the top of the menu popover: an icon, a bold title, and whatever
/// explanation and controls the caller supplies.
///
/// Add banners through this rather than hand-rolling the chrome again: the
/// popover can show several at once, and they need to look like one family.
struct WarningBanner<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var content: Content

    private static var cornerRadius: CGFloat {
        8
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                content
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: Self.cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: Self.cornerRadius)
                .strokeBorder(.orange.opacity(0.3), lineWidth: 1)
        )
    }
}
