import CoreMedia

extension RecordingActor {
    /// Starts the metronome loop. Safe to call only when `metronomeTask` is nil.
    func startMetronome() {
        metronomeTickIdx = 0
        metronomeTask = Task { [weak self] in
            await self?.metronomeLoop()
        }
    }

    /// Cancels the metronome task and awaits its completion so the caller can
    /// be sure no more frames will be appended before it proceeds.
    func cancelMetronome() async {
        guard let task = metronomeTask else { return }
        task.cancel()
        _ = await task.value
        metronomeTask = nil
    }

    /// The 30fps encoding loop. Each tick composes one output frame using
    /// the cached source buffer(s) and stamps it with the source's own
    /// capture PTS (see `emitMetronomeFrame`), which is the same clock
    /// audio samples are stamped with — so A/V stay aligned regardless
    /// of capture pipeline latency.
    ///
    /// The sleep schedule is drift-corrected against `recordingStartTime`
    /// so ticks fire at steady 1/30s intervals.
    func metronomeLoop() async {
        while !Task.isCancelled, isRecording {
            let emitted = await emitMetronomeFrame()

            if !emitted {
                try? await Task.sleep(for: .nanoseconds(33_333_333))
                continue
            }

            metronomeTickIdx += 1

            // Drift-corrected sleep: tick N fires at
            //   recordingStartTime + pauseAccumulator + N × (1/30)
            // (`pauseAccumulator` is read for the current iteration only —
            // pause/resume cancels and restarts the loop with tickIdx=0.)
            guard let start = recordingStartTime else { continue }
            let nextTarget = start
                + pauseAccumulator
                + CMTime(value: metronomeTickIdx, timescale: Self.targetFrameRate)
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            let sleepSeconds = (nextTarget - now).seconds
            if sleepSeconds > 0 {
                try? await Task.sleep(for: .seconds(sleepSeconds))
            }
        }
    }
}
