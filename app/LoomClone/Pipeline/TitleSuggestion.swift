import Foundation

#if canImport(FoundationModels)
    import FoundationModels

    /// Structured output for the on-device title generation.
    /// Properties are generated in declaration order — `topic` forces the model
    /// to identify the subject before producing the final title.
    @available(macOS 26, *)
    @Generable
    struct TitleSuggestion {
        @Guide(description: "The main topic of the video in 2-4 words")
        var topic: String

        @Guide(description: "A concise descriptive title for this video in 3 to 8 words")
        var title: String
    }

    /// Generates a suggested title for a video recording using the on-device
    /// Foundation Model. Returns nil if the model is unavailable, the context
    /// window is exceeded, or generation fails for any reason.
    @available(macOS 26, *)
    enum TitleSuggestionGenerator {
        private static let instructions = """
        You suggest short, descriptive titles for video recordings.
        Respond with only the title. Do not use quotes or ending punctuation.
        Do not start with filler like "Introduction to" or "A quick look at" or "How to".
        """

        /// Generate a title suggestion from the transcript and recording context.
        /// - Parameters:
        ///   - transcript: The plain-text transcript (will be truncated to fit).
        ///   - preamble: Deterministic context string from RecordingContextBuilder.
        /// - Returns: A suggested title string, or nil on failure.
        static func suggest(transcript: String, preamble: String) async -> String? {
            let truncated = truncateTranscript(transcript, maxWords: 500)
            guard !truncated.isEmpty else { return nil }

            let prompt = """
            Recording: \(preamble).

            Transcript:
            \(truncated)
            """

            do {
                let session = LanguageModelSession(instructions: instructions)
                let response: TitleSuggestion = try await session.respond(
                    to: prompt,
                    generating: TitleSuggestion.self
                ).content
                let title = response.title.trimmingCharacters(
                    in: CharacterSet.whitespacesAndNewlines
                )
                guard isValidTitle(title) else { return nil }
                return title
            } catch {
                Log.titleSuggest.log("generation failed: \(error)")
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
            // Non-empty
            guard !title.isEmpty else { return false }
            // Not too long (80 chars is generous for a title)
            guard title.count <= 80 else { return false }
            // Not too short (single word is likely garbage)
            guard title.split(separator: " ").count >= 2 else { return false }
            // Not a refusal or meta-response
            let lower = title.lowercased()
            let refusals = ["i cannot", "i can't", "i'm unable", "as an ai", "sorry"]
            for refusal in refusals where lower.contains(refusal) {
                return false
            }
            return true
        }
    }
#endif
