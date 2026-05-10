import CoreMedia

extension RecordingActor {
    /// Starts the metronome loop. Safe to call only when `metronomeTask` is nil.
    func startMetronome() {
        metronomeTickIdx = 0
        metronomeTask = Task { [weak self] in
            await self?.metronomeLoop()
        }
        startHealthCheckTimer()
    }

    /// Cancels the metronome task and awaits its completion so the caller can
    /// be sure no more frames will be appended before it proceeds.
    func cancelMetronome() async {
        healthCheckTask?.cancel()
        healthCheckTask = nil
        guard let task = metronomeTask else { return }
        task.cancel()
        _ = await task.value
        metronomeTask = nil
    }

    /// Runs source health checks at ~2Hz, completely decoupled from the
    /// timing-critical metronome encode loop. 500ms is plenty for detecting
    /// 1-2 second staleness thresholds.
    private func startHealthCheckTimer() {
        healthCheckTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self, !Task.isCancelled else { break }
                await self.checkSourceHealth()
                await self.checkFocusedWindowVisibility()

                // Periodically re-enumerate Finder browser windows when desktop
                // icons are hidden, so newly-opened Finder windows are excepted
                // from the exclusion. Every ~5 seconds (10 ticks × 500ms).
                await self.tickFilterRefresh()
            }
        }
    }

    /// Called from the health check timer. Refreshes the screen capture filter
    /// every 10 ticks (~5 seconds) when desktop icon hiding is active, to pick
    /// up newly-opened Finder browser windows.
    private func tickFilterRefresh() async {
        guard hideDesktopIcons else { return }
        filterRefreshCounter += 1
        guard filterRefreshCounter % 10 == 0 else { return }
        await updateExcludedApps()
    }

    /// The encoding loop. Each tick composes one output frame using the
    /// cached source buffer(s) and stamps it with the source's own
    /// capture PTS (see `emitMetronomeFrame`), which is the same clock
    /// audio samples are stamped with — so A/V stay aligned regardless
    /// of capture pipeline latency.
    ///
    /// The sleep schedule is drift-corrected against `recordingStartTime`
    /// so ticks fire at steady 1/fps intervals.
    func metronomeLoop() async {
        let sleepNanos = UInt64(1_000_000_000 / UInt64(targetFrameRate))

        while !Task.isCancelled, isRecording {
            let emitted = await emitMetronomeFrame()

            // Re-check cancellation immediately after composite returns.
            // A wedged GPU can leave a render task waiting up to 2s before
            // it gives up; without this guard cancelMetronome (awaiting
            // task.value) would block the stop flow on a frame that's
            // about to be appended into a writer the actor is trying to
            // tear down.
            if Task.isCancelled { return }

            if !emitted {
                try? await Task.sleep(for: .nanoseconds(sleepNanos))
                continue
            }

            metronomeTickIdx += 1

            // Drift-corrected sleep: tick N fires at
            //   recordingStartTime + pauseAccumulator + N × (1/fps)
            // (`pauseAccumulator` is read for the current iteration only —
            // pause/resume cancels and restarts the loop with tickIdx=0.)
            guard let start = recordingStartTime else { continue }
            let nextTarget = start
                + pauseAccumulator
                + CMTime(value: metronomeTickIdx, timescale: targetFrameRate)
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            let sleepSeconds = (nextTarget - now).seconds
            if sleepSeconds > 0 {
                try? await Task.sleep(for: .seconds(sleepSeconds))
            }
        }
    }
}
