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
    private static let minTranscriptionDuration: TimeInterval = 5

    private let recordingsRoot: URL

    /// Lazily initialised WhisperKit pipeline, created after the model
    /// is confirmed on disk.
    private var whisperPipe: WhisperKit?

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

        var pending: [(videoId: String, localDir: URL)] = []

        for entry in entries {
            if LocalRecordings.exists(.orphaned, in: entry) { continue }
            if LocalRecordings.exists(.transcribed, in: entry) { continue }

            let audioFile = audioURL(in: entry)
            guard fm.fileExists(atPath: audioFile.path) else { continue }

            // Age gate — audio.m4a's modification date is a proxy for when
            // the session ended.
            if LocalRecordings.isOutsideStartupWindow(audioFile) { continue }

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

        if LocalRecordings.exists(.transcribed, in: localDir) { return }

        let audioPath = audioURL(in: localDir)
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
            LocalRecordings.markOrphaned(localDir: localDir, log: Log.transcribe)
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
        let (titleResult, _) = await (titleTask, descTask)

        // Chapter title suggestions — only runs if the user added at least
        // one chapter marker during recording. Sequential per-chapter so
        // each generation can see prior titles as context. Skipped entirely
        // on machines without Foundation Models or when no markers exist.
        await suggestChapterTitles(
            videoId: videoId,
            localDir: localDir,
            wordsData: wordsData,
            videoTitle: titleResult
        )

        LocalRecordings.write(.transcribed, in: localDir, note: "transcribed")
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
            model: TranscriptionModelStatus.modelName,
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

    /// PUT a body to `path`, mapping the status code onto this agent's two
    /// error cases.
    ///
    /// `tolerating404` is the difference between the two kinds of upload here.
    /// The transcript artifacts treat a missing video as `.orphaned` — the
    /// record is gone upstream, so stop retrying this recording forever. The
    /// AI suggestions are best-effort: a video deleted before the suggestion
    /// landed isn't a failure, and neither is the server declining to apply it
    /// (which it also answers with 200).
    private func put(
        _ body: Data,
        contentType: String,
        to path: String,
        label: String,
        tolerating404: Bool
    ) async throws {
        let client = APIClient.shared
        var request = try client.authorizedRequest(path: path)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (_, http) = try await client.send(request)
        if http.statusCode == 404 {
            if tolerating404 { return }
            throw TranscribeError.orphaned
        }
        guard http.statusCode == 200 else {
            throw TranscribeError.server("\(label) status \(http.statusCode)")
        }
    }

    private func putJSON(
        _ object: Any,
        to path: String,
        label: String,
        tolerating404: Bool
    ) async throws {
        try await put(
            JSONSerialization.data(withJSONObject: object),
            contentType: "application/json",
            to: path,
            label: label,
            tolerating404: tolerating404
        )
    }

    private func uploadTranscript(videoId: String, srt: String) async throws {
        try await put(
            Data(srt.utf8),
            contentType: "application/x-subrip",
            to: "/api/videos/\(videoId)/transcript",
            label: "transcript",
            tolerating404: false
        )
    }

    private func uploadWords(videoId: String, words: [[String: Any]]) async throws {
        try await putJSON(
            words,
            to: "/api/videos/\(videoId)/words",
            label: "words",
            tolerating404: false
        )
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

            // Upload to server. Don't log the title text — it's derived
            // from the user's transcript and may contain sensitive content.
            do {
                try await uploadSuggestedTitle(videoId: videoId, title: title)
                Log.titleSuggest.log("\(videoId): uploaded")
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

            // Don't log description text — derived from user transcript.
            do {
                try await uploadSuggestedDescription(videoId: videoId, description: description)
                Log.descriptionSuggest.log("\(videoId): uploaded")
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
        try await putJSON(
            ["title": title],
            to: "/api/videos/\(videoId)/suggest-title",
            label: "suggest-title",
            tolerating404: true
        )
    }

    // MARK: - Chapter Title Suggestion

    /// Generate AI-suggested titles for each chapter marker that was added
    /// during recording. Skips the whole step if no markers exist in
    /// `recording.json` — per the issue, AI suggestions only ever update
    /// existing markers, never create them.
    ///
    /// Sequential per-chapter so each call can see the running list of
    /// generated titles for context. Server-side, application is
    /// idempotent: any chapter whose title has been set by the user (or
    /// deleted entirely) wins over the AI guess.
    private func suggestChapterTitles(
        videoId: String,
        localDir: URL,
        wordsData: [[String: Any]],
        videoTitle: String?
    ) async {
        #if canImport(FoundationModels)
            guard #available(macOS 26, *) else { return }

            let recordingJsonURL = localDir.appendingPathComponent("recording.json")
            guard let markers = readChapterMarkers(from: recordingJsonURL),
                  !markers.isEmpty
            else {
                return
            }

            let preamble = RecordingContextBuilder.buildPreamble(from: recordingJsonURL)
                ?? "video recording"
            let videoDuration = readDurationSeconds(from: recordingJsonURL)
                ?? (markers.last?.t ?? 0) + 60

            var priorTitles: [String] = []
            for index in markers.indices {
                let chapter = markers[index]
                let endT = index + 1 < markers.count ? markers[index + 1].t : videoDuration
                let slice = transcriptSlice(words: wordsData, start: chapter.t, end: endT)
                guard !slice.isEmpty else {
                    Log.titleSuggest.log("\(videoId): chapter \(chapter.id) has empty transcript slice — skipping")
                    continue
                }

                guard let title = await ChapterTitleSuggestionGenerator.suggest(
                    chapterTranscript: slice,
                    videoPreamble: preamble,
                    videoTitle: videoTitle,
                    priorChapterTitles: priorTitles
                ) else {
                    Log.titleSuggest.log("\(videoId): chapter \(chapter.id) no usable suggestion")
                    continue
                }

                priorTitles.append(title)

                do {
                    try await uploadSuggestedChapterTitle(
                        videoId: videoId,
                        chapterId: chapter.id,
                        title: title
                    )
                    Log.titleSuggest.log("\(videoId): chapter \(chapter.id) uploaded")
                } catch {
                    Log.titleSuggest.log("\(videoId): chapter \(chapter.id) upload failed: \(error)")
                }
            }
        #endif
    }

    private struct ChapterMarker {
        let id: String
        let t: Double
    }

    /// Read `chapter.marker` events from recording.json, in chronological order.
    /// Returns nil on parse failure, empty array if no markers (caller treats
    /// either as "skip the AI step").
    private func readChapterMarkers(from url: URL) -> [ChapterMarker]? {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        let events = json["events"] as? [[String: Any]] ?? []
        var markers: [ChapterMarker] = []
        for event in events {
            guard event["kind"] as? String == "chapter.marker" else { continue }
            guard let t = event["t"] as? Double, t >= 0 else { continue }
            guard let payload = event["data"] as? [String: Any],
                  let id = payload["id"] as? String, !id.isEmpty
            else { continue }
            markers.append(ChapterMarker(id: id, t: t))
        }
        return markers.sorted { $0.t < $1.t }
    }

    private func readDurationSeconds(from url: URL) -> Double? {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = json["session"] as? [String: Any]
        else { return nil }
        return session["durationSeconds"] as? Double
    }

    /// Build a plain-text transcript covering [start, end) seconds. Word
    /// timings come from whisper's view of the raw mic audio, which is
    /// anchored slightly before the recording timeline's t=0 (raw audio
    /// capture starts at prepare, t=0 anchors at commit). The offset is
    /// usually well under a second — fine for naming purposes, where
    /// being a word or two off at chapter boundaries is invisible.
    private func transcriptSlice(
        words: [[String: Any]],
        start: Double,
        end: Double
    ) -> String {
        guard end > start else { return "" }
        var pieces: [String] = []
        for entry in words {
            guard let word = entry["word"] as? String,
                  let wordStart = entry["start"] as? Double
            else { continue }
            if wordStart < start { continue }
            if wordStart >= end { break }
            pieces.append(word)
        }
        return pieces.joined(separator: " ")
    }

    private func uploadSuggestedChapterTitle(
        videoId: String,
        chapterId: String,
        title: String
    ) async throws {
        try await putJSON(
            ["title": title],
            to: "/api/videos/\(videoId)/chapters/\(chapterId)/suggest-title",
            label: "suggest-chapter-title",
            tolerating404: true
        )
    }

    private func uploadSuggestedDescription(videoId: String, description: String) async throws {
        try await putJSON(
            ["description": description],
            to: "/api/videos/\(videoId)/suggest-description",
            label: "suggest-description",
            tolerating404: true
        )
    }

    // MARK: - Local state

    /// The raw mic master. Whisper transcribes this rather than the
    /// composited HLS output — it's the cleanest audio we have.
    private func audioURL(in localDir: URL) -> URL {
        localDir.appendingPathComponent(RecordingActor.RawWriterSlot.audio.filename)
    }
}
