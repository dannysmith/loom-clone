import Foundation

/// Observable status of the local WhisperKit model. Drives the Settings
/// UI (download button, progress) and gates whether TranscribeAgent
/// attempts any transcription work.
@MainActor
@Observable
final class TranscriptionModelStatus {
    static let shared = TranscriptionModelStatus()

    enum State: Equatable {
        case notDownloaded
        case downloading
        case ready
        case failed(String)
    }

    private(set) var state: State = .notDownloaded

    var isReady: Bool {
        state == .ready
    }

    /// The WhisperKit model this app uses. Single source of truth: passed to
    /// `WhisperKitConfig` by `TranscribeAgent`, and used to derive the
    /// on-disk path below. `nonisolated` so the agent can read it off the
    /// main actor.
    nonisolated static let modelName = "large-v3-v20240930_626MB"

    /// Where WhisperKit puts a downloaded model, relative to the download
    /// base: `models/argmaxinc/whisperkit-coreml/openai_whisper-<modelName>/`.
    /// The `openai_whisper-` prefix is WhisperKit's, not part of the name we
    /// pass it.
    private static var modelSubpath: String {
        "models/argmaxinc/whisperkit-coreml/openai_whisper-\(modelName)"
    }

    private var modelDirectory: URL {
        AppEnvironment.appSupportDirectory
            .appendingPathComponent(Self.modelSubpath)
    }

    init() {
        // Check if model is already downloaded on disk.
        if isModelOnDisk() {
            state = .ready
        }
    }

    /// Quick check: the model directory exists and contains config.json
    /// (which WhisperKit writes as part of the download).
    func isModelOnDisk() -> Bool {
        let configPath = modelDirectory.appendingPathComponent("config.json")
        return FileManager.default.fileExists(atPath: configPath.path)
    }

    func setDownloading() {
        state = .downloading
    }

    func setReady() {
        state = .ready
    }

    func setFailed(_ message: String) {
        state = .failed(message)
    }

    /// Remove the model and its cache from disk.
    func deleteModel() {
        let fm = FileManager.default
        // Remove the model directory itself.
        try? fm.removeItem(at: modelDirectory)
        // Remove the HuggingFace download cache too.
        let cacheDir = AppEnvironment.appSupportDirectory
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml/.cache")
        try? fm.removeItem(at: cacheDir)
        state = .notDownloaded
    }
}
