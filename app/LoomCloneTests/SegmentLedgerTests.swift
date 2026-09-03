@testable import LoomClone
import XCTest

/// Tests for the segment upload ledger in `recording.json` — the
/// never-lose-footage audit trail HealAgent maintains.
///
/// Two failure modes matter and both are silent: losing the record that a
/// segment is still unhealed (footage the server never got, never retried),
/// and destroying fields the patcher doesn't know about (a schema bump erased
/// on the first heal). Everything here is exercised against a real temp
/// directory, which is all this ever needed to be testable.
final class SegmentLedgerTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("SegmentLedgerTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        try super.tearDownWithError()
    }

    // MARK: - Fixtures

    private var jsonURL: URL {
        tempDir.appendingPathComponent(SegmentLedger.filename)
    }

    @discardableResult
    private func write(_ object: [String: Any]) throws -> URL {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])
        try data.write(to: jsonURL)
        return jsonURL
    }

    private func writeRaw(_ text: String) throws -> URL {
        try Data(text.utf8).write(to: jsonURL)
        return jsonURL
    }

    private func segment(
        _ filename: String,
        index: Int,
        uploaded: Bool,
        uploadError: String? = nil
    ) -> [String: Any] {
        var out: [String: Any] = [
            "index": index,
            "filename": filename,
            "bytes": 1024 * index,
            "durationSeconds": 4.0,
            "emittedAt": Double(index) * 4.0,
            "uploaded": uploaded,
        ]
        if let uploadError { out["uploadError"] = uploadError }
        return out
    }

    /// A three-segment recording where the middle one failed to upload.
    private func writeTypicalRecording() throws -> URL {
        try write([
            "schemaVersion": 3,
            "session": ["id": "vid-abc", "slug": "my-video", "durationSeconds": 12.0],
            "segments": [
                segment("seg_000.m4s", index: 1, uploaded: true),
                segment("seg_001.m4s", index: 2, uploaded: false, uploadError: "status 502"),
                segment("seg_002.m4s", index: 3, uploaded: true),
            ],
        ])
    }

    private func readBack() throws -> [String: Any] {
        let data = try Data(contentsOf: jsonURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Reading

    func testReadsSegments() throws {
        let url = try writeTypicalRecording()
        let segments = try XCTUnwrap(SegmentLedger.readSegments(at: url))
        XCTAssertEqual(segments.map(\.filename), ["seg_000.m4s", "seg_001.m4s", "seg_002.m4s"])
        XCTAssertEqual(segments.map(\.uploaded), [true, false, true])
        XCTAssertEqual(segments[1].uploadError, "status 502")
    }

    func testReadsSegmentsMissingOptionalFields() throws {
        // Only filename, durationSeconds and the upload flag are required —
        // a file missing the rest must still be healable.
        let url = try write([
            "segments": [["filename": "seg_000.m4s", "durationSeconds": 4.0, "uploaded": false]],
        ])
        let segments = try XCTUnwrap(SegmentLedger.readSegments(at: url))
        XCTAssertEqual(segments.count, 1)
        XCTAssertNil(segments[0].index)
        XCTAssertNil(segments[0].bytes)
        XCTAssertNil(segments[0].emittedAt)
    }

    func testReadsEmptySegmentsArray() throws {
        let url = try write(["segments": []])
        XCTAssertEqual(SegmentLedger.readSegments(at: url), [])
    }

    // MARK: - Reading: refusals

    func testReadReturnsNilForMissingFile() {
        XCTAssertNil(SegmentLedger.readSegments(at: tempDir.appendingPathComponent("nope.json")))
    }

    func testReadReturnsNilForMalformedJSON() throws {
        let url = try writeRaw("{ this is not json")
        XCTAssertNil(SegmentLedger.readSegments(at: url))
    }

    func testReadReturnsNilWhenSegmentsArrayIsAbsent() throws {
        let url = try write(["session": ["id": "vid-abc"]])
        XCTAssertNil(SegmentLedger.readSegments(at: url))
    }

    func testReadReturnsNilWhenASegmentIsMissingARequiredField() throws {
        // Refusing beats silently dropping the entry: a segment we can't
        // decode is a segment we could otherwise forget to heal.
        let url = try write(["segments": [["filename": "seg_000.m4s", "uploaded": false]]])
        XCTAssertNil(SegmentLedger.readSegments(at: url))
    }

    // MARK: - Patching

    func testMarkUploadedFlipsOnlyTheNamedSegment() throws {
        let url = try writeTypicalRecording()
        let patched = try XCTUnwrap(SegmentLedger.markUploaded("seg_001.m4s", at: url))
        XCTAssertEqual(patched.map(\.uploaded), [true, true, true])
        XCTAssertNil(patched[1].uploadError, "a healed segment's stale error must be cleared")

        // And it's actually on disk, not just in the returned value.
        let reread = try XCTUnwrap(SegmentLedger.readSegments(at: url))
        XCTAssertEqual(reread, patched)
    }

    func testMarkUploadedIgnoresAnUnknownFilename() throws {
        let url = try writeTypicalRecording()
        let patched = try XCTUnwrap(SegmentLedger.markUploaded("seg_099.m4s", at: url))
        XCTAssertEqual(patched.map(\.uploaded), [true, false, true])
    }

    func testMarkAllUploadedClearsEveryFlagAndError() throws {
        // The "server says nothing is missing, our flags were stale" path.
        let url = try writeTypicalRecording()
        let patched = try XCTUnwrap(SegmentLedger.markAllUploaded(at: url))
        XCTAssertTrue(patched.allSatisfy(\.uploaded))
        XCTAssertTrue(patched.allSatisfy { $0.uploadError == nil })
    }

    func testPatchIsIdempotent() throws {
        let url = try writeTypicalRecording()
        SegmentLedger.markUploaded("seg_001.m4s", at: url)
        let first = try Data(contentsOf: url)
        SegmentLedger.markUploaded("seg_001.m4s", at: url)
        XCTAssertEqual(try Data(contentsOf: url), first, "re-healing must not churn the file")
    }

    func testPatchPreservesUnknownTopLevelFields() throws {
        // A future schema addition must survive the first heal that touches
        // the file, or healing silently destroys forensics.
        let url = try write([
            "schemaVersion": 99,
            "session": ["id": "vid-abc"],
            "somethingNewFromTheFuture": ["nested": [1, 2, 3]],
            "segments": [segment("seg_000.m4s", index: 1, uploaded: false)],
        ])
        SegmentLedger.markAllUploaded(at: url)

        let obj = try readBack()
        XCTAssertEqual(obj["schemaVersion"] as? Int, 99)
        let future = try XCTUnwrap(obj["somethingNewFromTheFuture"] as? [String: Any])
        XCTAssertEqual(future["nested"] as? [Int], [1, 2, 3])
    }

    func testPatchPreservesUnknownFieldsInsideSegments() throws {
        // A field added to the segment schema later must survive the first
        // heal that touches the file — the patch edits the raw dictionaries
        // rather than re-encoding the typed shape over them.
        var withExtra = segment("seg_000.m4s", index: 1, uploaded: false)
        withExtra["someFutureSegmentField"] = "keep me"
        let url = try write(["segments": [withExtra]])
        SegmentLedger.markAllUploaded(at: url)

        let obj = try readBack()
        let segments = try XCTUnwrap(obj["segments"] as? [[String: Any]])
        XCTAssertEqual(segments[0]["someFutureSegmentField"] as? String, "keep me")
        XCTAssertEqual(segments[0]["filename"] as? String, "seg_000.m4s")
        XCTAssertEqual(segments[0]["uploaded"] as? Bool, true)
    }

    func testPatchPreservesKnownFieldsItDoesNotWrite() throws {
        // Everything except the two upload flags is read-only to the patcher.
        let url = try writeTypicalRecording()
        SegmentLedger.markAllUploaded(at: url)

        let obj = try readBack()
        let segments = try XCTUnwrap(obj["segments"] as? [[String: Any]])
        XCTAssertEqual(segments[1]["index"] as? Int, 2)
        XCTAssertEqual(segments[1]["bytes"] as? Int, 2048)
        XCTAssertEqual(segments[1]["durationSeconds"] as? Double, 4.0)
        XCTAssertEqual(segments[1]["emittedAt"] as? Double, 8.0)
    }

    func testNilFieldsStayAbsentOnRoundTrip() throws {
        let url = try write([
            "segments": [["filename": "seg_000.m4s", "durationSeconds": 4.0, "uploaded": false]],
        ])
        SegmentLedger.markAllUploaded(at: url)

        let obj = try readBack()
        let segments = try XCTUnwrap(obj["segments"] as? [[String: Any]])
        XCTAssertNil(segments[0]["index"])
        XCTAssertNil(segments[0]["bytes"])
        XCTAssertNil(segments[0]["uploadError"])
        XCTAssertEqual(segments[0]["uploaded"] as? Bool, true)
    }

    // MARK: - Patching: refusals

    func testPatchLeavesAMalformedFileUntouched() throws {
        let url = try writeRaw("{ not json at all")
        XCTAssertNil(SegmentLedger.markAllUploaded(at: url))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "{ not json at all")
    }

    func testPatchRefusesAFileWithNoSegmentsArray() throws {
        let url = try write(["session": ["id": "vid-abc"]])
        XCTAssertNil(SegmentLedger.markAllUploaded(at: url))
    }

    func testPatchOfAMissingFileIsANoOp() {
        let missing = tempDir.appendingPathComponent("nope.json")
        XCTAssertNil(SegmentLedger.markAllUploaded(at: missing))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    // MARK: - Derived queries

    func testUnhealedFilenamesListsOnlyUnuploadedSegments() throws {
        let url = try writeTypicalRecording()
        XCTAssertEqual(SegmentLedger.unhealedFilenames(at: url), ["seg_001.m4s"])
    }

    func testUnhealedFilenamesIsEmptyAfterHealing() throws {
        let url = try writeTypicalRecording()
        SegmentLedger.markUploaded("seg_001.m4s", at: url)
        XCTAssertTrue(SegmentLedger.unhealedFilenames(at: url).isEmpty)
    }

    func testUnhealedFilenamesIsEmptyForAnUnreadableFile() throws {
        // The startup scan skips anything with nothing to heal, so an
        // unreadable file must read as "nothing", never crash.
        let url = try writeRaw("broken")
        XCTAssertTrue(SegmentLedger.unhealedFilenames(at: url).isEmpty)
    }

    func testDurationLookup() throws {
        let url = try writeTypicalRecording()
        XCTAssertEqual(SegmentLedger.duration(of: "seg_001.m4s", at: url), 4.0)
        XCTAssertNil(SegmentLedger.duration(of: "seg_099.m4s", at: url))
    }

    // MARK: - Video id resolution

    func testVideoIdPrefersTheDirectoryName() throws {
        // The directory name matches the server's id exactly; session.id is
        // only the fallback.
        let url = try write(["session": ["id": "some-other-id"], "segments": []])
        XCTAssertEqual(
            SegmentLedger.videoId(forSessionDirectory: tempDir, jsonURL: url),
            tempDir.lastPathComponent
        )
    }

    func testVideoIdFallsBackToSessionID() throws {
        let url = try write(["session": ["id": "vid-abc"], "segments": []])
        XCTAssertEqual(
            SegmentLedger.videoId(forSessionDirectory: URL(fileURLWithPath: "/"), jsonURL: url),
            "vid-abc"
        )
    }

    func testVideoIdIsNilWhenNeitherSourceIsUsable() throws {
        let url = try write(["segments": []])
        XCTAssertNil(SegmentLedger.videoId(forSessionDirectory: URL(fileURLWithPath: "/"), jsonURL: url))
    }
}
