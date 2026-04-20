import Foundation

/// Out-of-band segment healing. Two entry points:
///
/// 1. `scheduleHeal(...)` — fired from the stop flow when `/complete` returns
///    a non-empty `missing` list. Runs silently in the background so the
///    user-visible URL-on-clipboard flow is never blocked.
/// 2. `runStartupScan()` — fired by AppDelegate at app launch. Walks the
///    local recordings directory for any session within the last 3 days
///    whose `recording.json` marks at least one segment `uploaded: false`,
///    and resumes healing. Handles the "app quit mid-heal" case.
///
/// Healing is idempotent on the server (PUT overwrites, /complete re-diffs),
/// so re-running a heal that partially succeeded last time is safe.
///
/// A 404 from the server on any call means the video record was deleted
/// upstream — we write a `.orphaned` sidecar in the local dir and stop
/// retrying that recording forever.
actor HealAgent {
    /// Recordings older than this are not heal-scanned at startup. In
    /// practice a recording that didn't heal on the day it was made is
    /// unlikely to ever heal cleanly.
    private static let startupWindow: TimeInterval = 3 * 24 * 60 * 60

    private let apiClient: APIClient
    private let recordingsRoot: URL

    /// Guard against double-starting the same recording when the post-stop
    /// handoff races the startup scan (shouldn't happen in practice, but
    /// cheap insurance).
    private var inFlight: Set<String> = []

    init(apiClient: APIClient = .shared) {
        self.apiClient = apiClient
        self.recordingsRoot = AppEnvironment.recordingsDirectory
    }

    // MARK: - Public entry points

    /// Post-stop handoff. Fire-and-forget — the caller's flow (URL to
    /// clipboard, panel hide) does not wait for this.
    nonisolated func scheduleHeal(
        videoId: String,
        localDir: URL,
        timelineData: Data,
        missing: [String]
    ) {
        guard !missing.isEmpty else { return }
        Task {
            await self.heal(
                videoId: videoId,
                localDir: localDir,
                timelineData: timelineData
            )
        }
    }

    /// Walk the recordings directory for unhealed sessions within the window
    /// and kick off a heal for each. Returns once scans are *dispatched* —
    /// individual heals run on detached tasks.
    func runStartupScan() async {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: recordingsRoot,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        let cutoff = Date().addingTimeInterval(-Self.startupWindow)

        for entry in entries {
            // Skip orphans — a past heal already confirmed the server lost
            // this recording.
            if fm.fileExists(atPath: entry.appendingPathComponent(".orphaned").path) {
                continue
            }

            let recordingJSON = entry.appendingPathComponent("recording.json")
            guard fm.fileExists(atPath: recordingJSON.path) else { continue }

            // Age gate — use the recording.json modification date as a proxy
            // for when the session ended.
            if let attrs = try? fm.attributesOfItem(atPath: recordingJSON.path),
               let modDate = attrs[.modificationDate] as? Date,
               modDate < cutoff
            {
                continue
            }

            guard let parsed = parseTimelineForHealing(at: recordingJSON) else { continue }
            guard !parsed.unhealedFilenames.isEmpty else { continue }

            Task {
                await self.heal(
                    videoId: parsed.videoId,
                    localDir: entry,
                    timelineData: parsed.timelineData
                )
            }
        }
    }

    // MARK: - Heal core

    private func heal(
        videoId: String,
        localDir: URL,
        timelineData: Data
    ) async {
        if inFlight.contains(videoId) { return }
        inFlight.insert(videoId)
        defer { inFlight.remove(videoId) }

        print("[heal] \(videoId): starting")

        // Authoritative missing list from the server. We trust this over the
        // local `uploaded: false` flags — Phase 3 live retries may have
        // healed some we weren't told about.
        let missing: [String]
        switch await postComplete(videoId: videoId, timelineData: timelineData) {
        case let .ok(_, list):
            missing = list
        case .orphaned:
            markOrphaned(localDir: localDir)
            return
        case let .failure(err):
            print("[heal] \(videoId): initial /complete failed: \(err) — will retry next launch")
            return
        }

        if missing.isEmpty {
            // Server has everything; local flags are stale. Flip them so the
            // next startup scan skips this recording.
            _ = patchRecordingJSON(localDir: localDir) { seg in
                var out = seg
                out.uploaded = true
                out.uploadError = nil
                return out
            }
            print("[heal] \(videoId): nothing missing server-side")
            return
        }

        switch await uploadMissingSegments(videoId: videoId, missing: missing, localDir: localDir) {
        case .orphaned:
            return
        case let .incomplete(count):
            print("[heal] \(videoId): \(count) segment(s) still unhealed — will retry next launch")
            return
        case .allHealed:
            break
        }

        // Re-POST /complete with the updated timeline so the server's
        // recording.json mirrors local `uploaded: true` flags and the
        // status transitions healing → complete.
        let updatedTimeline = (try? Data(contentsOf: localDir.appendingPathComponent("recording.json"))) ?? timelineData
        switch await postComplete(videoId: videoId, timelineData: updatedTimeline) {
        case let .ok(_, finalMissing) where finalMissing.isEmpty:
            print("[heal] \(videoId): complete")
        case let .ok(_, finalMissing):
            print("[heal] \(videoId): final /complete still reports \(finalMissing.count) missing — will retry next launch")
        case .orphaned:
            markOrphaned(localDir: localDir)
        case let .failure(err):
            print("[heal] \(videoId): final /complete failed: \(err) — will retry next launch")
        }
    }

    // MARK: - Segment Upload Loop

    private enum SegmentUploadResult {
        case allHealed
        case incomplete(Int)
        case orphaned
    }

    private func uploadMissingSegments(
        videoId: String,
        missing: [String],
        localDir: URL
    ) async -> SegmentUploadResult {
        var failed: [String] = []
        for filename in missing {
            let filePath = localDir.appendingPathComponent(filename)
            guard FileManager.default.fileExists(atPath: filePath.path) else {
                print("[heal] \(videoId): local file missing, cannot heal \(filename)")
                failed.append(filename)
                continue
            }
            let data: Data
            do {
                data = try Data(contentsOf: filePath)
            } catch {
                print("[heal] \(videoId): read failed for \(filename): \(error)")
                failed.append(filename)
                continue
            }
            let duration = lookupDuration(localDir: localDir, filename: filename) ?? 4.0
            do {
                try await putSegment(
                    videoId: videoId,
                    filename: filename,
                    data: data,
                    duration: duration
                )
                _ = patchRecordingJSON(localDir: localDir) { seg in
                    guard seg.filename == filename else { return seg }
                    var out = seg
                    out.uploaded = true
                    out.uploadError = nil
                    return out
                }
                print("[heal] \(videoId): healed \(filename)")
            } catch HealError.orphaned {
                markOrphaned(localDir: localDir)
                return .orphaned
            } catch {
                print("[heal] \(videoId): PUT failed for \(filename): \(error)")
                failed.append(filename)
            }
        }
        return failed.isEmpty ? .allHealed : .incomplete(failed.count)
    }

    // MARK: - HTTP

    private enum CompleteOutcome {
        case ok(url: String, missing: [String])
        case orphaned
        case failure(String)
    }

    private enum HealError: Error {
        case orphaned
        case server(String)
    }

    private func postComplete(videoId: String, timelineData: Data) async -> CompleteOutcome {
        do {
            var request = try apiClient.authorizedRequest(
                path: "/api/videos/\(videoId)/complete"
            )
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            var body = Data()
            body.append(Data("{\"timeline\":".utf8))
            body.append(timelineData)
            body.append(Data("}".utf8))
            request.httpBody = body

            let (data, http) = try await apiClient.send(request)
            if http.statusCode == 404 { return .orphaned }
            guard http.statusCode == 200 else { return .failure("status \(http.statusCode)") }
            let json = try JSONDecoder().decode(CompleteResponse.self, from: data)
            return .ok(url: json.url, missing: json.missing ?? [])
        } catch APIClient.ClientError.unauthorized {
            // Revoked or invalid key — map to the generic failure path so the
            // caller treats it as retryable-next-launch. A startup scan after
            // the user fixes the key will re-attempt.
            return .failure("unauthorized")
        } catch APIClient.ClientError.missingAPIKey {
            return .failure("missing API key")
        } catch {
            return .failure("\(error)")
        }
    }

    private func putSegment(
        videoId: String,
        filename: String,
        data: Data,
        duration: Double
    ) async throws {
        var request = try apiClient.authorizedRequest(
            path: "/api/videos/\(videoId)/segments/\(filename)"
        )
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(duration), forHTTPHeaderField: "x-segment-duration")

        let (_, http) = try await apiClient.upload(request, from: data)
        if http.statusCode == 404 { throw HealError.orphaned }
        guard http.statusCode == 200 else { throw HealError.server("status \(http.statusCode)") }
    }

    // MARK: - Local state

    private func markOrphaned(localDir: URL) {
        let path = localDir.appendingPathComponent(".orphaned")
        let now = ISO8601DateFormatter().string(from: Date())
        let contents = Data("orphaned: server returned 404 at \(now)\n".utf8)
        try? contents.write(to: path)
        print("[heal] marked orphaned: \(localDir.lastPathComponent)")
    }

    // MARK: - Timeline parsing & patching

    //
    // recording.json is a versioned Encodable on the Swift side; we only need
    // to read a handful of fields and patch flags, so JSONSerialization into
    // [String: Any] avoids pulling the whole schema into Codable-both-ways.

    private struct TimelineParse {
        let videoId: String
        let timelineData: Data
        let unhealedFilenames: [String]
    }

    private func parseTimelineForHealing(at url: URL) -> TimelineParse? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        // Prefer the directory name (matches server's video id exactly) but
        // fall back to session.id if naming drifts for any reason.
        let dirName = url.deletingLastPathComponent().lastPathComponent
        let videoId: String = {
            if !dirName.isEmpty { return dirName }
            if let session = obj["session"] as? [String: Any],
               let id = session["id"] as? String { return id }
            return ""
        }()
        guard !videoId.isEmpty else { return nil }

        var unhealed: [String] = []
        if let segments = obj["segments"] as? [[String: Any]] {
            for s in segments {
                guard let filename = s["filename"] as? String else { continue }
                let uploaded = s["uploaded"] as? Bool ?? false
                if !uploaded { unhealed.append(filename) }
            }
        }
        return TimelineParse(videoId: videoId, timelineData: data, unhealedFilenames: unhealed)
    }

    private func lookupDuration(localDir: URL, filename: String) -> Double? {
        let url = localDir.appendingPathComponent("recording.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard let segments = obj["segments"] as? [[String: Any]] else { return nil }
        for s in segments where (s["filename"] as? String) == filename {
            return s["durationSeconds"] as? Double
        }
        return nil
    }

    private struct PatchSegment {
        let filename: String
        var uploaded: Bool
        var uploadError: String?
    }

    @discardableResult
    private func patchRecordingJSON(
        localDir: URL,
        transform: (PatchSegment) -> PatchSegment
    ) -> Bool {
        let url = localDir.appendingPathComponent("recording.json")
        guard let data = try? Data(contentsOf: url) else { return false }
        guard var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        guard var segments = obj["segments"] as? [[String: Any]] else { return false }

        for i in segments.indices {
            let current = PatchSegment(
                filename: (segments[i]["filename"] as? String) ?? "",
                uploaded: (segments[i]["uploaded"] as? Bool) ?? false,
                uploadError: segments[i]["uploadError"] as? String
            )
            let patched = transform(current)
            segments[i]["uploaded"] = patched.uploaded
            if let err = patched.uploadError {
                segments[i]["uploadError"] = err
            } else {
                segments[i].removeValue(forKey: "uploadError")
            }
        }
        obj["segments"] = segments

        guard let out = try? JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return false }
        do {
            try out.write(to: url)
            return true
        } catch {
            print("[heal] failed to rewrite recording.json: \(error)")
            return false
        }
    }

    private struct CompleteResponse: Decodable {
        let url: String
        let path: String?
        let slug: String
        let missing: [String]?
    }
}
