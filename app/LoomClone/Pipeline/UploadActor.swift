import Foundation

actor UploadActor {
    private let serverBaseURL: String
    private let reachability: ReachabilityMonitor
    private(set) var videoId: String?
    private(set) var slug: String?
    private var pendingSegments: [VideoSegment] = []

    /// The queue-processing Task. Non-nil while segments are being uploaded
    /// or waiting on reachability. Held as a handle so the stop flow can
    /// cancel outstanding work after its grace window expires.
    private var queueTask: Task<Void, Never>?

    /// Fired after each segment upload that reaches a terminal outcome.
    /// Success paths always fire. Failure paths fire only for
    /// non-retryable errors (local file missing, etc.) — network failures
    /// retry forever until either success or the queue task is cancelled,
    /// in which case no callback fires and the segment is left for heal.
    private var onUploadResult: (@Sendable (_ filename: String, _ success: Bool, _ error: String?) -> Void)?

    func setOnUploadResult(
        _ handler: @escaping @Sendable (_ filename: String, _ success: Bool, _ error: String?) -> Void
    ) {
        self.onUploadResult = handler
    }

    init(serverBaseURL: String = "http://localhost:3000") {
        self.serverBaseURL = serverBaseURL
        self.reachability = ReachabilityMonitor()
    }

    // MARK: - Read-only status (plumbing for future UI)

    /// True if the network path is currently satisfied. Reflects only
    /// physical reachability, not server availability.
    func isReachable() -> Bool {
        reachability.isOnline
    }

    /// True if the queue currently has work — either segments pending or
    /// an in-flight upload.
    func hasPendingUploads() -> Bool {
        !pendingSegments.isEmpty || queueTask != nil
    }

    // MARK: - Session Management

    /// Create a new video on the server, returning (id, slug).
    func createSession() async throws -> (id: String, slug: String) {
        var request = URLRequest(url: URL(string: "\(serverBaseURL)/api/videos")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UploadError.serverError("Failed to create video session")
        }

        let json = try JSONDecoder().decode(CreateVideoResponse.self, from: data)
        videoId = json.id
        slug = json.slug

        print("[upload] Session created: id=\(json.id), slug=\(json.slug)")
        return (json.id, json.slug)
    }

    // MARK: - Segment Upload

    func enqueue(_ segment: VideoSegment) {
        pendingSegments.append(segment)
        if queueTask == nil {
            queueTask = Task { await processQueue() }
        }
    }

    private func processQueue() async {
        while !pendingSegments.isEmpty {
            if Task.isCancelled { break }
            let segment = pendingSegments.removeFirst()
            await uploadSegment(segment)
        }
        queueTask = nil
    }

    /// Upload a single segment with unbounded exponential backoff (capped at
    /// 30s between attempts) and a reachability gate. Returns when the
    /// upload succeeds, when the local file can't be read, or when the
    /// encompassing queue task is cancelled.
    private func uploadSegment(_ segment: VideoSegment) async {
        guard let videoId else {
            print("[upload] No video session — dropping segment \(segment.filename)")
            onUploadResult?(segment.filename, false, "no session")
            return
        }

        var attempt = 0
        while !Task.isCancelled {
            attempt += 1

            // Reachability gate: don't burn retries on a destination we
            // can't plausibly reach. Poll rather than block indefinitely so
            // cancellation propagates cleanly.
            while !reachability.isOnline {
                if Task.isCancelled { return }
                do {
                    try await Task.sleep(for: .seconds(1))
                } catch {
                    return
                }
            }

            // Load bytes from local disk on each attempt. Segments that
            // queue up during a long outage don't retain payloads in memory.
            let data: Data
            do {
                data = try Data(contentsOf: segment.localURL)
            } catch {
                print("[upload] Cannot read \(segment.filename) from \(segment.localURL.path): \(error)")
                onUploadResult?(segment.filename, false, "local read failed: \(error)")
                return
            }

            let url = URL(string: "\(serverBaseURL)/api/videos/\(videoId)/segments/\(segment.filename)")!
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue(String(segment.duration), forHTTPHeaderField: "x-segment-duration")

            do {
                let (_, response) = try await URLSession.shared.upload(for: request, from: data)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    throw UploadError.serverError("Status \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                }
                print("[upload] Uploaded \(segment.filename) (\(data.count) bytes)")
                onUploadResult?(segment.filename, true, nil)
                return
            } catch {
                // Cooperative cancellation from the stop-flow grace timeout
                // surfaces as CancellationError here. Leave the segment for
                // heal to pick up rather than logging as a failure.
                if Task.isCancelled { return }

                let delay = min(30.0, pow(2.0, Double(attempt - 1)))
                print("[upload] Retry for \(segment.filename) in \(Int(delay))s (attempt \(attempt)): \(error)")
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
            }
        }
    }

    // MARK: - Drain / Complete

    /// Block until every enqueued segment has finished uploading (success or
    /// non-retryable failure). No timeout — waits forever. Use only when you
    /// have a reason to be certain the queue will drain (e.g. after the user
    /// stops and network is healthy).
    func drainQueue() async {
        while let task = queueTask {
            _ = await task.value
            // Re-check: a post-cancellation enqueue could spawn a new task.
            if queueTask == nil { break }
        }
    }

    /// Drain variant used by the stop flow. Waits up to `timeoutSeconds` for
    /// the queue to empty naturally; if it doesn't, cancels the queue task so
    /// any pending segments are released and returns. Cancelled segments are
    /// left on local disk for Phase 2 healing to reconcile.
    func drainQueue(timeoutSeconds: Double) async {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while queueTask != nil, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }

        if let task = queueTask {
            print(
                "[upload] Drain timeout after \(Int(timeoutSeconds))s — cancelling queue, \(pendingSegments.count) segment(s) left for heal"
            )
            task.cancel()
            _ = await task.value
            pendingSegments.removeAll()
            queueTask = nil
        }
    }

    struct CompleteResult {
        let url: String
        let missing: [String]
    }

    /// Signal recording complete. Assumes the caller has already drained
    /// (or timed out) the upload queue. Sends the timeline JSON so the server
    /// can diff expected vs on-disk and return any `missing` segments.
    /// Idempotent — safe to call repeatedly as heal progresses.
    func complete(timeline: Data? = nil) async throws -> CompleteResult {
        guard let videoId else {
            throw UploadError.noSession
        }

        var request = URLRequest(url: URL(string: "\(serverBaseURL)/api/videos/\(videoId)/complete")!)
        request.httpMethod = "POST"

        if let timeline {
            // Wrap the already-encoded timeline bytes inside `{ "timeline": ... }`.
            // Doing it as raw byte concatenation avoids a decode+re-encode round trip.
            var body = Data()
            body.append(Data("{\"timeline\":".utf8))
            body.append(timeline)
            body.append(Data("}".utf8))
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UploadError.serverError("Status \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }

        let json = try JSONDecoder().decode(CompleteResponse.self, from: data)
        let fullURL = "\(serverBaseURL)\(json.url)"
        let missing = json.missing ?? []
        print("[upload] Complete: \(fullURL) (missing: \(missing.count))")
        return CompleteResult(url: fullURL, missing: missing)
    }

    // MARK: - Cancel

    /// Abandon the recording: drop any pending segments and tell the server
    /// to delete the video. Safe to call even if no session was created.
    func cancel() async {
        queueTask?.cancel()
        _ = await queueTask?.value
        queueTask = nil
        pendingSegments.removeAll()

        guard let videoId else { return }

        var request = URLRequest(url: URL(string: "\(serverBaseURL)/api/videos/\(videoId)")!)
        request.httpMethod = "DELETE"

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                print("[upload] Cancelled server-side: \(videoId)")
            } else {
                print("[upload] Cancel returned status \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
        } catch {
            print("[upload] Cancel failed: \(error)")
        }

        self.videoId = nil
        self.slug = nil
    }

    // MARK: - Types

    enum UploadError: Error {
        case noSession
        case serverError(String)
    }

    private struct CreateVideoResponse: Decodable {
        let id: String
        let slug: String
    }

    private struct CompleteResponse: Decodable {
        let url: String
        let slug: String
        /// Absent in pre-Phase-2 servers; treat as empty when missing.
        let missing: [String]?
    }
}
