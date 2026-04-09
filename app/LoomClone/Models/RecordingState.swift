import Foundation

enum RecordingState: Sendable, Equatable {
    case idle
    case countingDown
    case recording
    case paused
    case stopped
}
