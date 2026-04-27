@testable import LoomClone
import XCTest

final class RecordingContextBuilderTests: XCTestCase {
    // MARK: - Duration formatting

    func testShortDurationUsesSeconds() {
        let json = makeJson(duration: 45, mode: "screenOnly", hasMic: true)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertTrue(result.hasPrefix("45-second"))
    }

    func testMinuteDuration() {
        let json = makeJson(duration: 180, mode: "screenOnly", hasMic: true)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertTrue(result.hasPrefix("3-minute"))
    }

    func testRoundsDurationToNearestMinute() {
        let json = makeJson(duration: 150, mode: "screenOnly", hasMic: true)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        // 150s rounds to 3 minutes (2.5 rounded)
        XCTAssertTrue(result.hasPrefix("3-minute"))
    }

    // MARK: - Mode descriptions

    func testScreenOnlyWithMic() {
        let json = makeJson(duration: 120, mode: "screenOnly", hasMic: true)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertEqual(result, "2-minute with voiceover screenshare")
    }

    func testCameraOnlyWithMic() {
        let json = makeJson(duration: 720, mode: "cameraOnly", hasMic: true)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertEqual(result, "12-minute with voiceover talking-head recording")
    }

    func testScreenAndCameraWithMic() {
        let json = makeJson(duration: 480, mode: "screenAndCamera", hasMic: true)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertEqual(result, "8-minute with voiceover screenshare with camera overlay")
    }

    // MARK: - Silent recordings

    func testSilentScreenshare() {
        let json = makeJson(duration: 30, mode: "screenOnly", hasMic: false)
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertEqual(result, "30-second silent screenshare")
    }

    // MARK: - Mode switches

    func testModeSwitchScreenAndCamera() {
        let json = makeJson(
            duration: 600,
            mode: "cameraOnly",
            hasMic: true,
            modeSwitches: [["from": "cameraOnly", "to": "screenOnly"]]
        )
        let result = RecordingContextBuilder.buildPreamble(from: json)
        XCTAssertEqual(result, "10-minute with voiceover screenshare and talking-head recording")
    }

    // MARK: - Helpers

    private func makeJson(
        duration: Double,
        mode: String,
        hasMic: Bool,
        includeCamera: Bool = false,
        includeDisplay: Bool = false,
        modeSwitches: [[String: String]] = []
    ) -> [String: Any] {
        let showCamera = includeCamera || mode != "screenOnly"
        let camera: Any = showCamera
            ? ["uniqueID": "cam-1", "name": "FaceTime HD"] as [String: Any]
            : NSNull()
        let microphone: Any = hasMic
            ? ["uniqueID": "mic-1", "name": "MacBook Pro Microphone"] as [String: Any]
            : NSNull()
        let showDisplay = includeDisplay || mode != "cameraOnly"
        let display: Any = showDisplay
            ? ["id": 1, "width": 3840, "height": 2160] as [String: Any]
            : NSNull()

        var events: [[String: Any]] = []
        for modeSwitch in modeSwitches {
            events.append([
                "t": 10.0,
                "wallClock": "2026-01-01T00:00:10.000Z",
                "kind": "mode.switched",
                "data": modeSwitch,
            ])
        }

        return [
            "session": [
                "id": "test-id",
                "slug": "test-slug",
                "initialMode": mode,
                "durationSeconds": duration,
            ] as [String: Any],
            "inputs": [
                "camera": camera,
                "microphone": microphone,
                "display": display,
            ] as [String: Any],
            "events": events,
        ]
    }
}
