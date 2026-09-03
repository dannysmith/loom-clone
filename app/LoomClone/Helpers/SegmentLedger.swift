import Foundation

/// The segment upload ledger inside a session's `recording.json`: which
/// segments the server acknowledged, and which are still on local disk.
///
/// This is the never-lose-footage audit trail. `HealAgent` flips these flags
/// as it uploads, and the startup scan reads them back to decide what still
/// needs work — so a bug here either abandons footage the server never
/// received, or re-uploads forever.
///
/// Free functions over a URL rather than methods on the agent, so the whole
/// read/patch/round-trip contract is exercisable against a temp directory.
///
/// Strategy: `JSONSerialization` preserves the outer object exactly, including
/// fields this type knows nothing about (schema bumps, future additions). Only
/// the segments array is decoded into a strongly-typed `Codable`, patched, and
/// spliced back — so unknown fields survive a round trip untouched.
enum SegmentLedger {
    static let filename = "recording.json"

    /// Codable mirror of one entry in the `segments` array.
    ///
    /// Deliberately its own type rather than `RecordingTimeline.SegmentEntry`:
    /// healing only reads a subset of fields and writes two of them, and this
    /// shape is what lets the round-trip preserve everything else verbatim.
    ///
    /// `index`, `bytes` and `emittedAt` are optional so a file missing one of
    /// them for any reason can still be healed — only `filename`,
    /// `durationSeconds` and the upload flags are actually required.
    /// `JSONEncoder` omits nil values, so a field that was missing on the way
    /// in stays missing on the way out.
    struct Segment: Codable, Equatable {
        let index: Int?
        let filename: String
        let bytes: Int?
        let durationSeconds: Double
        let emittedAt: Double?
        var uploaded: Bool
        var uploadError: String?
    }

    /// Read the segments array. Returns nil when the file is missing,
    /// unreadable, not an object, has no segments array, or has one whose
    /// entries don't decode — every case in which patching would be unsafe.
    static func readSegments(at url: URL) -> [Segment]? {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawSegments = obj["segments"] as? [[String: Any]],
              let segmentsData = try? JSONSerialization.data(withJSONObject: rawSegments)
        else { return nil }
        return try? JSONDecoder().decode([Segment].self, from: segmentsData)
    }

    /// Apply `transform` to every segment and write the file back. Returns the
    /// patched segments so callers can interrogate the post-write state, or
    /// nil if nothing was written — in which case the file on disk is
    /// untouched.
    @discardableResult
    static func patchSegments(
        at url: URL,
        transform: (Segment) -> Segment
    ) -> [Segment]? {
        guard let data = try? Data(contentsOf: url),
              var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var segments = readSegments(at: url)
        else { return nil }

        for i in segments.indices {
            segments[i] = transform(segments[i])
        }

        // Re-serialise the patched segments and splice them back into the
        // outer object so unknown fields are preserved exactly.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let patchedData = try? encoder.encode(segments),
              let patchedAny = try? JSONSerialization.jsonObject(with: patchedData)
        else { return nil }
        obj["segments"] = patchedAny

        guard let out = try? JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return nil }

        do {
            try out.write(to: url)
            return segments
        } catch {
            Log.heal.log("failed to rewrite \(filename): \(error)")
            return nil
        }
    }

    /// Mark every segment uploaded and clear its error. Used when the server
    /// reports nothing missing, so the local flags were merely stale and the
    /// next startup scan can skip this recording.
    @discardableResult
    static func markAllUploaded(at url: URL) -> [Segment]? {
        patchSegments(at: url) { segment in
            var out = segment
            out.uploaded = true
            out.uploadError = nil
            return out
        }
    }

    /// Mark one segment uploaded, leaving the rest alone.
    @discardableResult
    static func markUploaded(_ filename: String, at url: URL) -> [Segment]? {
        patchSegments(at: url) { segment in
            guard segment.filename == filename else { return segment }
            var out = segment
            out.uploaded = true
            out.uploadError = nil
            return out
        }
    }

    /// Filenames of segments the local record says the server never got.
    static func unhealedFilenames(at url: URL) -> [String] {
        (readSegments(at: url) ?? []).filter { !$0.uploaded }.map(\.filename)
    }

    /// Recorded duration of one segment, for the `x-segment-duration` header
    /// on a heal upload.
    static func duration(of filename: String, at url: URL) -> Double? {
        readSegments(at: url)?.first(where: { $0.filename == filename })?.durationSeconds
    }

    /// The video id a session directory belongs to. The directory name is
    /// authoritative — it matches the server's id exactly — with `session.id`
    /// as a fallback if naming ever drifts. Nil when neither is usable.
    static func videoId(forSessionDirectory directory: URL, jsonURL: URL) -> String? {
        let dirName = directory.lastPathComponent
        if !dirName.isEmpty, dirName != "/" { return dirName }
        guard let data = try? Data(contentsOf: jsonURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = obj["session"] as? [String: Any],
              let id = session["id"] as? String,
              !id.isEmpty
        else { return nil }
        return id
    }
}
