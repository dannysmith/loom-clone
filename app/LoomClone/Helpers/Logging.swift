import Foundation
import os

/// Thin wrapper over `os.Logger` that always logs string-interpolated
/// messages with `.public` privacy. The codebase's diagnostic strings are
/// not sensitive (filenames, timestamps, counts, mode names), and the
/// default `.private` redaction would hide them in Console.app on release
/// builds — defeating the entire reason we adopted OSLog.
///
/// Each call site composes its own message in a Swift string interpolation
/// at the call site (e.g. `Log.recording.log("Started: \(mode)")`), then
/// hands the resulting concrete String to the OS log as a single public
/// payload. We lose per-placeholder typing OSLog supports, which doesn't
/// matter for these strings.
struct LoomLogger {
    private let osLogger: Logger

    init(category: String) {
        osLogger = Logger(subsystem: "is.danny.LoomClone", category: category)
    }

    /// Default level. Shows in Console.app without filtering.
    func log(_ message: String) {
        osLogger.notice("\(message, privacy: .public)")
    }

    func debug(_ message: String) {
        osLogger.debug("\(message, privacy: .public)")
    }

    func error(_ message: String) {
        osLogger.error("\(message, privacy: .public)")
    }
}

enum Log {
    static let app = LoomLogger(category: "app")
    static let camera = LoomLogger(category: "camera")
    static let cameraPreview = LoomLogger(category: "camera-preview")
    static let composition = LoomLogger(category: "composition")
    static let coordinator = LoomLogger(category: "coordinator")
    static let descriptionSuggest = LoomLogger(category: "description-suggest")
    static let devices = LoomLogger(category: "devices")
    static let exclusion = LoomLogger(category: "exclusion")
    static let halLatency = LoomLogger(category: "hal-latency")
    static let heal = LoomLogger(category: "heal")
    static let health = LoomLogger(category: "health")
    static let mic = LoomLogger(category: "mic")
    static let micPreview = LoomLogger(category: "mic-preview")
    static let rawWriter = LoomLogger(category: "raw-writer")
    static let reachability = LoomLogger(category: "reachability")
    static let recording = LoomLogger(category: "recording")
    static let screen = LoomLogger(category: "screen")
    static let screenPreview = LoomLogger(category: "screen-preview")
    static let titleSuggest = LoomLogger(category: "title-suggest")
    static let transcribe = LoomLogger(category: "transcribe")
    static let upload = LoomLogger(category: "upload")
    static let writer = LoomLogger(category: "writer")
}
