import Foundation

/// Builds a short deterministic preamble string describing a recording,
/// suitable for injection into an LLM prompt alongside the transcript.
///
/// Examples:
/// - "3-minute screenshare with voiceover"
/// - "12-minute talking-head recording"
/// - "8-minute screenshare with camera overlay and voiceover"
/// - "45-second silent screenshare"
///
/// Input is the raw JSON from `recording.json` on disk.
enum RecordingContextBuilder {
    /// Build a preamble from the recording.json data at the given URL.
    /// Returns nil if the file can't be read or parsed.
    static func buildPreamble(from recordingJsonURL: URL) -> String? {
        guard let data = try? Data(contentsOf: recordingJsonURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return buildPreamble(from: json)
    }

    /// Build a preamble from an already-parsed recording.json dictionary.
    static func buildPreamble(from json: [String: Any]) -> String {
        let session = json["session"] as? [String: Any]
        let inputs = json["inputs"] as? [String: Any]
        let events = json["events"] as? [[String: Any]] ?? []

        let durationSeconds = session?["durationSeconds"] as? Double ?? 0
        let initialMode = session?["initialMode"] as? String ?? "screenOnly"
        let hasMicrophone = inputs?["microphone"] != nil && !(inputs?["microphone"] is NSNull)
        let hasCamera = inputs?["camera"] != nil && !(inputs?["camera"] is NSNull)
        let hasDisplay = inputs?["display"] != nil && !(inputs?["display"] is NSNull)

        // Count mode switches to detect mixed-mode recordings
        let modeSwitches = events.filter { ($0["kind"] as? String) == "mode.switched" }

        let durationLabel = formatDuration(durationSeconds)
        let modeLabel = describeModes(
            initialMode: initialMode,
            hasCamera: hasCamera,
            hasDisplay: hasDisplay,
            modeSwitches: modeSwitches
        )
        let audioLabel = hasMicrophone ? "with voiceover" : "silent"

        return "\(durationLabel) \(audioLabel) \(modeLabel)"
    }

    // MARK: - Private

    private static func formatDuration(_ seconds: Double) -> String {
        if seconds < 60 {
            let s = Int(seconds.rounded())
            return "\(s)-second"
        }
        let minutes = Int((seconds / 60).rounded())
        return "\(minutes)-minute"
    }

    private static func describeModes(
        initialMode: String,
        hasCamera _: Bool,
        hasDisplay _: Bool,
        modeSwitches: [[String: Any]]
    ) -> String {
        // If there were mode switches, describe the recording as mixed
        if !modeSwitches.isEmpty {
            let modes = Set([initialMode] + modeSwitches.compactMap { modeSwitch in
                modeSwitch["data"] as? [String: Any]
            }.compactMap { $0["to"] as? String })

            if modes.contains("screenOnly"), modes.contains("cameraOnly") {
                return "screenshare and talking-head recording"
            }
            if modes.contains("screenAndCamera"), modes.contains("screenOnly") {
                return "screenshare recording (with camera overlay in parts)"
            }
            if modes.contains("screenAndCamera"), modes.contains("cameraOnly") {
                return "talking-head and screenshare recording"
            }
        }

        // Single mode throughout
        switch initialMode {
        case "cameraOnly":
            return "talking-head recording"
        case "screenOnly":
            return "screenshare"
        case "screenAndCamera":
            return "screenshare with camera overlay"
        default:
            return "recording"
        }
    }
}
