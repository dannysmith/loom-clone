import AVFoundation
import CoreMedia
import ScreenCaptureKit

extension RecordingActor {
    // MARK: - Two-Phase Start

    //
    // Recording start is split into prepare + commit so the coordinator can run
    // the slow setup (server session, capture hardware coming online, audio
    // wait) in parallel with a user-facing countdown. By the time `commit` is
    // called, every source is confirmed running and the recording clock can be
    // anchored cleanly.

    enum RecordingError: Error {
        case displayNotFound
    }

    /// Phase 1: do all the slow setup. After this returns, every capture
    /// source's hardware is actually running and frames are flowing into the
    /// caches — but no PTS values have been assigned yet and the writer
    /// session is not yet open.
    func prepareRecording(
        displayID: CGDirectDisplayID?,
        cameraID: String?,
        microphoneID: String?,
        mode: RecordingMode,
        preset: OutputPreset,
        frameRate: FrameRate = .thirtyFPS,
        excludedBundleIDs: Set<String> = [],
        hideDesktopIcons: Bool = false
    ) async throws -> (id: String, slug: String) {
        resetPrepareState(mode: mode, preset: preset, frameRate: frameRate)

        // Store exclusion state for mid-recording filter updates and
        // the focused-window warning check.
        self.excludedBundleIDs = excludedBundleIDs
        self.hideDesktopIcons = hideDesktopIcons

        // 1. Resolve devices from identifiers
        let (display, ourApp) = try await resolveDisplay(displayID: displayID)
        let camera: AVCaptureDevice? = cameraID.flatMap { AVCaptureDevice(uniqueID: $0) }
        let microphone: AVCaptureDevice? = microphoneID.flatMap { AVCaptureDevice(uniqueID: $0) }

        // Query HAL input latency for the mic (if selected) before any
        // capture starts. This is a read-only Core Audio property query.
        if let microphone {
            audioInputLatency = HALInputLatency.totalInputLatency(for: microphone)
        }

        // 2. Create server session
        let session = try await upload.createSession()

        // Populate timeline session + inputs now that we've resolved devices.
        // The preset recorded in the timeline is the BASE preset (resolution +
        // base bitrate). The encoder section records the EFFECTIVE bitrate
        // (base × fps multiplier) via the fps-aware currentEncoder() helper.
        timeline.setSession(id: session.id, slug: session.slug, initialMode: mode, initialPipPosition: pipPosition)
        timeline.setPreset(preset, fps: frameRate.rawValue)
        timeline.setInputs(
            display: display.map {
                .init(
                    id: UInt32($0.displayID),
                    width: $0.width,
                    height: $0.height
                )
            },
            camera: camera.map {
                .init(uniqueID: $0.uniqueID, name: $0.localizedName)
            },
            microphone: microphone.map {
                .init(
                    uniqueID: $0.uniqueID,
                    name: $0.localizedName,
                    halInputLatencyMs: audioInputLatency * 1000
                )
            }
        )

        // Record exclusion metadata in the timeline. Resolved names come from
        // NSWorkspace which requires MainActor, so hop there briefly.
        if !excludedBundleIDs.isEmpty || hideDesktopIcons {
            let resolvedApps = await MainActor.run {
                excludedBundleIDs.compactMap { bundleID -> RecordingTimeline.Exclusions.ExcludedApp? in
                    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
                        return .init(bundleID: bundleID, name: bundleID)
                    }
                    let name = FileManager.default.displayName(atPath: url.path)
                    return .init(bundleID: bundleID, name: name)
                }
            }
            timeline.setExclusions(.init(
                excludedApps: resolvedApps,
                desktopIconsHidden: hideDesktopIcons
            ))
        }

        // Wire upload-result callback into the timeline. This fires on the
        // upload actor and hops back into us to record the result.
        await upload.setOnUploadResult { [weak self] filename, success, error in
            guard let self else { return }
            Task { await self.recordUploadResult(filename: filename, success: success, error: error) }
        }

        // 3. Set up local safety net directory
        let localDir = AppEnvironment.recordingsDirectory.appendingPathComponent(session.id)
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)
        localSavePath = localDir

        // 4. Configure writer and compositor for this preset.
        // Effective bitrate scales with fps: 1.0× at 30fps, 1.4× at 60fps.
        var effectivePreset = preset
        if frameRate != .thirtyFPS {
            effectivePreset = OutputPreset(
                id: preset.id,
                label: preset.label,
                width: preset.width,
                height: preset.height,
                bitrate: Int(Double(preset.bitrate) * frameRate.bitrateMultiplier)
            )
        }
        await composition.configure(preset: preset)
        try await writer.configure(preset: effectivePreset, fps: frameRate.rawValue)

        // 5. Configure raw stream writers for screen + audio.
        // Camera raw writer is configured after cameraCapture.startCapture
        // returns (step 8) so we read actual delivered dims, not guesses.
        await configureRawWriters(display: display, microphone: microphone, localDir: localDir)

        // Await the downstream handling synchronously so that
        // `writer.finish()` can wait for every trailing segment to be
        // fully recorded in the timeline and enqueued for upload before
        // it returns. This is what prevents the stop-flow race.
        await writer.setOnSegmentReady { [weak self] emission in
            await self?.handleSegment(emission)
        }

        // 6. Warm up writers BEFORE opening any capture source.
        // `AVAssetWriter.startWriting()` → `startSession(atSourceTime:)`
        // internally calls `VTCompressionSessionPrepareToEncodeFrames`, which
        // allocates the encoder's IOSurface working set through IOGPUFamily.
        // Doing that while SCStream is already allocating its own IOSurfaces
        // is a race (observed spindumps showed `videotoolbox.preparationQueue`
        // stuck inside IOGPUFamily kext during early-recording). Warming up
        // here means all three warmable writers' allocations happen in a
        // quiet window, before SCK starts competing for the same kernel
        // resource.
        //
        // The camera raw writer is intentionally NOT warmed up here — it's
        // constructed further down, after `cameraCapture.startCapture()` returns
        // and we can read the delivered dimensions from `device.activeFormat`.
        // It warms up at its own construction point, which is still before
        // `commitRecording` anchors the clock and starts the metronome.
        //
        // Safety: `handleScreenFrame` and `handleCameraFrame` guard their raw-
        // writer appends through `retimedSampleForRawWriter`, which returns
        // nil unless `isRecording == true` — so frames that arrive during the
        // capture-startup window below go into caches only, not into the
        // warmed-up writers. The HLS writer is only fed by the metronome,
        // which doesn't start until `commitRecording`. The init segment that
        // fires out of the HLS writer's delegate during this `startWriting()`
        // is handled by `handleSegment`, which tolerates a pre-commit state
        // (`timeline.recordSegment` is only called for `.media` segments;
        // `logicalElapsedSeconds()` returns 0 before commit).
        await writer.startWriting()
        await screenRawWriter?.startWriting()
        if screenRawWriter != nil {
            timeline.recordRawWriterStarted(file: "screen.mov", t: timeline.now())
        }
        await audioRawWriter?.startWriting()
        if audioRawWriter != nil {
            timeline.recordRawWriterStarted(file: "audio.m4a", t: timeline.now())
        }

        // 7. Wire capture callbacks. Frames that arrive now will populate the
        // caches but won't be encoded — the metronome only starts in commit()
        // and `recordingStartTime` is still nil so audio samples are dropped.
        wireCaptureCallbacks(hasDisplay: display != nil, hasCamera: camera != nil, hasMicrophone: microphone != nil)

        // 8. Start captures and configure camera raw writer.
        try await startCaptureSources(
            display: display,
            camera: camera,
            microphone: microphone,
            ourApp: ourApp,
            preset: preset,
            frameRate: frameRate
        )

        print("[recording] Prepared: mode=\(mode), id=\(session.id)")
        return session
    }

    /// Phase 2: anchor the recording clock and start the encoder.
    /// All capture hardware is already live; this is the moment T = 0.
    func commitRecording() async {
        // Anchor the recording clock to the most recent cached source
        // frame's hardware capture time — not CMClockGetTime() at commit.
        //
        // Why: camera capture has a pipeline latency (~40-80ms on built-in
        // cameras, more on USB). The freshest cached camera frame at commit
        // time has a capturePTS that's already ~40ms in the past. If we
        // anchor to "now", that cached frame's elapsed is negative → it's
        // rejected → the metronome has to wait for the next capture cycle
        // before it can emit anything. Meanwhile audio's first sample has
        // a hardware PTS very close to now, so it lands near t=0 on the
        // timeline. Net effect: audio starts ~70ms before video in the
        // output. Anchoring to the camera's capturePTS eliminates that
        // wait — the cached frame is accepted immediately with elapsed=0.
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        // Safety bound on how far "in the past" the anchor can be. If the
        // cached source frame is unusually stale (e.g., USB camera hiccup
        // right at commit), a very old capturePTS would make audio samples
        // land far ahead of the anchor in the output — we'd swap an
        // audio-leads-video bug for a video-leads-audio bug, potentially
        // larger. Capping at ~100ms preserves the fix for the normal
        // ~40-80ms capture-pipeline case while bounding the worst case.
        let maxAnchorAge = CMTime(value: 100, timescale: 1000)
        let cachedPTS: CMTime? = switch mode {
        case .screenOnly:
            latestScreenFrame?.capturePTS
        case .cameraOnly, .screenAndCamera:
            cameraFrameQueue.last?.capturePTS
        }
        let anchor: CMTime
        if let cachedPTS, cachedPTS.isValid, (now - cachedPTS) <= maxAnchorAge {
            anchor = cachedPTS
        } else {
            anchor = now - maxAnchorAge
            if let cachedPTS, cachedPTS.isValid {
                let ageMS = (now - cachedPTS).seconds * 1000
                print(String(
                    format: "[recording] Cached source frame was stale (%.1f ms) — clamping anchor to now-%.0fms",
                    ageMS,
                    maxAnchorAge.seconds * 1000
                ))
            }
        }
        recordingStartTime = anchor
        pauseAccumulator = .zero
        pauseStartHostTime = nil
        lastEmittedVideoPTS = .invalid
        isRecording = true

        // Anchor the timeline at the same moment.
        timeline.markStarted()

        // The HLS, raw-screen, and raw-audio writers were already warmed up
        // in `prepareRecording`. Only the camera raw writer still warms up
        // here, because it's constructed after `cameraCapture.startCapture()`
        // returns with the delivered dims from `device.activeFormat`. It's
        // still warmed up serially, still before the metronome feeds any
        // frames.
        await cameraRawWriter?.startWriting()
        if cameraRawWriter != nil {
            timeline.recordRawWriterStarted(file: "camera.mp4", t: timeline.now())
        }

        // Start the metronome — emits frames from the cache at targetFrameRate
        // regardless of what the underlying sources are doing.
        startMetronome()

        print("[recording] Committed at \(recordingStartTime?.seconds ?? 0)")
    }

    /// Cleanup path for `prepareRecording` failing after the HLS / screen-raw /
    /// audio-raw writers have been warmed up. Called only from the error
    /// path; on the happy path the writers are owned through to
    /// `stopRecording`.
    func tearDownWarmedUpWritersOnPrepareFailure() async {
        await writer.finish()
        if let w = screenRawWriter {
            await w.finish()
            screenRawWriter = nil
            rawScreenDims = nil
        }
        if let w = audioRawWriter {
            await w.finish()
            audioRawWriter = nil
            rawAudioConfig = nil
        }
        print("[recording] Tore down warmed-up writers after prepare failure")
    }

    // MARK: - Prepare Helpers

    /// Zero out all per-recording state so a fresh prepare starts clean.
    private func resetPrepareState(mode: RecordingMode, preset: OutputPreset, frameRate: FrameRate) {
        self.mode = mode
        self.preset = preset
        self.targetFrameRate = frameRate.rawValue
        isRecording = false
        isStopping = false
        audioHasArrived = false
        sharedSessionAudioActive = false
        audioInputLatency = 0
        recordingStartTime = nil
        pauseAccumulator = .zero
        pauseStartHostTime = nil
        lastEmittedVideoPTS = .invalid
        latestScreenFrame = nil
        cameraFrameQueue.removeAll(keepingCapacity: true)
        lastPoppedCameraFrame = nil
        metronomeTickIdx = 0
        terminalErrorFired = false
        rawWriterFailureReported.removeAll()
        lastScreenFrameHostTime = nil
        lastCameraFrameHostTime = nil
        lastAudioSampleHostTime = nil
        activeSourceWarnings.removeAll()
        timeline = RecordingTimelineBuilder()
    }

    /// Resolve a display ID to its SCDisplay and find our own app for exclusion.
    /// Returns (nil, nil) when no displayID is provided (camera-only mode).
    /// Uses `onScreenWindowsOnly: false` so excluded apps are found even if
    /// they have no on-screen windows yet.
    private func resolveDisplay(
        displayID: CGDirectDisplayID?
    ) async throws -> (SCDisplay?, SCRunningApplication?) {
        guard let displayID else { return (nil, nil) }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw RecordingError.displayNotFound
        }
        let ourApp = content.applications.first {
            $0.processID == ProcessInfo.processInfo.processIdentifier
        }
        return (display, ourApp)
    }

    /// Build the full app and window exclusion lists for the screen capture filter.
    /// Resolves user-selected bundle IDs and desktop icon windows from a fresh
    /// SCShareableContent query.
    private func resolveExclusions(
        ourApp: SCRunningApplication?
    ) async -> (apps: [SCRunningApplication], exceptingWindows: [SCWindow]) {
        var appsToExclude: [SCRunningApplication] = []
        if let ourApp { appsToExclude.append(ourApp) }

        // No exclusions configured — skip the query
        guard !excludedBundleIDs.isEmpty || hideDesktopIcons else {
            return (appsToExclude, [])
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            print("[exclusion] SCShareableContent query failed: \(error)")
            return (appsToExclude, [])
        }

        // User-selected apps
        for app in content.applications where excludedBundleIDs.contains(app.bundleIdentifier) {
            appsToExclude.append(app)
            print("[exclusion] Excluding \(app.bundleIdentifier) (pid: \(app.processID))")
        }

        var exceptingWindows: [SCWindow] = []

        // Desktop icons: exclude Finder, but re-include its browser windows
        if hideDesktopIcons {
            if let finder = content.applications.first(where: { $0.bundleIdentifier == "com.apple.finder" }) {
                if !appsToExclude.contains(where: { $0.processID == finder.processID }) {
                    appsToExclude.append(finder)
                    print("[exclusion] Excluding Finder for desktop icons")
                }
                // Re-include Finder windows at normal window level (browser windows).
                // Desktop icon windows sit at kCGDesktopIconWindowLevel and stay excluded.
                exceptingWindows = content.windows.filter {
                    $0.owningApplication?.processID == finder.processID && $0.windowLayer == 0
                }
                if !exceptingWindows.isEmpty {
                    print("[exclusion] Excepting \(exceptingWindows.count) Finder browser window(s)")
                }
            }
        }

        return (appsToExclude, exceptingWindows)
    }

    /// Set up raw stream writers for screen and audio. Camera is deferred
    /// until after capture starts so we read actual delivered dims.
    private func configureRawWriters(display: SCDisplay?, microphone: AVCaptureDevice?, localDir: URL) async {
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil
        rawScreenDims = nil
        rawCameraDims = nil
        rawAudioConfig = nil

        if let display {
            let nativeSize = ScreenCaptureManager.nativePixelSize(for: display)
            let width = Int(nativeSize.width)
            let height = Int(nativeSize.height)
            let url = localDir.appendingPathComponent("screen.mov")
            let w = RawStreamWriter(url: url, kind: .videoProRes(width: width, height: height))
            do {
                try await w.configure()
                screenRawWriter = w
                rawScreenDims = (width, height)
                print("[recording] Raw screen writer: ProRes 422 Proxy at \(width)x\(height) (hardware ProRes engine)")
            } catch {
                print("[recording] Failed to configure raw screen writer: \(error)")
            }
        }

        if microphone != nil {
            let bitrate = 192_000
            let sampleRate = 48000
            let channels = 2
            let url = localDir.appendingPathComponent("audio.m4a")
            let w = RawStreamWriter(url: url, kind: .audio(bitrate: bitrate, sampleRate: sampleRate, channels: channels))
            do {
                try await w.configure()
                audioRawWriter = w
                rawAudioConfig = (bitrate, sampleRate, channels)
                print("[recording] Raw audio writer: AAC \(bitrate / 1000) kbps")
            } catch {
                print("[recording] Failed to configure raw audio writer: \(error)")
            }
        }
    }

    /// Wire capture callbacks into the actor's frame/audio handlers.
    private func wireCaptureCallbacks(hasDisplay: Bool, hasCamera: Bool, hasMicrophone: Bool) {
        if hasDisplay {
            screenCapture.onScreenFrame = { [weak self] buffer in
                guard let self else { return }
                Task { await self.handleScreenFrame(buffer) }
            }
            screenCapture.onStreamError = { [weak self] error in
                guard let self else { return }
                Task { await self.handleScreenCaptureError(error) }
            }
        }

        if hasCamera {
            cameraCapture.onCameraFrame = { [weak self] buffer in
                guard let self else { return }
                self.onCameraSampleForOverlay?(buffer)
                Task { await self.handleCameraFrame(buffer) }
            }
            cameraCapture.onSessionError = { [weak self] error in
                guard let self else { return }
                Task { await self.handleCameraSessionError(error) }
            }
            cameraCapture.onSessionInterrupted = { [weak self] in
                guard let self else { return }
                Task { await self.handleCameraSessionInterrupted() }
            }

            // When camera + mic share a session, the shared session's audio
            // feeds the HLS writer directly (eliminating cross-session clock
            // jitter). This callback only fires if startCapture added the mic
            // to the camera session successfully.
            if hasMicrophone {
                cameraCapture.onAudioSample = { [weak self] buffer in
                    guard let self else { return }
                    Task { await self.handleAudioSample(buffer) }
                }
            }
        }

        if hasMicrophone {
            // handleMicAudioSample checks sharedSessionAudioActive at call
            // time: when the camera's shared session is the primary audio
            // source, standalone mic audio only feeds audio.m4a. When no
            // camera is present, it delegates to handleAudioSample (HLS +
            // audio.m4a).
            micCapture.onAudioSample = { [weak self] buffer in
                guard let self else { return }
                Task { await self.handleMicAudioSample(buffer) }
            }
            micCapture.onSessionError = { [weak self] error in
                guard let self else { return }
                Task { await self.handleMicSessionError(error) }
            }
            micCapture.onSessionInterrupted = { [weak self] in
                guard let self else { return }
                Task { await self.handleMicSessionInterrupted() }
            }
        }
    }

    /// Start each capture source, configure the camera raw writer once
    /// we know the actual delivered dimensions, and wait for audio arrival.
    private func startCaptureSources(
        display: SCDisplay?,
        camera: AVCaptureDevice?,
        microphone: AVCaptureDevice?,
        ourApp: SCRunningApplication?,
        preset: OutputPreset,
        frameRate: FrameRate
    ) async throws {
        audioHasArrived = false

        if let display {
            do {
                let (appsToExclude, exceptingWindows) = await resolveExclusions(ourApp: ourApp)
                try await screenCapture.startCapture(
                    display: display,
                    fps: frameRate.rawValue,
                    excludingApps: appsToExclude,
                    exceptingWindows: exceptingWindows
                )
            } catch {
                await tearDownWarmedUpWritersOnPrepareFailure()
                throw error
            }
        }

        if let camera {
            await cameraCapture.startCapture(device: camera, maxHeight: preset.height, targetFPS: frameRate, micDevice: microphone)
            sharedSessionAudioActive = cameraCapture.hasAudioCapture
            await configureCameraRawWriter(withAudio: sharedSessionAudioActive)
        }

        if let microphone {
            await micCapture.startCapture(device: microphone)
        }

        // Wait briefly for the first audio sample to actually arrive.
        // The session is running but the first sample can take 50-200ms.
        if microphone != nil {
            for _ in 0 ..< 100 {
                if audioHasArrived { break }
                try? await Task.sleep(for: .milliseconds(10))
            }
            print("[recording] Audio \(audioHasArrived ? "ready" : "timeout, proceeding anyway")")
        }
    }

    /// Configure the camera raw writer using actual delivered dimensions
    /// from the running capture session. When `withAudio` is true, the
    /// writer includes an audio track so camera.mp4 is a self-contained
    /// A/V file for manual recovery.
    private func configureCameraRawWriter(withAudio: Bool = false) async {
        guard let localDir = localSavePath else { return }
        let nativeSize = cameraCapture.nativePixelSize
        let width = Int(nativeSize.width)
        let height = Int(nativeSize.height)
        guard width > 0, height > 0 else {
            print("[recording] Camera nativePixelSize is zero — skipping raw camera writer")
            return
        }
        let bitrate = 12_000_000
        let fps = targetFrameRate
        let url = localDir.appendingPathComponent("camera.mp4")
        let kind: RawStreamWriter.Kind = if withAudio {
            .videoH264WithAudio(
                width: width, height: height, bitrate: bitrate, fps: fps,
                audioBitrate: 192_000, sampleRate: 48000, channels: 2
            )
        } else {
            .videoH264(width: width, height: height, bitrate: bitrate, fps: fps)
        }
        let w = RawStreamWriter(url: url, kind: kind)
        do {
            try await w.configure()
            cameraRawWriter = w
            rawCameraDims = (width, height, bitrate)
            print("[recording] Raw camera writer: \(width)x\(height) @ \(bitrate / 1_000_000) Mbps\(withAudio ? " + audio" : "")")
        } catch {
            print("[recording] Failed to configure raw camera writer: \(error)")
        }
    }
}
