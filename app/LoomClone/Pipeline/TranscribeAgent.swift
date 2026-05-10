import AVFoundation
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
    private static let minTranscriptionDuration: TimeInterval = 5
    private static let modelName = "large-v3-v20240930_626MB"

    private let recordingsRoot: URL

    /// Lazily initialised WhisperKit pipeline, created after the model
    /// is confirmed on disk.
    private var whisperPipe: WhisperKit?

    /// Read fresh per call so a Settings change to `serverURL` propagates
    /// without an app restart. `APIClient.shared` is cheap to construct.
    private var apiClient: APIClient {
        .shared
    }

    init() {
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
            Log.transcribe.log("model download complete")
        } catch {
            await status.setFailed(error.localizedDescription)
            Log.transcribe.log("model download failed: \(error)")
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
            Log.transcribe.log("startup scan: \(pending.count) recording(s) to transcribe")
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
            Log.transcribe.log("\(videoId): no audio.m4a — skipping")
            return
        }

        // Skip very short recordings — not worth transcribing.
        let asset = AVURLAsset(url: audioPath)
        if let duration = try? await asset.load(.duration),
           CMTimeGetSeconds(duration) < Self.minTranscriptionDuration
        {
            Log.transcribe.log("\(videoId): audio too short (\(CMTimeGetSeconds(duration))s) — skipping")
            return
        }

        Log.transcribe.log("\(videoId): starting")

        let results: [TranscriptionResult]
        do {
            let pipe = try await getOrLoadPipeline()
            let options = DecodingOptions(wordTimestamps: true)
            results = try await pipe.transcribe(audioPath: audioPath.path, decodeOptions: options)
        } catch {
            Log.transcribe.log("\(videoId): whisper failed: \(error)")
            return
        }

        guard !results.isEmpty else {
            Log.transcribe.log("\(videoId): no results from whisper")
            return
        }

        let srt = buildSrt(from: results)
        let wordsData = buildWordsJson(from: results)

        let captionsPath = localDir.appendingPathComponent("captions.srt")
        do {
            try Data(srt.utf8).write(to: captionsPath)
        } catch {
            Log.transcribe.log("\(videoId): failed to write local SRT: \(error)")
        }

        // Write words.json locally as a backup alongside captions.srt.
        if !wordsData.isEmpty {
            let wordsPath = localDir.appendingPathComponent("words.json")
            do {
                let jsonData = try JSONSerialization.data(withJSONObject: wordsData, options: [.sortedKeys])
                try jsonData.write(to: wordsPath)
            } catch {
                Log.transcribe.log("\(videoId): failed to write local words.json: \(error)")
            }
        }

        do {
            try await uploadTranscript(videoId: videoId, srt: srt)
        } catch TranscribeError.orphaned {
            markOrphaned(localDir: localDir)
            return
        } catch {
            Log.transcribe.log("\(videoId): upload failed: \(error) — will retry next launch")
            return
        }

        // Upload word-level timestamps. Non-fatal — SRT is the primary artifact.
        if !wordsData.isEmpty {
            do {
                try await uploadWords(videoId: videoId, words: wordsData)
                Log.transcribe.log("\(videoId): words.json uploaded (\(wordsData.count) words)")
            } catch {
                Log.transcribe.log("\(videoId): words upload failed: \(error)")
            }
        }

        // Suggest a title and description using on-device Foundation Models.
        // Both run concurrently — failures never block the .transcribed sidecar.
        // Description does not wait for the title; titleHint is nil.
        async let titleTask: String? = suggestTitle(videoId: videoId, localDir: localDir, srt: srt)
        async let descTask: Void = suggestDescription(
            videoId: videoId,
            localDir: localDir,
            srt: srt,
            titleHint: nil
        )
        _ = await (titleTask, descTask)

        let now = ISO8601DateFormatter().string(from: Date())
        try? Data("transcribed at \(now)\n".utf8).write(to: transcribedPath)
        Log.transcribe.log("\(videoId): complete")
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

    // MARK: - SRT & Word-Level Generation

    private func buildWordsJson(from results: [TranscriptionResult]) -> [[String: Any]] {
        var words: [[String: Any]] = []
        for result in results {
            for segment in result.segments {
                guard let wordTimings = segment.words else { continue }
                for word in wordTimings {
                    let cleaned = stripSpecialTokens(word.word)
                    guard !cleaned.isEmpty else { continue }
                    words.append([
                        "word": cleaned,
                        "start": Double(word.start),
                        "end": Double(word.end),
                    ])
                }
            }
        }
        return words
    }

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

    private func uploadWords(videoId: String, words: [[String: Any]]) async throws {
        var request = try apiClient.authorizedRequest(
            path: "/api/videos/\(videoId)/words"
        )
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let jsonData = try JSONSerialization.data(withJSONObject: words)
        request.httpBody = jsonData

        let (_, http) = try await apiClient.send(request)
        if http.statusCode == 404 { throw TranscribeError.orphaned }
        guard http.statusCode == 200 else {
            throw TranscribeError.server("words status \(http.statusCode)")
        }
    }

    // MARK: - Title Suggestion

    /// Attempts to generate and upload a title suggestion using on-device
    /// Foundation Models. Failures are logged and swallowed — never blocks
    /// the transcription flow.
    ///
    /// Returns the generated title (regardless of whether the server applied
    /// it) so the caller can pass it as a topical hint to other suggestion
    /// generators. Returns nil if generation/validation failed.
    private func suggestTitle(videoId: String, localDir: URL, srt: String) async -> String? {
        #if canImport(FoundationModels)
            guard #available(macOS 26, *) else { return nil }

            // Build context preamble from recording.json
            let recordingJsonURL = localDir.appendingPathComponent("recording.json")
            let preamble = RecordingContextBuilder.buildPreamble(from: recordingJsonURL)
                ?? "video recording"

            // Strip SRT timestamps to get plain text for the prompt
            let plainText = stripSrtTimestamps(srt)
            guard !plainText.isEmpty else { return nil }

            guard let title = await TitleSuggestionGenerator.suggest(
                transcript: plainText,
                preamble: preamble
            ) else {
                Log.titleSuggest.log("\(videoId): no usable suggestion")
                return nil
            }

            // Upload to server
            do {
                try await uploadSuggestedTitle(videoId: videoId, title: title)
                Log.titleSuggest.log("\(videoId): \"\(title)\"")
            } catch {
                Log.titleSuggest.log("\(videoId): upload failed: \(error)")
            }
            return title
        #else
            return nil
        #endif
    }

    /// Attempts to generate and upload a description suggestion using on-device
    /// Foundation Models. Independent of title suggestion — runs even if title
    /// generation returned nil. Failures are logged and swallowed.
    private func suggestDescription(
        videoId: String,
        localDir: URL,
        srt: String,
        titleHint: String?
    ) async {
        #if canImport(FoundationModels)
            guard #available(macOS 26, *) else { return }

            let recordingJsonURL = localDir.appendingPathComponent("recording.json")
            let preamble = RecordingContextBuilder.buildPreamble(from: recordingJsonURL)
                ?? "video recording"

            let plainText = stripSrtTimestamps(srt)
            guard !plainText.isEmpty else { return }

            guard let description = await DescriptionSuggestionGenerator.suggest(
                transcript: plainText,
                preamble: preamble,
                titleHint: titleHint
            ) else {
                Log.descriptionSuggest.log("\(videoId): no usable suggestion")
                return
            }

            do {
                try await uploadSuggestedDescription(videoId: videoId, description: description)
                Log.descriptionSuggest.log("\(videoId): \"\(description)\"")
            } catch {
                Log.descriptionSuggest.log("\(videoId): upload failed: \(error)")
            }
        #endif
    }

    /// Strip SRT cue numbers and timestamps, returning just the spoken text.
    private func stripSrtTimestamps(_ srt: String) -> String {
        srt.components(separatedBy: .newlines)
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                // Skip cue numbers (bare integers)
                if Int(trimmed) != nil { return false }
                // Skip timestamp lines (contain " --> ")
                if trimmed.contains(" --> ") { return false }
                // Skip empty lines
                if trimmed.isEmpty { return false }
                return true
            }
            .joined(separator: " ")
    }

    private func uploadSuggestedTitle(videoId: String, title: String) async throws {
        var request = try apiClient.authorizedRequest(
            path: "/api/videos/\(videoId)/suggest-title"
        )
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = try JSONSerialization.data(
            withJSONObject: ["title": title]
        )
        request.httpBody = body

        let (_, http) = try await apiClient.send(request)
        // 404 is fine — video was deleted, not our problem here.
        // Any 2xx is fine (applied or not).
        guard http.statusCode == 200 || http.statusCode == 404 else {
            throw TranscribeError.server("suggest-title status \(http.statusCode)")
        }
    }

    private func uploadSuggestedDescription(videoId: String, description: String) async throws {
        var request = try apiClient.authorizedRequest(
            path: "/api/videos/\(videoId)/suggest-description"
        )
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = try JSONSerialization.data(
            withJSONObject: ["description": description]
        )
        request.httpBody = body

        let (_, http) = try await apiClient.send(request)
        guard http.statusCode == 200 || http.statusCode == 404 else {
            throw TranscribeError.server("suggest-description status \(http.statusCode)")
        }
    }

    // MARK: - Local state

    private func markOrphaned(localDir: URL) {
        let path = localDir.appendingPathComponent(".orphaned")
        let now = ISO8601DateFormatter().string(from: Date())
        let contents = Data("orphaned: server returned 404 at \(now)\n".utf8)
        try? contents.write(to: path)
        Log.transcribe.log("marked orphaned: \(localDir.lastPathComponent)")
    }
}
