import Foundation

#if canImport(FoundationModels)
    import FoundationModels

    /// Structured output for on-device chapter title generation. Mirrors
    /// `TitleSuggestion`'s pattern: declare the broad topic first so the
    /// model commits to the subject before producing the final title.
    @available(macOS 26, *)
    @Generable
    struct ChapterTitleSuggestion {
        @Guide(description: "The main topic of this chapter in 2-4 words")
        var topic: String

        @Guide(description: "A concise descriptive chapter title in 2 to 6 words")
        var title: String
    }

    /// Generates a suggested title for a single chapter using the on-device
    /// Foundation Model. Returns nil if the model is unavailable, the
    /// transcript slice is too short to be meaningful, or validation fails.
    ///
    /// Chapters are processed in sequence (not concurrently) so that prior
    /// generated titles can be passed as context, helping the model avoid
    /// repetition and stay consistent with the overall video.
    @available(macOS 26, *)
    enum ChapterTitleSuggestionGenerator {
        private static let instructions = """
        You suggest short, descriptive titles for chapters within a video recording.
        Respond with only the title. Do not use quotes or ending punctuation.
        Do not number the chapter (no "Chapter 1:" prefix).
        Do not start with filler like "Introduction to", "Discussion of", "How to".
        Keep it under 6 words. Make each chapter title distinct from the others.
        """

        /// Generate a chapter title suggestion.
        /// - Parameters:
        ///   - chapterTranscript: The transcript slice covering this chapter only.
        ///   - videoPreamble: Deterministic recording context from `RecordingContextBuilder`.
        ///   - videoTitle: The suggested video-level title (passed as context so chapter
        ///     titles complement rather than echo it). May be nil if title suggestion failed.
        ///   - priorChapterTitles: Titles already generated for earlier chapters in this run,
        ///     in playback order. Empty for the first chapter.
        /// - Returns: A suggested title, or nil on failure.
        static func suggest(
            chapterTranscript: String,
            videoPreamble: String,
            videoTitle: String?,
            priorChapterTitles: [String]
        ) async -> String? {
            let truncated = truncateTranscript(chapterTranscript, maxWords: 400)
            guard !truncated.isEmpty else { return nil }

            var promptLines = ["Video: \(videoPreamble)."]
            if let videoTitle, !videoTitle.isEmpty {
                promptLines.append("Video title: \(videoTitle).")
            }
            if !priorChapterTitles.isEmpty {
                let list = priorChapterTitles
                    .enumerated()
                    .map { "  \($0.offset + 1). \($0.element)" }
                    .joined(separator: "\n")
                promptLines.append("Earlier chapters in this video:\n\(list)")
            }
            promptLines.append("")
            promptLines.append("Transcript for this chapter:")
            promptLines.append(truncated)

            let prompt = promptLines.joined(separator: "\n")

            do {
                let session = LanguageModelSession(instructions: instructions)
                let response: ChapterTitleSuggestion = try await session.respond(
                    to: prompt,
                    generating: ChapterTitleSuggestion.self
                ).content
                let title = response.title.trimmingCharacters(
                    in: CharacterSet.whitespacesAndNewlines
                )
                guard isValidTitle(title) else { return nil }
                return title
            } catch {
                Log.titleSuggest.log("chapter generation failed: \(error)")
                return nil
            }
        }

        // MARK: - Private

        private static func truncateTranscript(_ text: String, maxWords: Int) -> String {
            let words = text.split(separator: " ", omittingEmptySubsequences: true)
            if words.count <= maxWords { return text }
            return words.prefix(maxWords).joined(separator: " ")
        }

        private static func isValidTitle(_ title: String) -> Bool {
            guard !title.isEmpty, title.count <= 100 else { return false }
            // Reject single-word output (usually a refusal or generic noun)
            // and bare numerals.
            let words = title.split(separator: " ")
            guard words.count >= 2 else { return false }
            let lower = title.lowercased()
            let refusals = ["i cannot", "i can't", "i'm unable", "as an ai", "sorry"]
            for refusal in refusals where lower.contains(refusal) {
                return false
            }
            // Reject leading "Chapter N:" patterns the model occasionally
            // produces despite instructions.
            if lower.range(of: #"^chapter\s+\d+"#, options: .regularExpression) != nil {
                return false
            }
            return true
        }
    }
#endif
