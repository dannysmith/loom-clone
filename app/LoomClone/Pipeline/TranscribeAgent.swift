import Foundation
import WhisperKit

/// Background transcription agent. Two entry points:
///
/// 1. `runStartupScan()` — walks the recordings directory for sessions
///    within the last 3 days lacking a `.transcribed` sidecar. Processes
///    them sequentially. No-op if the model isn't downloaded.
/// 2. `scheduleTranscription(...)` — fired from the stop flow. Queues a
///    single transcription. No-op if the model isn't downloaded.
///
/// The model download is triggered explicitly from Settings via
/// `downloadModel()`. All transcription is serialized through the actor.
actor TranscribeAgent {
    private static let startupWindow: TimeInterval = 3 * 24 * 60 * 60
    private static let modelName = "large-v3-v20240930_626MB"

    private let apiClient: APIClient
    private let recordingsRoot: URL

    /// Lazily initialised WhisperKit pipeline, created after the model
    /// is confirmed on disk.
    private var whisperPipe: WhisperKit?

    init(apiClient: APIClient = .shared) {
        self.apiClient = apiClient
        self.recordingsRoot = AppEnvironment.recordingsDirectory
    }

    // MARK: - Model download (triggered from Settings)

    /// Downloads the WhisperKit model. Updates TranscriptionModelStatus
    /// so the Settings UI reflects progress. Call from a Task — this
    /// blocks until download + load completes.
    func downloadModel() async {
        let status = await TranscriptionModelStatus.shared
        await status.setDownloading()

        do {
            let pipe = try await createPipeline()
            whisperPipe = pipe
            await status.setReady()
            print("[transcribe] model download complete")
        } catch {
            await status.setFailed(error.localizedDescription)
            print("[transcribe] model download failed: \(error)")
        }
    }

    // MARK: - Public entry points

    /// Post-stop handoff. Fire-and-forget. No-op if model not ready.
    nonisolated func scheduleTranscription(videoId: String, localDir: URL) {
        Task {
            await self.transcribe(videoId: videoId, localDir: localDir)
        }
    }

    /// Walk the recordings directory for un-transcribed sessions within the
    /// window and process them sequentially. No-op if model not ready.
    func runStartupScan() async {
        guard await TranscriptionModelStatus.shared.isReady else { return }

        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: recordingsRoot,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        let cutoff = Date().addingTimeInterval(-Self.startupWindow)
        var pending: [(videoId: String, localDir: URL)] = []

        for entry in entries {
            if fm.fileExists(atPath: entry.appendingPathComponent(".orphaned").path) { continue }
            if fm.fileExists(atPath: entry.appendingPathComponent(".transcribed").path) { continue }

            let audioFile = entry.appendingPathComponent("audio.m4a")
            guard fm.fileExists(atPath: audioFile.path) else { continue }

            if let attrs = try? fm.attributesOfItem(atPath: audioFile.path),
               let modDate = attrs[.modificationDate] as? Date,
               modDate < cutoff
            {
                continue
            }

            let videoId = entry.lastPathComponent
            guard !videoId.isEmpty else { continue }
            pending.append((videoId: videoId, localDir: entry))
        }

        if !pending.isEmpty {
            print("[transcribe] startup scan: \(pending.count) recording(s) to transcribe")
        }

        for item in pending {
            await transcribe(videoId: item.videoId, localDir: item.localDir)
        }
    }

    // MARK: - Core

    private func transcribe(videoId: String, localDir: URL) async {
        guard await TranscriptionModelStatus.shared.isReady else { return }

        let transcribedPath = localDir.appendingPathComponent(".transcribed")
        if FileManager.default.fileExists(atPath: transcribedPath.path) {
            return
        }

        let audioPath = localDir.appendingPathComponent("audio.m4a")
        guard FileManager.default.fileExists(atPath: audioPath.path) else {
            print("[transcribe] \(videoId): no audio.m4a — skipping")
            return
        }

        print("[transcribe] \(videoId): starting")

        let results: [TranscriptionResult]
        do {
            let pipe = try await getOrLoadPipeline()
            results = try await pipe.transcribe(audioPath: audioPath.path)
        } catch {
            print("[transcribe] \(videoId): whisper failed: \(error)")
            return
        }

        guard !results.isEmpty else {
            print("[transcribe] \(videoId): no results from whisper")
            return
        }

        let srt = buildSrt(from: results)

        let captionsPath = localDir.appendingPathComponent("captions.srt")
        do {
            try Data(srt.utf8).write(to: captionsPath)
        } catch {
            print("[transcribe] \(videoId): failed to write local SRT: \(error)")
        }

        do {
            try await uploadTranscript(videoId: videoId, srt: srt)
        } catch TranscribeError.orphaned {
            markOrphaned(localDir: localDir)
            return
        } catch {
            print("[transcribe] \(videoId): upload failed: \(error) — will retry next launch")
            return
        }

        let now = ISO8601DateFormatter().string(from: Date())
        try? Data("transcribed at \(now)\n".utf8).write(to: transcribedPath)
        print("[transcribe] \(videoId): complete")
    }

    // MARK: - WhisperKit Pipeline

    /// Load the already-downloaded model into memory. Does not download.
    private func getOrLoadPipeline() async throws -> WhisperKit {
        if let existing = whisperPipe {
            return existing
        }
        let pipe = try await createPipeline()
        whisperPipe = pipe
        return pipe
    }

    /// Create a WhisperKit pipeline. Downloads the model if not present.
    private func createPipeline() async throws -> WhisperKit {
        let downloadBase = AppEnvironment.appSupportDirectory

        try FileManager.default.createDirectory(
            at: downloadBase,
            withIntermediateDirectories: true
        )

        let config = WhisperKitConfig(
            model: Self.modelName,
            downloadBase: downloadBase,
            verbose: false,
            prewarm: true
        )
        return try await WhisperKit(config)
    }

    // MARK: - SRT Generation

    private func buildSrt(from results: [TranscriptionResult]) -> String {
        var lines: [String] = []
        var cueIndex = 1

        for result in results {
            for segment in result.segments {
                let cleaned = stripSpecialTokens(segment.text)
                guard !cleaned.isEmpty else { continue }
                lines.append("\(cueIndex)")
                lines.append("\(formatSrtTime(segment.start)) --> \(formatSrtTime(segment.end))")
                lines.append(cleaned)
                lines.append("")
                cueIndex += 1
            }
        }

        return lines.joined(separator: "\n")
    }

    /// Remove Whisper special tokens like <|startoftranscript|>, <|en|>,
    /// <|0.00|>, <|endoftext|>, etc.
    private func stripSpecialTokens(_ text: String) -> String {
        text.replacingOccurrences(of: "<\\|[^|]*\\|>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    private func formatSrtTime(_ seconds: Float) -> String {
        let totalMs = Int(seconds * 1000)
        let ms = totalMs % 1000
        let totalSecs = totalMs / 1000
        let s = totalSecs % 60
        let m = (totalSecs / 60) % 60
        let h = totalSecs / 3600
        return String(format: "%02d:%02d:%02d,%03d", h, m, s, ms)
    }

    // MARK: - HTTP

    private enum TranscribeError: Error {
        case orphaned
        case server(String)
    }

    private func uploadTranscript(videoId: String, srt: String) async throws {
        var request = try apiClient.authorizedRequest(
            path: "/api/videos/\(videoId)/transcript"
        )
        request.httpMethod = "PUT"
        request.setValue("application/x-subrip", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(srt.utf8)

        let (_, http) = try await apiClient.send(request)
        if http.statusCode == 404 { throw TranscribeError.orphaned }
        guard http.statusCode == 200 else {
            throw TranscribeError.server("status \(http.statusCode)")
        }
    }

    // MARK: - Local state

    private func markOrphaned(localDir: URL) {
        let path = localDir.appendingPathComponent(".orphaned")
        let now = ISO8601DateFormatter().string(from: Date())
        let contents = Data("orphaned: server returned 404 at \(now)\n".utf8)
        try? contents.write(to: path)
        print("[transcribe] marked orphaned: \(localDir.lastPathComponent)")
    }
}
