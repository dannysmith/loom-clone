import SwiftUI

/// A single warning pill shown above the recording toolbar.
struct WarningPill: View {
    let warning: RecordingWarning
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: iconName)
                .font(.caption)
            Text(warning.message)
                .font(.caption)
                .lineLimit(1)
            if warning.dismissible {
                Button {
                    onDismiss?()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(backgroundColor)
        .clipShape(Capsule())
    }

    private var iconName: String {
        switch warning.severity {
        case .critical: "exclamationmark.triangle.fill"
        case .warning: "exclamationmark.circle.fill"
        }
    }

    private var backgroundColor: Color {
        switch warning.severity {
        case .critical: .red.opacity(0.25)
        case .warning: .orange.opacity(0.25)
        }
    }
}

/// Stacked warning pills shown above the recording controls.
struct WarningBannerView: View {
    let warnings: [RecordingWarning]
    var onDismiss: ((RecordingWarning) -> Void)?

    var body: some View {
        if !warnings.isEmpty {
            VStack(spacing: 4) {
                ForEach(warnings) { warning in
                    WarningPill(warning: warning) {
                        onDismiss?(warning)
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: warnings.map(\.id))
        }
    }
}
