import CoreMedia

/// The recording's timing arithmetic, as pure functions.
///
/// There is exactly one clock anchoring a recording: `start`, the host-clock
/// time at which output frame 0 sits. Everything else derives from it:
///
///     logical  = (sampleHostTime - start) - pauseAccumulator
///     encoder  = primingOffset + logical
///
/// Audio uses each sample's own hardware PTS; video uses the capture PTS of
/// the source frame it composited. Both therefore stamp content at the moment
/// it hit the hardware, which is what keeps A/V aligned regardless of capture
/// pipeline latency.
///
/// Every function here takes its inputs explicitly and reads no clock of its
/// own, so the app's subtlest logic — the freshness gate, keep-alive
/// decisions, pause accounting, the commit anchor's clamp — can be tested
/// directly. Keep it that way: this is the arithmetic A/V sync rests on, and
/// an innocuous-looking change here breaks it silently. See
/// `RecordingClockTests`.
enum RecordingClock {
    // MARK: - Logical time

    /// Recording time in seconds: wall-clock elapsed minus time spent paused.
    /// Returns 0 before the clock is anchored, so timeline events recorded
    /// during prepare land at t=0 rather than at a garbage offset.
    static func logicalElapsed(now: CMTime, start: CMTime?, pauseAccumulator: CMTime) -> Double {
        guard let start else { return 0 }
        return ((now - start) - pauseAccumulator).seconds
    }

    /// Variant that freezes at the moment the current pause began, so events
    /// triggered *during* a pause land at the clock time the user can see
    /// rather than advancing past it. Identical to `logicalElapsed` when not
    /// paused.
    static func userVisibleElapsed(
        now: CMTime,
        start: CMTime?,
        pauseAccumulator: CMTime,
        pauseStartHostTime: CMTime?
    ) -> Double {
        logicalElapsed(now: pauseStartHostTime ?? now, start: start, pauseAccumulator: pauseAccumulator)
    }

    // MARK: - Commit anchor

    /// Where the recording clock should be anchored at commit, and whether
    /// the cached frame had to be rejected as too old.
    struct Anchor: Equatable {
        let time: CMTime
        /// True when the cached source frame was older than `maxAge` and the
        /// anchor was clamped to `now - maxAge` instead. The caller logs the
        /// measured age when this fires.
        let clamped: Bool
    }

    /// Pick the commit anchor from the freshest cached source frame.
    ///
    /// Anchoring to the frame's capture PTS rather than to `now` absorbs the
    /// capture pipeline's latency (~40-80ms built-in, more over USB). Anchored
    /// at `now`, that already-captured frame has negative elapsed, gets
    /// rejected, and the metronome waits a whole capture cycle before it can
    /// emit — while audio's first sample lands near t=0. Net effect: audio
    /// leads video by the pipeline latency.
    ///
    /// `maxAge` bounds the other direction. An unusually stale cached frame
    /// (a USB hiccup right at commit) would push audio far *ahead* of the
    /// anchor, trading an audio-leads bug for a potentially larger
    /// video-leads one.
    ///
    /// A cached PTS *ahead* of `now` is rejected too. Capture sources stamp
    /// against the host clock so it shouldn't happen — but a corrupt camera
    /// timeline (the CMIO meltdown) can produce one, and an anchor in the
    /// future makes every subsequent sample compute a negative elapsed and
    /// get dropped, silently truncating the head of the recording.
    static func commitAnchor(now: CMTime, cachedPTS: CMTime?, maxAge: CMTime) -> Anchor {
        guard let cachedPTS, cachedPTS.isValid else {
            return Anchor(time: now - maxAge, clamped: true)
        }
        let age = now - cachedPTS
        guard age >= .zero, age <= maxAge else {
            return Anchor(time: now - maxAge, clamped: true)
        }
        return Anchor(time: cachedPTS, clamped: false)
    }

    // MARK: - PTS derivation

    /// Logical PTS for content captured at `capturePTS`. Negative when the
    /// content predates the anchor, which callers reject.
    static func logicalPTS(capturePTS: CMTime, start: CMTime, pauseAccumulator: CMTime) -> CMTime {
        (capturePTS - start) - pauseAccumulator
    }

    /// Encoder-domain PTS for the HLS writer: logical time shifted by the AAC
    /// priming offset so priming samples have a positive landing pad.
    static func encoderPTS(logical: CMTime) -> CMTime {
        TimestampAdjuster.defaultPrimingOffset + logical
    }

    /// Strip the priming offset back off an encoder PTS. Used for diagnostics
    /// so every number in the trace is in recording-time seconds.
    static func logicalSeconds(fromEncoderPTS pts: CMTime) -> Double? {
        guard pts.isValid else { return nil }
        return (pts - TimestampAdjuster.defaultPrimingOffset).seconds
    }

    /// Output PTS for a composite drawn from two live sources: whichever of
    /// them captured most recently, so the output advances whenever either
    /// has put new content in the frame.
    ///
    /// `secondary` is ignored when it sits ahead of `now`. Capture sources
    /// stamp against the host clock so that shouldn't happen — but a corrupt
    /// camera timeline (the CMIO meltdown) can produce one, and a PTS in the
    /// future makes every subsequent frame non-monotonic, stopping output
    /// until the wall clock catches up. `primary` is trusted as given: it's
    /// the source the mode is built around, and silently retiming it would be
    /// its own desync.
    static func newestSourcePTS(primary: CMTime, secondary: CMTime?, now: CMTime) -> CMTime {
        guard let secondary, secondary.isValid, secondary > primary, secondary <= now else { return primary }
        return secondary
    }

    // MARK: - Freshness gate

    /// True when a source frame can't produce an emittable output frame — it
    /// predates the recording anchor, it wouldn't advance the PTS already
    /// handed to the encoder, or it isn't strictly newer than the frame
    /// behind the last real emit. Compositing it would only produce a frame
    /// the encoder rejects downstream.
    ///
    /// This is the primary defence against non-monotonic video PTS, and it
    /// has to answer the whole emittability question: a tick that fails here
    /// falls through to the keep-alive path, whereas one rejected further
    /// down emits nothing at all and re-composites the same doomed frame on
    /// every subsequent tick. The encoder-level checks behind it are safety
    /// nets that should never fire. Invalid watermarks mean nothing has been
    /// emitted yet, so those tests pass and only the anchor test applies.
    ///
    /// The anchor test covers a recording that starts on a source which isn't
    /// changing. A static display hands the metronome a cached frame captured
    /// seconds before commit, whose logical PTS is negative and stays
    /// negative until the display next changes.
    ///
    /// The `lastEmittedVideoPTS` test covers the other end of a static run.
    /// Keep-alives stamp output with host time while deliberately leaving
    /// `lastEmittedSourcePTS` alone, so the frame that ends the run is newer
    /// than the source watermark but can still land behind the last
    /// keep-alive — by up to one capture lag, whenever the content changed
    /// just before a keep-alive fired and arrived just after.
    static func isStaleSource(
        capturePTS: CMTime,
        lastEmittedSourcePTS: CMTime,
        lastEmittedVideoPTS: CMTime,
        start: CMTime,
        pauseAccumulator: CMTime
    ) -> Bool {
        let logical = logicalPTS(capturePTS: capturePTS, start: start, pauseAccumulator: pauseAccumulator)
        if logical < .zero { return true }
        if breaksMonotonicity(pts: encoderPTS(logical: logical), lastEmittedVideoPTS: lastEmittedVideoPTS) {
            return true
        }
        guard lastEmittedSourcePTS.isValid else { return false }
        return capturePTS <= lastEmittedSourcePTS
    }

    /// True when `pts` would break strict monotonicity against the last PTS
    /// handed to the encoder. An invalid watermark accepts anything.
    static func breaksMonotonicity(pts: CMTime, lastEmittedVideoPTS: CMTime) -> Bool {
        guard lastEmittedVideoPTS.isValid else { return false }
        return pts <= lastEmittedVideoPTS
    }

    // MARK: - Keep-alive

    /// How long the source must have been static before a keep-alive emit
    /// fires. Much greater than a metronome tick (so we don't re-emit
    /// duplicates constantly), much less than the writer's segment interval
    /// (so a segment never sees enough dead air to come out empty).
    static let keepAliveThresholdSeconds: Double = 1.0

    /// Whether a keep-alive repeat is due, and how long the static run has
    /// been going. `nil` means no — either the clock isn't armed yet, or the
    /// last emit is too recent to count as a static run.
    ///
    /// A keep-alive's PTS is wall-clock-anchored (`now` substituted for the
    /// source capture time) rather than derived from a source frame, which is
    /// what holds A/V together through the run: audio keeps advancing at its
    /// real cadence while video repeats the last frame.
    ///
    /// Before the first emit the threshold doesn't apply. The recording has
    /// no picture at all at that point, so there's nothing to duplicate and
    /// nothing to space out — waiting a full threshold would only leave a
    /// hole at the head of the video. `lastEmitHostTime` is armed at commit
    /// so this case is reachable at all: a source that is static from the
    /// very first tick never produces the real emit that would arm it.
    static func keepAliveStaleDuration(
        now: CMTime,
        lastEmitHostTime: CMTime,
        lastEmittedVideoPTS: CMTime
    ) -> Double? {
        guard lastEmitHostTime.isValid else { return nil }
        let staleDuration = (now - lastEmitHostTime).seconds
        guard lastEmittedVideoPTS.isValid else { return staleDuration }
        guard staleDuration >= keepAliveThresholdSeconds else { return nil }
        return staleDuration
    }

    // MARK: - Pause accounting

    /// The clock state produced by resuming at `now`.
    struct Resumed: Equatable {
        /// Total time spent paused across the whole recording so far.
        let pauseAccumulator: CMTime
        /// Duration of the pause that just ended, for the timeline event.
        let pauseSeconds: Double
        /// Source-PTS watermark bumped to `now`, so a frame captured *during*
        /// the pause reads as stale. Without this a mid-pause screen frame
        /// passes the freshness check (its capture PTS beats the pre-pause
        /// emit's) and then computes an encoder PTS below the last emitted
        /// one, tripping the monotonicity net.
        let lastEmittedSourcePTS: CMTime
        /// Keep-alive anchor restarted from the resume moment, so a long
        /// pause doesn't look like a static run and fire a synthetic frame on
        /// the first post-resume tick.
        let lastEmitHostTime: CMTime
    }

    /// Fold a completed pause into the clock.
    ///
    /// Both watermarks are left untouched when invalid: an invalid
    /// `lastEmittedSourcePTS` means no real emit has happened yet, so
    /// `isStaleSource` already falls through to its anchor test, and an
    /// unarmed keep-alive clock short-circuits. Neither is initialised by a
    /// pause path — the source watermark comes from a real emit, the
    /// keep-alive clock from commit.
    static func resume(
        now: CMTime,
        pauseStartHostTime: CMTime?,
        pauseAccumulator: CMTime,
        lastEmittedSourcePTS: CMTime,
        lastEmitHostTime: CMTime
    ) -> Resumed {
        var accumulator = pauseAccumulator
        var pauseSeconds: Double = 0
        if let pauseStartHostTime {
            let pauseDuration = now - pauseStartHostTime
            accumulator = accumulator + pauseDuration // swiftlint:disable:this shorthand_operator
            pauseSeconds = pauseDuration.seconds
        }
        return Resumed(
            pauseAccumulator: accumulator,
            pauseSeconds: pauseSeconds,
            lastEmittedSourcePTS: lastEmittedSourcePTS.isValid
                ? max(lastEmittedSourcePTS, now)
                : lastEmittedSourcePTS,
            lastEmitHostTime: lastEmitHostTime.isValid ? now : lastEmitHostTime
        )
    }

    /// True when a sample captured before the recording resumed must be
    /// dropped.
    ///
    /// Capture delivery lags the hardware, so a sample captured just before a
    /// resume can arrive just after it — past the paused-check, but with the
    /// whole pause already folded into `pauseAccumulator`. Its logical PTS
    /// then lands *behind* the last pre-pause sample, and a writer handed a
    /// backward PTS rejects the sample and fails the whole input. The window
    /// is one delivery latency wide, ~20-50ms for audio.
    ///
    /// An invalid resume time means the recording has never been resumed, so
    /// nothing can predate one.
    static func predatesResume(capturePTS: CMTime, lastResumeHostTime: CMTime) -> Bool {
        guard lastResumeHostTime.isValid else { return false }
        return capturePTS < lastResumeHostTime
    }

    // MARK: - Metronome scheduling

    /// Host-clock time tick `tickIdx` should fire at. Drift-corrected against
    /// the recording anchor rather than accumulated from sleeps, so ticks
    /// stay on a steady 1/fps grid however long each iteration took.
    ///
    /// `pauseAccumulator` is read for the current iteration only — pause and
    /// resume cancel and restart the loop with `tickIdx` back at 0.
    static func nextTickTarget(
        start: CMTime,
        pauseAccumulator: CMTime,
        tickIdx: Int64,
        frameRate: Int32
    ) -> CMTime {
        start + pauseAccumulator + CMTime(value: tickIdx, timescale: frameRate)
    }

    /// Seconds to sleep before the next tick, or nil when the loop is already
    /// at or past its target and should run straight on.
    static func sleepSeconds(untilTarget target: CMTime, now: CMTime) -> Double? {
        let seconds = (target - now).seconds
        return seconds > 0 ? seconds : nil
    }
}
