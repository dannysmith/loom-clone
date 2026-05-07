@testable import LoomClone
import XCTest

final class RecordingTimelineBuilderTests: XCTestCase {
    private func makeBuilder() -> RecordingTimelineBuilder {
        let b = RecordingTimelineBuilder()
        b.setSession(id: "test-id", slug: "test-slug", initialMode: .screenAndCamera, initialPipPosition: .bottomRight)
        b.setPreset(.p1080)
        b.setInputs(
            display: .init(id: 1, width: 3840, height: 2160),
            camera: .init(uniqueID: "cam-1", name: "FaceTime HD"),
            microphone: .init(uniqueID: "mic-1", name: "MacBook Pro Microphone")
        )
        return b
    }

    // MARK: - Basic Build

    func testBuildProducesCorrectSchemaVersion() {
        let timeline = makeBuilder().build()
        XCTAssertEqual(timeline.schemaVersion, RecordingTimeline.currentSchemaVersion)
    }

    func testBuildCapturesSessionMetadata() {
        let timeline = makeBuilder().build()
        XCTAssertEqual(timeline.session.id, "test-id")
        XCTAssertEqual(timeline.session.slug, "test-slug")
        XCTAssertEqual(timeline.session.initialMode, "screenAndCamera")
    }

    func testBuildCapturesPreset() {
        let timeline = makeBuilder().build()
        XCTAssertEqual(timeline.preset.id, "1080p")
        XCTAssertEqual(timeline.preset.width, 1920)
        XCTAssertEqual(timeline.preset.height, 1080)
        XCTAssertEqual(timeline.preset.bitrate, 8_000_000)
    }

    func testBuildCapturesInputs() {
        let timeline = makeBuilder().build()
        XCTAssertEqual(timeline.inputs.display?.id, 1)
        XCTAssertEqual(timeline.inputs.camera?.uniqueID, "cam-1")
        XCTAssertEqual(timeline.inputs.microphone?.uniqueID, "mic-1")
    }

    // MARK: - Start / Stop

    func testMarkStartedSetsAnchorAndEmitsEvent() {
        let b = makeBuilder()
        b.markStarted()
        let timeline = b.build()

        XCTAssertFalse(timeline.session.startedAt.isEmpty)
        XCTAssertEqual(timeline.events.first?.kind, "recording.committed")
        XCTAssertEqual(timeline.events.first?.t, 0)
    }

    func testMarkStoppedSetsDurationAndEmitsEvent() {
        let b = makeBuilder()
        b.markStarted()
        b.markStopped(logicalDuration: 12.5)
        let timeline = b.build()

        XCTAssertEqual(timeline.session.durationSeconds, 12.5)
        XCTAssertNotNil(timeline.session.endedAt)

        let stopEvent = timeline.events.first(where: { $0.kind == "recording.stopped" })
        XCTAssertNotNil(stopEvent)
        XCTAssertEqual(stopEvent?.t, 12.5)
    }

    // MARK: - Segments

    func testRecordSegmentAppendsEntryAndEvent() {
        let b = makeBuilder()
        b.markStarted()
        b.recordSegment(index: 1, filename: "seg_000.m4s", bytes: 50000, duration: 4.0, emittedAt: 0.5)
        let timeline = b.build()

        XCTAssertEqual(timeline.segments.count, 1)
        XCTAssertEqual(timeline.segments[0].filename, "seg_000.m4s")
        XCTAssertEqual(timeline.segments[0].bytes, 50000)
        XCTAssertEqual(timeline.segments[0].durationSeconds, 4.0)
        XCTAssertEqual(timeline.segments[0].uploaded, false)
        XCTAssertNil(timeline.segments[0].uploadError)

        let emitEvent = timeline.events.first(where: { $0.kind == "segment.emitted" })
        XCTAssertNotNil(emitEvent)
    }

    func testRecordUploadResultUpdatesSegment() {
        let b = makeBuilder()
        b.markStarted()
        b.recordSegment(index: 1, filename: "seg_000.m4s", bytes: 50000, duration: 4.0, emittedAt: 0.5)
        b.recordUploadResult(filename: "seg_000.m4s", success: true, error: nil, t: 1.0)
        let timeline = b.build()

        XCTAssertEqual(timeline.segments[0].uploaded, true)
        XCTAssertNil(timeline.segments[0].uploadError)
    }

    func testRecordUploadFailureStoresError() {
        let b = makeBuilder()
        b.markStarted()
        b.recordSegment(index: 1, filename: "seg_000.m4s", bytes: 50000, duration: 4.0, emittedAt: 0.5)
        b.recordUploadResult(filename: "seg_000.m4s", success: false, error: "timeout", t: 1.0)
        let timeline = b.build()

        XCTAssertEqual(timeline.segments[0].uploaded, false)
        XCTAssertEqual(timeline.segments[0].uploadError, "timeout")
    }

    func testUploadResultForUnknownFilenameIsHarmless() {
        let b = makeBuilder()
        b.markStarted()
        b.recordSegment(index: 1, filename: "seg_000.m4s", bytes: 50000, duration: 4.0, emittedAt: 0.5)
        b.recordUploadResult(filename: "seg_999.m4s", success: true, error: nil, t: 1.0)
        let timeline = b.build()

        // Original segment unchanged
        XCTAssertEqual(timeline.segments[0].uploaded, false)
        // Event still recorded (the upload happened, it just didn't match)
        let uploadEvent = timeline.events.first(where: { $0.kind == "segment.uploaded" })
        XCTAssertNotNil(uploadEvent)
    }

    // MARK: - Mode Switching

    func testModeSwitchRecordsEvent() {
        let b = makeBuilder()
        b.markStarted()
        b.recordModeSwitch(from: .screenAndCamera, to: .screenOnly, t: 3.0)
        let timeline = b.build()

        let event = timeline.events.first(where: { $0.kind == "mode.switched" })
        XCTAssertNotNil(event)
        XCTAssertEqual(event?.data?["from"], .string("screenAndCamera"))
        XCTAssertEqual(event?.data?["to"], .string("screenOnly"))
    }

    // MARK: - Pause / Resume

    func testPauseResumeRecordsEvents() {
        let b = makeBuilder()
        b.markStarted()
        b.recordPaused(t: 5.0)
        b.recordResumed(t: 8.0, pauseDuration: 3.0)
        let timeline = b.build()

        let pauseEvent = timeline.events.first(where: { $0.kind == "paused" })
        XCTAssertNotNil(pauseEvent)
        XCTAssertEqual(pauseEvent?.t, 5.0)

        let resumeEvent = timeline.events.first(where: { $0.kind == "resumed" })
        XCTAssertNotNil(resumeEvent)
        XCTAssertEqual(resumeEvent?.data?["pauseDurationSeconds"], .double(3.0))
    }

    // MARK: - Event Ordering

    func testEventsAreSortedByLogicalTime() {
        let b = makeBuilder()
        b.markStarted()
        // Append events out of order
        b.recordSegment(index: 1, filename: "seg_000.m4s", bytes: 50000, duration: 4.0, emittedAt: 4.0)
        b.recordPaused(t: 2.0)
        b.recordResumed(t: 3.0, pauseDuration: 1.0)
        let timeline = b.build()

        let times = timeline.events.map(\.t)
        XCTAssertEqual(times, times.sorted())
    }

    func testStableSortPreservesInsertionOrderForSameT() {
        let b = makeBuilder()
        b.markStarted()
        b.recordPaused(t: 5.0)
        b.recordResumed(t: 5.0, pauseDuration: 0)
        let timeline = b.build()

        let atFive = timeline.events.filter { $0.t == 5.0 }
        XCTAssertEqual(atFive.count, 2)
        XCTAssertEqual(atFive[0].kind, "paused")
        XCTAssertEqual(atFive[1].kind, "resumed")
    }

    // MARK: - Composition Stats

    func testCompositionStatsAbsentForHealthyRecording() {
        let timeline = makeBuilder().build()
        XCTAssertNil(timeline.compositionStats)
    }

    func testCompositionStatsPresentAfterFailure() {
        let b = makeBuilder()
        b.markStarted()
        b.recordCompositionFailure(kind: "renderError", t: 1.0, detail: "GPU timeout")
        b.recordCompositionRebuilt(t: 1.1)
        let timeline = b.build()

        XCTAssertNotNil(timeline.compositionStats)
        XCTAssertEqual(timeline.compositionStats?.renderErrorCount, 1)
        XCTAssertEqual(timeline.compositionStats?.rebuildSuccessCount, 1)
        XCTAssertEqual(timeline.compositionStats?.terminalFailure, false)
    }

    func testTerminalCompositionFailure() {
        let b = makeBuilder()
        b.markStarted()
        b.recordCompositionFailure(kind: "stallTimeout", t: 1.0, detail: nil)
        b.recordCompositionTerminalFailure(t: 1.5, detail: "Rebuild failed")
        let timeline = b.build()

        XCTAssertEqual(timeline.compositionStats?.stallTimeoutCount, 1)
        XCTAssertEqual(timeline.compositionStats?.terminalFailure, true)
    }

    // MARK: - Raw Streams

    func testRawStreamsAbsentWhenNoneRecorded() {
        let timeline = makeBuilder().build()
        XCTAssertNil(timeline.rawStreams)
    }

    func testRawStreamsPopulatedWhenSet() {
        let b = makeBuilder()
        b.setRawScreen(filename: "screen.mov", width: 3840, height: 2160, codec: "prores422proxy", bitrate: 0, bytes: 1_000_000)
        b.setRawCamera(filename: "camera.mp4", width: 1920, height: 1080, codec: "h264", bitrate: 12_000_000, bytes: 500_000)
        b.setRawAudio(filename: "audio.m4a", codec: "aac-lc", bitrate: 192_000, sampleRate: 48000, channels: 2, bytes: 100_000)
        let timeline = b.build()

        XCTAssertNotNil(timeline.rawStreams)
        XCTAssertEqual(timeline.rawStreams?.screen?.filename, "screen.mov")
        XCTAssertEqual(timeline.rawStreams?.camera?.width, 1920)
        XCTAssertEqual(timeline.rawStreams?.audio?.sampleRate, 48000)
    }

    // MARK: - JSON Encoding

    func testTimelineEncodesToValidJSON() throws {
        let b = makeBuilder()
        b.markStarted()
        b.recordSegment(index: 1, filename: "seg_000.m4s", bytes: 50000, duration: 4.0, emittedAt: 0.5)
        b.markStopped(logicalDuration: 5.0)
        let timeline = b.build()

        let data = try JSONEncoder().encode(timeline)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertNotNil(obj)
        XCTAssertEqual(obj?["schemaVersion"] as? Int, RecordingTimeline.currentSchemaVersion)

        let session = obj?["session"] as? [String: Any]
        XCTAssertEqual(session?["id"] as? String, "test-id")
    }
}
