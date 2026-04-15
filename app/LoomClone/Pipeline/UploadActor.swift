import Foundation

actor UploadActor {

    private let serverBaseURL: String
    private(set) var videoId: String?
    private(set) var slug: String?
    private var pendingSegments: [VideoSegment] = []
    private var isUploading = false

    /// Fired after each segment upload attempt finishes (success or final
    /// failure). Used by RecordingActor to fold results into the timeline.
    /// `error` is nil on success.
    private var onUploadResult: (@Sendable (_ filename: String, _ success: Bool, _ error: String?) -> Void)?

    func setOnUploadResult(
        _ handler: @escaping @Sendable (_ filename: String, _ success: Bool, _ error: String?) -> Void
    ) {
        self.onUploadResult = handler
    }

    init(serverBaseURL: String = "http://localhost:3000") {
        self.serverBaseURL = serverBaseURL
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
        if !isUploading {
            Task { await processQueue() }
        }
    }

    private func processQueue() async {
        isUploading = true

        while !pendingSegments.isEmpty {
            let segment = pendingSegments.removeFirst()
            await uploadSegment(segment)
        }

        isUploading = false
    }

    private func uploadSegment(_ segment: VideoSegment, attempt: Int = 1) async {
        guard let videoId else {
            print("[upload] No video session — dropping segment \(segment.filename)")
            onUploadResult?(segment.filename, false, "no session")
            return
        }

        let url = URL(string: "\(serverBaseURL)/api/videos/\(videoId)/segments/\(segment.filename)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(segment.duration), forHTTPHeaderField: "x-segment-duration")

        do {
            let (_, response) = try await URLSession.shared.upload(for: request, from: segment.data)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw UploadError.serverError("Status \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            print("[upload] Uploaded \(segment.filename) (\(segment.data.count) bytes)")
            onUploadResult?(segment.filename, true, nil)
        } catch {
            if attempt < 3 {
                print("[upload] Retry \(attempt) for \(segment.filename): \(error)")
                try? await Task.sleep(for: .seconds(Double(attempt)))
                await uploadSegment(segment, attempt: attempt + 1)
            } else {
                print("[upload] Failed to upload \(segment.filename) after 3 attempts: \(error)")
                onUploadResult?(segment.filename, false, "\(error)")
            }
        }
    }

    // MARK: - Complete

    /// Block until every enqueued segment has finished uploading (success or
    /// final failure). Call this before building the timeline snapshot so
    /// that upload-result callbacks have had a chance to fold every segment's
    /// outcome into the builder.
    func drainQueue() async {
        while isUploading || !pendingSegments.isEmpty {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    struct CompleteResult: Sendable {
        let url: String
        let missing: [String]
    }

    /// Signal recording complete. Assumes `drainQueue()` has already been
    /// awaited so all uploads are accounted for. If `timeline` is non-nil
    /// it's sent as the JSON body under a `timeline` key — the server
    /// persists it alongside the segments and uses it to diff expected vs
    /// on-disk segments. The response's `missing` is the gap the caller
    /// should heal in the background; empty means fully converged.
    ///
    /// Safe to call repeatedly — each call re-diffs server-side.
    func complete(timeline: Data? = nil) async throws -> CompleteResult {
        // Belt-and-braces: drain again in case anything slipped in.
        await drainQueue()

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
        // Absent in pre-Phase-2 servers; treat as empty when missing.
        let missing: [String]?
    }
}
