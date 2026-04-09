import Foundation

actor UploadActor {

    private let serverBaseURL: String
    private(set) var videoId: String?
    private(set) var slug: String?
    private var pendingSegments: [VideoSegment] = []
    private var isUploading = false

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
        } catch {
            if attempt < 3 {
                print("[upload] Retry \(attempt) for \(segment.filename): \(error)")
                try? await Task.sleep(for: .seconds(Double(attempt)))
                await uploadSegment(segment, attempt: attempt + 1)
            } else {
                print("[upload] Failed to upload \(segment.filename) after 3 attempts: \(error)")
            }
        }
    }

    // MARK: - Complete

    /// Signal recording complete. Waits for pending uploads, then calls the server.
    func complete() async throws -> String {
        // Wait for queue to drain
        while isUploading || !pendingSegments.isEmpty {
            try await Task.sleep(for: .milliseconds(100))
        }

        guard let videoId else {
            throw UploadError.noSession
        }

        var request = URLRequest(url: URL(string: "\(serverBaseURL)/api/videos/\(videoId)/complete")!)
        request.httpMethod = "POST"

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UploadError.serverError("Failed to complete")
        }

        let json = try JSONDecoder().decode(CompleteResponse.self, from: data)
        let fullURL = "\(serverBaseURL)\(json.url)"
        print("[upload] Complete: \(fullURL)")
        return fullURL
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
    }
}
