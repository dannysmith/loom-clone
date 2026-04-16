import Foundation

enum RecordingState: Equatable {
    case idle
    case countingDown
    case recording
    case paused
    case stopped
}
