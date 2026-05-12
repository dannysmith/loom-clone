import AVFoundation
import CoreMedia
import Foundation

extension RecordingActor {
    // MARK: - Stop

    /// What the stop flow hands back to the coordinator. `url` drives the
    /// clipboard copy; the rest lets HealAgent pick up any segments the
    /// server didn't have at stop time without blocking the foreground flow.
    struct StopResult {
        let url: String
        let videoId: String
        let slug: String
        let title: String?
        let visibility: String
        let localDir: URL
        let timelineData: Data
        let missing: [String]
    }

    /// Finish results for the three raw writers, collected in parallel.
    struct RawFinishResults {
        var screen: RawStreamWriter.FinishResult?
        var camera: RawStreamWriter.FinishResult?
        var audio: RawStreamWriter.FinishResult?
    }

    /// Stop a committed recording. Cancels the metronome, stops captures,
    /// finishes the writer, completes the upload session.
    func stopRecording() async -> StopResult? {
        isRecording = false
        isStopping = true

        // Finalise the timeline BEFORE finishing the writer so the stop event
        // is timestamped at the user-visible stop moment, not after the
        // (potentially slow) finishWriting completion.
        let logicalDuration = logicalElapsedSeconds()
        timeline.markStopped(logicalDuration: logicalDuration)

        // Stop the metronome first so no more frames get appended
        Log.recording.log("Stopping metronome...")
        await cancelMetronome()
        Log.recording.log("Metronome stopped")

        // Stop captures (each await waits for stopRunning() to actually return)
        Log.recording.log("Stopping captures...")
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        Log.recording.log("Captures stopped")

        // Kick off raw writer finishes in the background, in parallel with
        // the composited writer's finish flow. Each raw writer is independent
        // — finalising one doesn't block the others. We await them all
        // together below before snapshotting the timeline.
        let screenW = screenRawWriter
        let cameraW = cameraRawWriter
        let audioW = audioRawWriter

        let rawFinishTask = Task { [screenW, cameraW, audioW] in
            await withTaskGroup(of: (String, RawStreamWriter.FinishResult).self) { group -> RawFinishResults in
                if let w = screenW { group.addTask { await ("screen", w.finish()) } }
                if let w = cameraW { group.addTask { await ("camera", w.finish()) } }
                if let w = audioW { group.addTask { await ("audio", w.finish()) } }
                var results = RawFinishResults()
                for await (key, result) in group {
                    switch key {
                    case "screen": results.screen = result
                    case "camera": results.camera = result
                    case "audio": results.audio = result
                    default: break
                    }
                }
                return results
            }
        }

        // Finish writer. Blocks until every trailing segment has been fully
        // processed by the writer's consumer — i.e. recorded in the timeline
        // and enqueued for upload. After this line, no more segments can
        // appear from the encoder.
        Log.recording.log("Finishing composited writer...")
        await writer.finish()
        Log.recording.log("Composited writer done")

        // Drain the upload queue, but only up to a grace window. With Phase 3's
        // unbounded retry policy, waiting forever here would hang the stop flow
        // for the entire duration of a network outage. After the window,
        // anything still pending is left on local disk and Phase 2's healing
        // reconciles it silently in the background.
        await upload.drainQueue(timeoutSeconds: 10)

        // Wait for raw writers to finish flushing. They've been running in
        // parallel with the composited finish; this is the join point.
        let rawResults = await rawFinishTask.value

        // Use the frozen stop-time `logicalDuration` so failure events sit
        // at `recording.stopped`, not a value seconds later (post finish).
        recordRawWriterFailures(rawResults, t: logicalDuration)

        finalizeRawWriterMetadata(logicalDuration: logicalDuration, rawResults: rawResults)

        // Diagnostics: append the one-line summary as an "error" timeline
        // event (kind=error, message="diagnostics: …") so it's visible in
        // recording.json. The full dump lives in diagnostics.json.
        recordDiagnosticsSummaryEvent()

        // Phase 4: feed runtime metrics + camera format details into the
        // timeline so recording.json carries the aggregate "what
        // happened" view of this session. Diagnostics has the raw
        // counters + histograms; the builder gets the projection.
        diagnostics.recordingDurationS = logicalDuration
        timeline.setCameraFormatDetails(
            advertised: diagnostics.trimmedAdvertisedFormats(),
            selected: diagnostics.selectedFormatForRecordingJson()
        )
        timeline.setRuntime(diagnostics.buildRuntime())

        // NOW the builder is fully up-to-date: all segments, all pauses,
        // all mode switches, all upload results. Snapshot it.
        let builtTimeline = timeline.build()
        let timelineData = encodeTimeline(builtTimeline)

        if let localDir = localSavePath, let data = timelineData {
            let path = localDir.appendingPathComponent("recording.json")
            do {
                try data.write(to: path)
            } catch {
                Log.recording.log("Failed to write local timeline: \(error)")
            }
        }

        // Dump diagnostics. Sibling file `diagnostics.json` next to the
        // recording bundle. Also logs a one-line summary to console for
        // immediate at-a-glance feedback.
        writeDiagnosticsDump(sessionID: builtTimeline.session.id)

        // Complete upload (includes the timeline in the payload)
        do {
            let result = try await upload.complete(timeline: timelineData)
            // Share URLs are sensitive for private/unlisted videos — don't
            // log them.
            Log.recording.log("Stopped (missing=\(result.missing.count))")
            guard let videoId = await upload.videoId,
                  let localDir = localSavePath
            else {
                // No way to schedule healing without these — still return the URL.
                return StopResult(
                    url: result.url,
                    videoId: "",
                    slug: result.slug,
                    title: result.title,
                    visibility: result.visibility,
                    localDir: URL(fileURLWithPath: "/"),
                    timelineData: timelineData ?? Data(),
                    missing: []
                )
            }
            return StopResult(
                url: result.url,
                videoId: videoId,
                slug: result.slug,
                title: result.title,
                visibility: result.visibility,
                localDir: localDir,
                timelineData: timelineData ?? Data(),
                missing: result.missing
            )
        } catch {
            Log.recording.log("Complete failed: \(error)")
            return nil
        }
    }

    /// Emit a `raw.writer.failed` timeline event for each raw writer that
    /// entered `.failed`. `t` is the frozen stop-time logical duration.
    private func recordRawWriterFailures(_ results: RawFinishResults, t: Double) {
        if case let .failed(error) = results.screen {
            timeline.recordRawWriterFailed(file: "screen.mov", error: error, t: t)
        }
        if case let .failed(error) = results.camera {
            timeline.recordRawWriterFailed(file: "camera.mp4", error: error, t: t)
        }
        if case let .failed(error) = results.audio {
            timeline.recordRawWriterFailed(file: "audio.m4a", error: error, t: t)
        }
    }

    /// Populate timeline raw stream metadata from the finished writers, then
    /// nil them out. Called once at the end of `stopRecording` after all raw
    /// writers have flushed.
    private func finalizeRawWriterMetadata(logicalDuration: Double, rawResults: RawFinishResults) {
        if let dims = rawScreenDims, let w = screenRawWriter {
            // ProRes is roughly CBR-per-frame with no target-bitrate setting,
            // so compute the observed average from actual bytes ÷ logical
            // duration rather than parroting a fictitious target. Guard
            // against tiny durations to avoid division blowups on a recording
            // that stopped almost immediately.
            let bytes = w.bytesOnDisk() ?? 0
            let observedBitrate = logicalDuration > 0.1
                ? Int(Double(bytes) * 8.0 / logicalDuration)
                : 0
            let screenFailed = if case .failed = rawResults.screen { true } else { false }
            timeline.setRawScreen(
                filename: w.url.lastPathComponent,
                width: dims.width,
                height: dims.height,
                codec: "prores422proxy",
                bitrate: observedBitrate,
                bytes: bytes,
                failed: screenFailed
            )
        }
        if let dims = rawCameraDims, let w = cameraRawWriter {
            let cameraFailed = if case .failed = rawResults.camera { true } else { false }
            timeline.setRawCamera(
                filename: w.url.lastPathComponent,
                width: dims.width,
                height: dims.height,
                codec: "h264",
                bitrate: dims.bitrate,
                bytes: w.bytesOnDisk() ?? 0,
                failed: cameraFailed
            )
        }
        if let cfg = rawAudioConfig, let w = audioRawWriter {
            let audioFailed = if case .failed = rawResults.audio { true } else { false }
            timeline.setRawAudio(
                filename: w.url.lastPathComponent,
                codec: "aac-lc",
                bitrate: cfg.bitrate,
                sampleRate: cfg.sampleRate,
                channels: cfg.channels,
                bytes: w.bytesOnDisk() ?? 0,
                failed: audioFailed
            )
        }
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil
    }

    /// Check each raw writer for mid-recording failure and emit a timeline
    /// event the first time one is detected. Called at each segment boundary.
    func checkRawWriterStatus() async {
        let t = logicalElapsedSeconds()
        if let w = screenRawWriter, await w.hasFailed, !rawWriterFailureReported.contains("screen") {
            rawWriterFailureReported.insert("screen")
            timeline.recordRawWriterFailed(file: "screen.mov", error: "detected at segment boundary", t: t)
        }
        if let w = cameraRawWriter, await w.hasFailed, !rawWriterFailureReported.contains("camera") {
            rawWriterFailureReported.insert("camera")
            timeline.recordRawWriterFailed(file: "camera.mp4", error: "detected at segment boundary", t: t)
        }
        if let w = audioRawWriter, await w.hasFailed, !rawWriterFailureReported.contains("audio") {
            rawWriterFailureReported.insert("audio")
            timeline.recordRawWriterFailed(file: "audio.m4a", error: "detected at segment boundary", t: t)
        }
    }

    private func encodeTimeline(_ timeline: RecordingTimeline) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            return try encoder.encode(timeline)
        } catch {
            Log.recording.log("Failed to encode timeline: \(error)")
            return nil
        }
    }

    // MARK: - Cancel

    /// Cancel a committed recording. Tears down the pipeline like stop(),
    /// but discards the result: tells the server to delete the video and
    /// removes the local safety-net copy.
    func cancelRecording() async {
        isRecording = false
        // Mirror `stopRecording`: composition failures during teardown should
        // short-circuit recovery (no point in a 2s GPU rebuild when we're
        // about to discard the output anyway).
        isStopping = true

        await cancelMetronome()
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        await writer.finish()

        // Finalise raw writers so their AVAssetWriters release cleanly
        // before the local dir is removed below. The files themselves are
        // about to be deleted along with the rest of the session dir.
        await screenRawWriter?.finish()
        await cameraRawWriter?.finish()
        await audioRawWriter?.finish()
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil

        await upload.cancel()

        if let localDir = localSavePath {
            try? FileManager.default.removeItem(at: localDir)
        }
        localSavePath = nil

        Log.recording.log("Cancelled")
    }

    /// Cancel during prepare/countdown — captures may be running but the
    /// writer was never started. Tear down without trying to finalise.
    func cancelPreparation() async {
        isRecording = false
        await cancelMetronome()
        await screenCapture.stopCapture()
        await cameraCapture.stopCapture()
        await micCapture.stopCapture()
        await writer.finish() // no-op when hasStartedSession == false

        // Same for raw writers — they were configured but never started.
        // RawStreamWriter.finish() handles the unstarted case by removing
        // the empty file and bailing.
        await screenRawWriter?.finish()
        await cameraRawWriter?.finish()
        await audioRawWriter?.finish()
        screenRawWriter = nil
        cameraRawWriter = nil
        audioRawWriter = nil

        Log.recording.log("Preparation cancelled")
    }
}
