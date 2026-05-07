import Foundation

#if canImport(FoundationModels)
    import FoundationModels

    /// Structured output for the on-device description generation.
    /// Properties are generated in declaration order — `topic` forces the model
    /// to identify the subject before producing the final description.
    @available(macOS 26, *)
    @Generable
    struct DescriptionSuggestion {
        @Guide(description: "The main topic of the video in 2-4 words")
        var topic: String

        @Guide(
            description: "A single concise sentence (15-25 words) describing the video's content. Plain, factual, useful. No filler, no marketing language."
        )
        var description: String
    }

    /// Generates a suggested description for a video recording using the on-device
    /// Foundation Model. Returns nil if the model is unavailable, the context
    /// window is exceeded, or generation fails for any reason.
    @available(macOS 26, *)
    enum DescriptionSuggestionGenerator {
        private static let instructions = """
        You write short, punchy descriptions for video recordings.
        Respond with a single sentence, ideally 15 words or fewer, never more than 25.
        State plainly what the video covers. No marketing fluff, no AI-speak.
        Do not start with filler phrases like "In this video", "A walkthrough of", "A quick demo", "An overview of", "This video".
        Use plain declarative language. No quotes. No emojis.
        """

        /// Banned opening phrases — checked case-insensitively after the model
        /// returns. The instructions tell the model to avoid these, but small
        /// on-device models slip through occasionally.
        private static let bannedOpenings: [String] = [
            "in this video",
            "this video",
            "a walkthrough of",
            "a walkthrough",
            "a quick demo",
            "a quick look",
            "a demo of",
            "an overview of",
            "an introduction to",
            "introduction to",
            "a tutorial on",
            "tutorial on",
            "a guide to",
        ]

        /// Generate a description suggestion from the transcript and recording context.
        /// - Parameters:
        ///   - transcript: The plain-text transcript (will be truncated to fit).
        ///   - preamble: Deterministic context string from RecordingContextBuilder.
        ///   - titleHint: Optional title to pass as additional context. Used by
        ///     the model purely as a topic cue — the description does not
        ///     depend on having a title.
        /// - Returns: A suggested description string, or nil on failure.
        static func suggest(
            transcript: String,
            preamble: String,
            titleHint: String?
        ) async -> String? {
            let truncated = truncateTranscript(transcript, maxWords: 800)
            guard !truncated.isEmpty else { return nil }

            let titleLine = titleHint.map { "Suggested title: \($0)" } ?? "Suggested title: (unknown)"

            let prompt = """
            Recording: \(preamble).
            \(titleLine)

            Transcript:
            \(truncated)
            """

            do {
                let session = LanguageModelSession(instructions: instructions)
                let response: DescriptionSuggestion = try await session.respond(
                    to: prompt,
                    generating: DescriptionSuggestion.self
                ).content
                let cleaned = cleanDescription(response.description)
                guard isValidDescription(cleaned) else { return nil }
                return cleaned
            } catch {
                print("[description-suggest] generation failed: \(error)")
                return nil
            }
        }

        // MARK: - Private

        private static func truncateTranscript(_ text: String, maxWords: Int) -> String {
            let words = text.split(whereSeparator: { $0.isWhitespace })
            if words.count <= maxWords { return text }
            return words.prefix(maxWords).joined(separator: " ")
        }

        /// Trim whitespace and strip a single pair of surrounding quotes if present.
        private static func cleanDescription(_ text: String) -> String {
            var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let quotePairs: [(Character, Character)] = [
                ("\"", "\""),
                ("'", "'"),
                ("\u{201C}", "\u{201D}"), // “ ”
                ("\u{2018}", "\u{2019}"), // ‘ ’
            ]
            for (open, close) in quotePairs {
                if cleaned.count >= 2, cleaned.first == open, cleaned.last == close {
                    cleaned = String(cleaned.dropFirst().dropLast())
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    break
                }
            }
            return cleaned
        }

        private static func isValidDescription(_ description: String) -> Bool {
            // Non-empty
            guard !description.isEmpty else { return false }
            // Generous paragraph cap — an over-eager 280 chars is still tweet-sized.
            guard description.count <= 280 else { return false }
            // At least 4 words — anything shorter is likely junk.
            guard description.split(separator: " ").count >= 4 else { return false }

            let lower = description.lowercased()

            // Refusal / meta-response detection
            let refusals = ["i cannot", "i can't", "i'm unable", "as an ai", "sorry"]
            for refusal in refusals where lower.contains(refusal) {
                return false
            }

            // Banned opening filler phrases
            for opening in bannedOpenings where lower.hasPrefix(opening) {
                return false
            }

            return true
        }
    }
#endif
