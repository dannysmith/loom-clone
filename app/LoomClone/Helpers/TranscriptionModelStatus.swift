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

    /// Expected path where WhisperKit stores the downloaded model.
    /// WhisperKit creates `models/argmaxinc/whisperkit-coreml/<modelName>/`
    /// under the download base.
    private static let modelSubpath = "models/argmaxinc/whisperkit-coreml/openai_whisper-large-v3-v20240930_626MB"

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
