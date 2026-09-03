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
                await self.checkQualityHealth()
                await self.checkFocusedWindowVisibility()

                // Periodically re-enumerate Finder browser windows when desktop
                // icons are hidden, so newly-opened Finder windows are excepted
                // from the exclusion. See `AppExclusionState.shouldRefreshFilter`.
                await self.tickFilterRefresh()
            }
        }
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
            diagnostics.iterations += 1
            let iterIdx = diagnostics.iterations

            let emitted = await emitMetronomeFrame(iterIdx: iterIdx)

            // Periodic snapshot every ~2 logical seconds.
            let nowLogical = logicalElapsedSeconds()
            if nowLogical - lastPeriodicSnapshotS >= 2 {
                diagnostics.pushPeriodicSnapshot(t: nowLogical)
                lastPeriodicSnapshotS = nowLogical
            }

            // Re-check cancellation immediately after composite returns.
            // A wedged GPU can leave a render task waiting up to 2s before
            // it gives up; without this guard cancelMetronome (awaiting
            // task.value) would block the stop flow on a frame that's
            // about to be appended into a writer the actor is trying to
            // tear down.
            if Task.isCancelled { return }

            if !emitted {
                diagnostics.idleSleeps += 1
                try? await Task.sleep(for: .nanoseconds(sleepNanos))
                continue
            }

            metronomeTickIdx += 1

            // Drift-corrected sleep — see `RecordingClock.nextTickTarget`.
            // A missing anchor can't happen here (we only get past
            // `emitMetronomeFrame` returning true when one exists) but if it
            // ever did, fall back to the fixed interval rather than spinning
            // the loop at full tilt.
            guard let start = recordingStartTime else {
                try? await Task.sleep(for: .nanoseconds(sleepNanos))
                continue
            }
            let nextTarget = RecordingClock.nextTickTarget(
                start: start,
                pauseAccumulator: pauseAccumulator,
                tickIdx: metronomeTickIdx,
                frameRate: targetFrameRate
            )
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            if let sleepSeconds = RecordingClock.sleepSeconds(untilTarget: nextTarget, now: now) {
                diagnostics.driftPositiveSleep += 1
                try? await Task.sleep(for: .seconds(sleepSeconds))
            } else {
                diagnostics.driftZeroSleep += 1
            }
        }
    }
}
