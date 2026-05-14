import Foundation
#if canImport(AppKit)
    import AppKit
#endif

// MARK: - Builder

/// Mutable accumulator used during recording. Confined to `RecordingActor` —
/// all access is serialised by the actor. `@unchecked Sendable` so the builder
/// can be stored as actor state without tripping strict concurrency checks.
final class RecordingTimelineBuilder: @unchecked Sendable {
    private var sessionId: String = ""
    private var slug: String = ""
    private var initialMode: RecordingMode = .screenAndCamera
    private var initialPipPosition: PipPosition = .bottomRight
    private var startedAt: Date?
    private var endedAt: Date?
    private var durationSeconds: Double?
    private var inputs: RecordingTimeline.Inputs = .init(display: nil, camera: nil, microphone: nil)
    private var preset: OutputPreset = .default
    private var fps: Int32 = FrameRate.thirtyFPS.rawValue
    private var rawScreen: RecordingTimeline.RawStreams.VideoStream?
    private var rawCamera: RecordingTimeline.RawStreams.VideoStream?
    private var rawAudio: RecordingTimeline.RawStreams.AudioStream?
    private var exclusions: RecordingTimeline.Exclusions?
    private var renderErrorCount: Int = 0
    private var stallTimeoutCount: Int = 0
    private var rebuildSuccessCount: Int = 0
    private var terminalCompositionFailure: Bool = false
    private var runtime: RecordingTimeline.Runtime?
    private var segments: [RecordingTimeline.SegmentEntry] = []
    private var events: [RecordingTimeline.Event] = []

    /// Wall clock at which t=0 on the timeline is anchored. Set at commit,
    /// matches the recording clock anchor in RecordingActor.
    private var anchorWallClock: Date?

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func setSession(id: String, slug: String, initialMode: RecordingMode, initialPipPosition: PipPosition) {
        self.sessionId = id
        self.slug = slug
        self.initialMode = initialMode
        self.initialPipPosition = initialPipPosition
    }

    func setPreset(_ preset: OutputPreset, fps: Int32 = FrameRate.thirtyFPS.rawValue) {
        self.preset = preset
        self.fps = fps
    }

    func setExclusions(_ exclusions: RecordingTimeline.Exclusions?) {
        self.exclusions = exclusions
    }

    func setRawScreen(filename: String, width: Int, height: Int, codec: String, bitrate: Int, bytes: Int64, failed: Bool = false) {
        rawScreen = .init(
            filename: filename,
            width: width,
            height: height,
            videoCodec: codec,
            bitrate: bitrate,
            bytes: bytes,
            failed: failed ? true : nil
        )
    }

    func setRawCamera(filename: String, width: Int, height: Int, codec: String, bitrate: Int, bytes: Int64, failed: Bool = false) {
        rawCamera = .init(
            filename: filename,
            width: width,
            height: height,
            videoCodec: codec,
            bitrate: bitrate,
            bytes: bytes,
            failed: failed ? true : nil
        )
    }

    func setRawAudio(filename: String, codec: String, bitrate: Int, sampleRate: Int, channels: Int, bytes: Int64, failed: Bool = false) {
        rawAudio = .init(
            filename: filename,
            audioCodec: codec,
            bitrate: bitrate,
            sampleRate: sampleRate,
            channels: channels,
            bytes: bytes,
            failed: failed ? true : nil
        )
    }

    func setInputs(
        display: RecordingTimeline.Inputs.Display?,
        camera: RecordingTimeline.Inputs.Device?,
        microphone: RecordingTimeline.Inputs.Device?
    ) {
        self.inputs = .init(display: display, camera: camera, microphone: microphone)
    }

    /// Phase 4 (task-21): attach the camera's advertised + selected
    /// format details to the existing `inputs.camera` entry. Called
    /// after camera capture has actually started and we know what
    /// AVCaptureSession picked. Rebuilds the `Device` immutably rather
    /// than mutating in place.
    func setCameraFormatDetails(
        advertised: [RecordingTimeline.Inputs.AdvertisedFormat]?,
        selected: RecordingTimeline.Inputs.SelectedFormat?
    ) {
        guard let existing = inputs.camera else { return }
        let updated = RecordingTimeline.Inputs.Device(
            uniqueID: existing.uniqueID,
            name: existing.name,
            halInputLatencyMs: existing.halInputLatencyMs,
            advertisedFormats: advertised,
            selectedFormat: selected
        )
        self.inputs = .init(display: inputs.display, camera: updated, microphone: inputs.microphone)
    }

    /// Phase 4: aggregate runtime metrics computed at stop time from
    /// diagnostic histograms + counters.
    func setRuntime(_ runtime: RecordingTimeline.Runtime) {
        self.runtime = runtime
    }

    /// Called at commit — anchors t=0 and marks the session start.
    func markStarted() {
        let now = Date()
        anchorWallClock = now
        startedAt = now
        appendEvent(t: 0, kind: "recording.committed", data: nil)
    }

    func markStopped(logicalDuration: Double) {
        endedAt = Date()
        durationSeconds = logicalDuration
        appendEvent(t: logicalDuration, kind: "recording.stopped", data: nil)
    }

    func recordModeSwitch(from: RecordingMode, to: RecordingMode, t: Double) {
        appendEvent(
            t: t,
            kind: "mode.switched",
            data: [
                "from": .string(from.rawValue),
                "to": .string(to.rawValue),
            ]
        )
    }

    func recordPipPositionChanged(from: PipPosition, to: PipPosition, t: Double) {
        appendEvent(
            t: t,
            kind: "pip.position.changed",
            data: [
                "from": .string(from.rawValue),
                "to": .string(to.rawValue),
            ]
        )
    }

    func recordPaused(t: Double) {
        appendEvent(t: t, kind: "paused", data: nil)
    }

    /// Anonymous chapter marker created by the user during recording. `id`
    /// is a UUID generated at press time so the server can match server-side
    /// chapter records back to the originating press (used by the AI
    /// title-suggestion flow to update the right chapter even if the user
    /// has added/removed others in the admin in the meantime).
    func recordChapterMarker(id: String, t: Double) {
        appendEvent(
            t: t,
            kind: "chapter.marker",
            data: ["id": .string(id)]
        )
    }

    func recordResumed(t: Double, pauseDuration: Double) {
        appendEvent(
            t: t,
            kind: "resumed",
            data: ["pauseDurationSeconds": .double(pauseDuration)]
        )
    }

    func recordSegment(
        index: Int,
        filename: String,
        bytes: Int,
        duration: Double,
        emittedAt: Double
    ) {
        segments.append(
            .init(
                index: index,
                filename: filename,
                bytes: bytes,
                durationSeconds: duration,
                emittedAt: emittedAt,
                uploaded: false,
                uploadError: nil
            )
        )
        appendEvent(
            t: emittedAt,
            kind: "segment.emitted",
            data: [
                "filename": .string(filename),
                "bytes": .int(bytes),
                "durationSeconds": .double(duration),
            ]
        )
    }

    func recordUploadResult(filename: String, success: Bool, error: String?, t: Double) {
        if let idx = segments.firstIndex(where: { $0.filename == filename }) {
            segments[idx].uploaded = success
            segments[idx].uploadError = error
        }
        var data: [String: JSONValue] = ["filename": .string(filename)]
        if let error { data["error"] = .string(error) }
        appendEvent(
            t: t,
            kind: success ? "segment.uploaded" : "segment.uploadFailed",
            data: data
        )
    }

    func recordError(message: String, t: Double) {
        appendEvent(t: t, kind: "error", data: ["message": .string(message)])
    }

    /// Called by RecordingActor when the compositor reports a render failure
    /// or a stall. `kind` is `"renderError"` or `"stallTimeout"`. Emits an
    /// event and increments the matching counter.
    func recordCompositionFailure(kind: String, t: Double, detail: String?) {
        switch kind {
        case "renderError": renderErrorCount += 1
        case "stallTimeout": stallTimeoutCount += 1
        default: break
        }
        var data: [String: JSONValue] = ["kind": .string(kind)]
        if let detail { data["detail"] = .string(detail) }
        appendEvent(t: t, kind: "composition.failed", data: data)
    }

    /// Called after a successful `CompositionActor.rebuildContext()`.
    func recordCompositionRebuilt(t: Double) {
        rebuildSuccessCount += 1
        appendEvent(t: t, kind: "composition.rebuilt", data: nil)
    }

    /// Called once if rebuild itself fails and the recording escalates to a
    /// clean terminal stop. The `recording.stopped` event still fires at the
    /// usual stop-time path.
    func recordCompositionTerminalFailure(t: Double, detail: String?) {
        terminalCompositionFailure = true
        var data: [String: JSONValue] = [:]
        if let detail { data["detail"] = .string(detail) }
        appendEvent(
            t: t,
            kind: "composition.terminalFailure",
            data: data.isEmpty ? nil : data
        )
    }

    /// Called when a raw stream writer begins accepting samples.
    func recordRawWriterStarted(file: String, t: Double) {
        appendEvent(
            t: t,
            kind: "raw.writer.started",
            data: ["file": .string(file)]
        )
    }

    /// Called when a raw stream writer entered `.failed` state — either
    /// mid-recording (detected at segment boundary) or at finish. The file is
    /// truncated and unplayable from the failure point. `code` and `domain`
    /// carry the underlying NSError so timelines can be matched against
    /// specific Apple error codes (e.g. VideoToolbox `-12909`,
    /// `AVErrorEncoderResourcesAllocationFailure`).
    func recordRawWriterFailed(
        file: String,
        error: String,
        code: Int? = nil,
        domain: String? = nil,
        t: Double
    ) {
        var data: [String: JSONValue] = [
            "file": .string(file),
            "error": .string(error),
        ]
        if let code { data["code"] = .int(code) }
        if let domain { data["domain"] = .string(domain) }
        appendEvent(
            t: t,
            kind: "raw.writer.failed",
            data: data
        )
    }

    // MARK: - Source Failure Events

    func recordSourceFailed(source: String, error: String, t: Double) {
        appendEvent(
            t: t,
            kind: "source.\(source).failed",
            data: ["error": .string(error)]
        )
    }

    func recordSourceStale(source: String, t: Double, staleDuration: Double) {
        appendEvent(
            t: t,
            kind: "source.\(source).stale",
            data: ["staleDurationSeconds": .double(staleDuration)]
        )
    }

    func recordSourceRecovered(source: String, t: Double) {
        appendEvent(t: t, kind: "source.\(source).recovered", data: nil)
    }

    func recordHLSWriterFailed(error: String, t: Double) {
        appendEvent(
            t: t,
            kind: "writer.hls.failed",
            data: ["error": .string(error)]
        )
    }

    /// Logged when the camera + mic shared session dies and HLS audio
    /// failover routes through the standalone mic instead. Forensic only —
    /// the user is already alerted via the camera-failed warning.
    func recordAudioFailover(reason: String, t: Double) {
        appendEvent(
            t: t,
            kind: "audio.failover",
            data: ["reason": .string(reason)]
        )
    }

    /// Phase 3 keep-alive emit (one per static run, not per tick). Fired
    /// when the source has been static for ≥ `keepAliveThresholdSeconds`
    /// and the metronome emits a synthetic-PTS repeat of the last cached
    /// frame to keep HLS segments well-formed.
    func recordKeepaliveEmitted(staleDurationSeconds: Double, t: Double) {
        appendEvent(
            t: t,
            kind: "keepalive.emitted",
            data: ["staleDurationSeconds": .double(staleDurationSeconds)]
        )
    }

    /// Phase 4: the encoder-level monotonicity safety net rejected a
    /// frame. Should never fire post task-21 — the source-PTS freshness
    /// check is the primary defence. Any non-zero count in a recording
    /// is a regression hint. `branch` is the composite-mode label
    /// (`"pop"`, `"skipStale"`, etc.) so forensics can tell where the
    /// rejection originated.
    func recordMonotonicityRejected(deltaMs: Double, branch: String, t: Double) {
        appendEvent(
            t: t,
            kind: "monotonicity.rejected",
            data: [
                "deltaMs": .double(deltaMs),
                "branch": .string(branch),
            ]
        )
    }

    /// One-shot sentinel emitted when per-recording `monotonicity.rejected`
    /// events hit the cap (`RecordingActor.monoRejectEventCap`). After
    /// this event, further rejections only update the aggregate counter
    /// and histogram — the timeline stops growing. `branch` is the
    /// composite-mode label of the rejection that *triggered* suppression
    /// (typically the cap+1'th fire).
    func recordMonotonicityRejectedSuppressed(cap: Int64, branch: String, t: Double) {
        appendEvent(
            t: t,
            kind: "monotonicity.rejected.suppressed",
            data: [
                "cap": .int(Int(cap)),
                "branch": .string(branch),
            ]
        )
    }

    /// Seconds since t=0 (the commit anchor). Safe to call before the anchor
    /// is set — returns 0.
    func now() -> Double {
        guard let anchor = anchorWallClock else { return 0 }
        return Date().timeIntervalSince(anchor)
    }

    // MARK: - Build

    func build() -> RecordingTimeline {
        // Sort events by logical time so the timeline reads in chronological
        // order even when events were appended slightly out of order (e.g.
        // `recording.stopped` is recorded before `writer.finish()` runs, but
        // the final segment is emitted *during* finish — both have correct
        // `t` values, they just get inserted in the wrong order). Stable sort
        // preserves insertion order for events that share a `t` (e.g. paused
        // and resumed at the same frozen logical time).
        let sortedEvents = events
            .enumerated()
            .sorted { lhs, rhs in
                if lhs.element.t != rhs.element.t { return lhs.element.t < rhs.element.t }
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        return RecordingTimeline(
            schemaVersion: RecordingTimeline.currentSchemaVersion,
            session: .init(
                id: sessionId,
                slug: slug,
                initialMode: initialMode.rawValue,
                initialPipPosition: initialPipPosition.rawValue,
                startedAt: startedAt.map { Self.isoFormatter.string(from: $0) } ?? "",
                endedAt: endedAt.map { Self.isoFormatter.string(from: $0) },
                durationSeconds: durationSeconds,
                exclusions: exclusions
            ),
            app: Self.currentAppInfo(),
            hardware: Self.currentHardware(),
            inputs: inputs,
            preset: .init(
                id: preset.id,
                label: preset.label,
                width: preset.width,
                height: preset.height,
                bitrate: preset.bitrate
            ),
            encoder: Self.currentEncoder(preset: preset, fps: fps),
            rawStreams: (rawScreen == nil && rawCamera == nil && rawAudio == nil)
                ? nil
                : .init(screen: rawScreen, camera: rawCamera, audio: rawAudio),
            compositionStats: compositionStatsIfInteresting(),
            runtime: runtime,
            segments: segments,
            events: sortedEvents
        )
    }

    // MARK: - Internals

    /// Only emit compositionStats when something worth recording happened.
    /// Healthy recordings carry no counters — the field is absent rather than
    /// zero-valued, so the common-case JSON stays small.
    private func compositionStatsIfInteresting() -> RecordingTimeline.CompositionStats? {
        guard renderErrorCount > 0
            || stallTimeoutCount > 0
            || rebuildSuccessCount > 0
            || terminalCompositionFailure else { return nil }
        return .init(
            renderErrorCount: renderErrorCount,
            stallTimeoutCount: stallTimeoutCount,
            rebuildSuccessCount: rebuildSuccessCount,
            terminalFailure: terminalCompositionFailure
        )
    }

    private func appendEvent(t: Double, kind: String, data: [String: JSONValue]?) {
        events.append(
            .init(
                t: t,
                wallClock: Self.isoFormatter.string(from: Date()),
                kind: kind,
                data: data
            )
        )
    }

    // MARK: - Environment

    private static func currentAppInfo() -> RecordingTimeline.AppInfo {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info?["CFBundleVersion"] as? String ?? "unknown"
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return .init(
            version: version,
            build: build,
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        )
    }

    private static func currentHardware() -> RecordingTimeline.HardwareInfo {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var model = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &model, &size, nil, 0)
        let modelName = String(cString: model)

        #if arch(arm64)
            let arch = "arm64"
        #elseif arch(x86_64)
            let arch = "x86_64"
        #else
            let arch = "unknown"
        #endif

        return .init(model: modelName, arch: arch)
    }

    private static func currentEncoder(preset: OutputPreset, fps: Int32) -> RecordingTimeline.EncoderInfo {
        let frameRate = FrameRate(rawValue: fps) ?? .thirtyFPS
        let effectiveBitrate = Int(Double(preset.bitrate) * frameRate.bitrateMultiplier)
        return .init(
            videoCodec: "h264",
            videoProfile: "High",
            videoBitrate: effectiveBitrate,
            audioCodec: "aac-lc",
            audioBitrate: 128_000,
            targetFPS: Int(fps),
            outputWidth: preset.width,
            outputHeight: preset.height,
            segmentIntervalSeconds: 4.0
        )
    }
}
