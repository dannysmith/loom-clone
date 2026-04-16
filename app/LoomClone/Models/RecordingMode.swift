import Foundation

enum RecordingMode: String, CaseIterable {
    case cameraOnly
    case screenOnly
    case screenAndCamera

    var displayName: String {
        switch self {
        case .cameraOnly: "Camera"
        case .screenOnly: "Screen"
        case .screenAndCamera: "Screen + Camera"
        }
    }

    var systemImage: String {
        switch self {
        case .cameraOnly: "video.fill"
        case .screenOnly: "rectangle.inset.filled"
        case .screenAndCamera: "rectangle.inset.filled.and.person.filled"
        }
    }

    func next() -> RecordingMode {
        let all = RecordingMode.allCases
        let idx = all.firstIndex(of: self)!
        return all[(idx + 1) % all.count]
    }
}
