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

    private let recordingsRoot: URL

    /// Guard against double-starting the same recording when the post-stop
    /// handoff races the startup scan (shouldn't happen in practice, but
    /// cheap insurance).
    private var inFlight: Set<String> = []

    /// Read fresh per call so a Settings change to `serverURL` propagates
    /// without an app restart. `APIClient.shared` is cheap to construct.
    private var apiClient: APIClient {
        .shared
    }

    init() {
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

            let recordingJSON = recordingJSONURL(in: entry)
            guard fm.fileExists(atPath: recordingJSON.path) else { continue }

            // Age gate — use the recording.json modification date as a proxy
            // for when the session ended.
            if let attrs = try? fm.attributesOfItem(atPath: recordingJSON.path),
               let modDate = attrs[.modificationDate] as? Date,
               modDate < cutoff
            {
                continue
            }

            guard let parsed = parseTimelineForHealing(sessionDirectory: entry, jsonURL: recordingJSON) else { continue }
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

        Log.heal.log("\(videoId): starting")

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
            Log.heal.log("\(videoId): initial /complete failed: \(err) — will retry next launch")
            return
        }

        if missing.isEmpty {
            // Server has everything; local flags are stale. Flip them so the
            // next startup scan skips this recording.
            SegmentLedger.markAllUploaded(at: recordingJSONURL(in: localDir))
            Log.heal.log("\(videoId): nothing missing server-side")
            return
        }

        switch await uploadMissingSegments(videoId: videoId, missing: missing, localDir: localDir) {
        case .orphaned:
            return
        case let .incomplete(count):
            Log.heal.log("\(videoId): \(count) segment(s) still unhealed — will retry next launch")
            return
        case .allHealed:
            break
        }

        // Re-POST /complete with the updated timeline so the server's
        // recording.json mirrors local `uploaded: true` flags and the
        // status transitions healing → complete.
        let updatedTimeline = (try? Data(contentsOf: recordingJSONURL(in: localDir))) ?? timelineData
        switch await postComplete(videoId: videoId, timelineData: updatedTimeline) {
        case let .ok(_, finalMissing) where finalMissing.isEmpty:
            Log.heal.log("\(videoId): complete")
        case let .ok(_, finalMissing):
            Log.heal.log("\(videoId): final /complete still reports \(finalMissing.count) missing — will retry next launch")
        case .orphaned:
            markOrphaned(localDir: localDir)
        case let .failure(err):
            Log.heal.log("\(videoId): final /complete failed: \(err) — will retry next launch")
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
                Log.heal.log("\(videoId): local file missing, cannot heal \(filename)")
                failed.append(filename)
                continue
            }
            let data: Data
            do {
                data = try Data(contentsOf: filePath)
            } catch {
                Log.heal.log("\(videoId): read failed for \(filename): \(error)")
                failed.append(filename)
                continue
            }
            let duration = SegmentLedger.duration(of: filename, at: recordingJSONURL(in: localDir))
                ?? WriterActor.segmentIntervalSeconds
            do {
                try await putSegment(
                    videoId: videoId,
                    filename: filename,
                    data: data,
                    duration: duration
                )
                SegmentLedger.markUploaded(filename, at: recordingJSONURL(in: localDir))
                Log.heal.log("\(videoId): healed \(filename)")
            } catch HealError.orphaned {
                markOrphaned(localDir: localDir)
                return .orphaned
            } catch {
                Log.heal.log("\(videoId): PUT failed for \(filename): \(error)")
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
        Log.heal.log("marked orphaned: \(localDir.lastPathComponent)")
    }

    // MARK: - Timeline parsing

    // The segment read/patch mechanics live in `SegmentLedger` — free
    // functions over a URL, so the audit trail this agent maintains can be
    // tested against a temp directory rather than only in a real recording.

    private func recordingJSONURL(in localDir: URL) -> URL {
        localDir.appendingPathComponent(SegmentLedger.filename)
    }

    private struct TimelineParse {
        let videoId: String
        let timelineData: Data
        let unhealedFilenames: [String]
    }

    /// What the startup scan needs from one session directory: which video it
    /// is, its timeline bytes for the `/complete` POST, and whether anything
    /// is still waiting to be uploaded. Nil when the file can't be used.
    private func parseTimelineForHealing(sessionDirectory: URL, jsonURL: URL) -> TimelineParse? {
        guard let data = try? Data(contentsOf: jsonURL),
              let videoId = SegmentLedger.videoId(forSessionDirectory: sessionDirectory, jsonURL: jsonURL)
        else { return nil }
        return TimelineParse(
            videoId: videoId,
            timelineData: data,
            unhealedFilenames: SegmentLedger.unhealedFilenames(at: jsonURL)
        )
    }

    private struct CompleteResponse: Decodable {
        let url: String
        let slug: String
        let missing: [String]?
    }
}
