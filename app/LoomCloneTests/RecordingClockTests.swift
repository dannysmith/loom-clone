import CoreMedia
@testable import LoomClone
import XCTest

/// Unit tests for the recording clock — the PTS arithmetic, freshness gate,
/// keep-alive decision, pause accounting, and commit anchor that A/V sync
/// rests on. This is the logic an innocuous-looking future edit is most
/// likely to break silently, so the tests aim at the invariants rather than
/// at particular numbers: PTS is monotonic, a pause is invisible on the
/// output timeline, and the anchor never lands in the future.
final class RecordingClockTests: XCTestCase {
    /// Host-clock CMTimes in these tests use a nanosecond timescale, matching
    /// `CMClockGetHostTimeClock()`'s real resolution closely enough that the
    /// arithmetic under test behaves identically.
    private func t(_ seconds: Double) -> CMTime {
        CMTime(seconds: seconds, preferredTimescale: 1_000_000_000)
    }

    private var priming: Double {
        TimestampAdjuster.defaultPrimingOffset.seconds
    }

    // MARK: - Logical elapsed

    func testLogicalElapsedIsZeroBeforeTheClockIsAnchored() {
        // Events recorded during prepare must land at t=0, not at a garbage
        // offset derived from a nil anchor.
        XCTAssertEqual(
            RecordingClock.logicalElapsed(now: t(1234), start: nil, pauseAccumulator: .zero),
            0
        )
    }

    func testLogicalElapsedSubtractsPausedTime() {
        let elapsed = RecordingClock.logicalElapsed(
            now: t(100),
            start: t(40),
            pauseAccumulator: t(15)
        )
        XCTAssertEqual(elapsed, 45, accuracy: 1e-6)
    }

    func testUserVisibleElapsedFreezesDuringAPause() {
        // Wall clock has moved on 10s since the pause began; the user-visible
        // clock has not, so an event fired during the pause lands where the
        // timer on screen says it should.
        let frozen = RecordingClock.userVisibleElapsed(
            now: t(70),
            start: t(10),
            pauseAccumulator: .zero,
            pauseStartHostTime: t(60)
        )
        XCTAssertEqual(frozen, 50, accuracy: 1e-6)
    }

    func testUserVisibleElapsedMatchesLogicalWhenNotPaused() {
        let live = RecordingClock.userVisibleElapsed(
            now: t(70),
            start: t(10),
            pauseAccumulator: t(5),
            pauseStartHostTime: nil
        )
        XCTAssertEqual(live, RecordingClock.logicalElapsed(now: t(70), start: t(10), pauseAccumulator: t(5)))
    }

    // MARK: - Commit anchor

    func testAnchorUsesTheCachedFrameWhenItIsFreshEnough() {
        // The whole point: a frame captured 40ms ago anchors at its own
        // capture time so it can be emitted immediately with elapsed = 0,
        // instead of being rejected while audio races ahead.
        let anchor = RecordingClock.commitAnchor(
            now: t(100),
            cachedPTS: t(99.96),
            maxAge: RecordingActor.maxCommitAnchorAge
        )
        XCTAssertFalse(anchor.clamped)
        XCTAssertEqual(anchor.time.seconds, 99.96, accuracy: 1e-6)
    }

    func testAnchorClampsAStaleCachedFrame() {
        let maxAge = RecordingActor.maxCommitAnchorAge
        let anchor = RecordingClock.commitAnchor(now: t(100), cachedPTS: t(95), maxAge: maxAge)
        XCTAssertTrue(anchor.clamped)
        XCTAssertEqual(anchor.time.seconds, 100 - maxAge.seconds, accuracy: 1e-6)
    }

    func testAnchorClampsWhenThereIsNoCachedFrameAtAll() {
        let maxAge = RecordingActor.maxCommitAnchorAge
        let anchor = RecordingClock.commitAnchor(now: t(100), cachedPTS: nil, maxAge: maxAge)
        XCTAssertTrue(anchor.clamped)
        XCTAssertEqual(anchor.time.seconds, 100 - maxAge.seconds, accuracy: 1e-6)
    }

    func testAnchorRejectsAnInvalidCachedPTS() {
        let anchor = RecordingClock.commitAnchor(
            now: t(100),
            cachedPTS: .invalid,
            maxAge: RecordingActor.maxCommitAnchorAge
        )
        XCTAssertTrue(anchor.clamped)
    }

    func testAnchorNeverLandsInTheFuture() {
        // A cached frame stamped ahead of the host clock (a misbehaving
        // capture device) must not push the anchor past `now` — every
        // subsequent sample would compute a negative elapsed and be dropped.
        let anchor = RecordingClock.commitAnchor(
            now: t(100),
            cachedPTS: t(100.5),
            maxAge: RecordingActor.maxCommitAnchorAge
        )
        XCTAssertLessThanOrEqual(anchor.time.seconds, 100)
    }

    // MARK: - PTS derivation

    func testLogicalPTSIsRelativeToTheAnchorAndNetOfPauses() {
        let logical = RecordingClock.logicalPTS(
            capturePTS: t(30),
            start: t(10),
            pauseAccumulator: t(4)
        )
        XCTAssertEqual(logical.seconds, 16, accuracy: 1e-6)
    }

    func testEncoderPTSAddsThePrimingOffset() {
        let encoder = RecordingClock.encoderPTS(logical: t(2))
        XCTAssertEqual(encoder.seconds, 2 + priming, accuracy: 1e-6)
    }

    func testEncoderPTSRoundTripsBackToLogicalSeconds() {
        let encoder = RecordingClock.encoderPTS(logical: t(7.5))
        XCTAssertEqual(RecordingClock.logicalSeconds(fromEncoderPTS: encoder) ?? .nan, 7.5, accuracy: 1e-6)
    }

    func testLogicalSecondsOfAnInvalidPTSIsNil() {
        // The "nothing emitted yet" case — trace rows record it as absent
        // rather than as a bogus number.
        XCTAssertNil(RecordingClock.logicalSeconds(fromEncoderPTS: .invalid))
    }

    func testPrimingOffsetKeepsEarlyAudioPositive() {
        // The offset exists so AAC priming samples land at a positive PTS
        // instead of being dropped, leaving a gap at t=0.
        let earlyAudio = RecordingClock.encoderPTS(logical: t(0))
        XCTAssertGreaterThan(earlyAudio.seconds, 0)
    }

    // MARK: - Freshness gate

    /// `isStaleSource` with an anchor at zero, for the cases that are only
    /// about the freshness watermark.
    private func isStale(_ capturePTS: CMTime, watermark: CMTime) -> Bool {
        RecordingClock.isStaleSource(
            capturePTS: capturePTS,
            lastEmittedSourcePTS: watermark,
            start: .zero,
            pauseAccumulator: .zero
        )
    }

    func testNothingIsStaleBeforeTheFirstEmit() {
        XCTAssertFalse(isStale(t(5), watermark: .invalid))
    }

    func testFrameNewerThanTheWatermarkIsFresh() {
        XCTAssertFalse(isStale(t(5.01), watermark: t(5)))
    }

    func testRepeatedFrameIsStale() {
        // A static screen re-delivers the same capture PTS; compositing it
        // again would only produce a frame the encoder rejects.
        XCTAssertTrue(isStale(t(5), watermark: t(5)))
    }

    func testOlderFrameIsStale() {
        XCTAssertTrue(isStale(t(4.9), watermark: t(5)))
    }

    func testFrameCapturedBeforeTheAnchorIsStale() {
        // The static-display case: the cached frame at commit was captured
        // seconds before the anchor, so its logical PTS is negative and stays
        // negative until the display next changes. Nothing has been emitted
        // yet, so only the anchor test can catch it.
        XCTAssertTrue(RecordingClock.isStaleSource(
            capturePTS: t(98.4),
            lastEmittedSourcePTS: .invalid,
            start: t(100),
            pauseAccumulator: .zero
        ))
    }

    func testFrameCapturedAtTheAnchorIsEmittable() {
        // The anchor is normally the cached frame's own capture PTS, so that
        // frame lands at logical 0 and must pass — rejecting it would leave
        // every recording a frame short at the head.
        XCTAssertFalse(RecordingClock.isStaleSource(
            capturePTS: t(100),
            lastEmittedSourcePTS: .invalid,
            start: t(100),
            pauseAccumulator: .zero
        ))
    }

    func testFrameCapturedDuringACompletedPauseIsStale() {
        // Its logical PTS is negative once the pause is folded in. `resume`
        // bumps the watermark past the pause as well; this is the backstop
        // for a frame that slips through on a tight race.
        XCTAssertTrue(RecordingClock.isStaleSource(
            capturePTS: t(105),
            lastEmittedSourcePTS: .invalid,
            start: t(100),
            pauseAccumulator: t(10)
        ))
    }

    // MARK: - Two-source timing

    func testNewestSourceWinsWhenTheSecondaryIsAhead() {
        // A static screen with a live camera: the camera is the only thing
        // putting new content in the frame, so it drives output timing.
        XCTAssertEqual(
            RecordingClock.newestSourcePTS(primary: t(98), secondary: t(100), now: t(100.02)).seconds,
            100,
            accuracy: 1e-6
        )
    }

    func testPrimarySourceWinsWhenTheSecondaryIsBehind() {
        XCTAssertEqual(
            RecordingClock.newestSourcePTS(primary: t(100), secondary: t(99.9), now: t(100.02)).seconds,
            100,
            accuracy: 1e-6
        )
    }

    func testSecondarySourceIsIgnoredWithoutAFrame() {
        XCTAssertEqual(
            RecordingClock.newestSourcePTS(primary: t(100), secondary: nil, now: t(100.02)).seconds,
            100,
            accuracy: 1e-6
        )
    }

    func testSecondarySourceCannotStampTheOutputIntoTheFuture() {
        // A corrupt camera timeline (the CMIO meltdown) can stamp frames ahead
        // of the host clock. Accepting one would make every later frame
        // non-monotonic until the wall clock caught up.
        XCTAssertEqual(
            RecordingClock.newestSourcePTS(primary: t(100), secondary: t(102), now: t(100.02)).seconds,
            100,
            accuracy: 1e-6
        )
    }

    // MARK: - Monotonicity net

    func testMonotonicityNetAcceptsAnythingBeforeTheFirstEmit() {
        XCTAssertFalse(RecordingClock.breaksMonotonicity(pts: t(0), lastEmittedVideoPTS: .invalid))
    }

    func testMonotonicityNetRejectsEqualAndBackwardPTS() {
        XCTAssertTrue(RecordingClock.breaksMonotonicity(pts: t(10), lastEmittedVideoPTS: t(10)))
        XCTAssertTrue(RecordingClock.breaksMonotonicity(pts: t(9.999), lastEmittedVideoPTS: t(10)))
        XCTAssertFalse(RecordingClock.breaksMonotonicity(pts: t(10.001), lastEmittedVideoPTS: t(10)))
    }

    // MARK: - Keep-alive

    func testNoKeepAliveBeforeTheClockIsArmed() {
        XCTAssertNil(RecordingClock.keepAliveStaleDuration(
            now: t(100),
            lastEmitHostTime: .invalid,
            lastEmittedVideoPTS: .invalid
        ))
    }

    func testNoKeepAliveDuringNormalCadence() {
        XCTAssertNil(RecordingClock.keepAliveStaleDuration(
            now: t(100.033),
            lastEmitHostTime: t(100),
            lastEmittedVideoPTS: t(10)
        ))
    }

    func testKeepAliveFiresOnceTheRunPassesTheThreshold() {
        let threshold = RecordingClock.keepAliveThresholdSeconds
        let stale = RecordingClock.keepAliveStaleDuration(
            now: t(100 + threshold + 0.5),
            lastEmitHostTime: t(100),
            lastEmittedVideoPTS: t(10)
        )
        XCTAssertEqual(stale ?? .nan, threshold + 0.5, accuracy: 1e-6)
    }

    func testFirstHeldFrameIsDueOnTheFirstTick() {
        // Recording started on a source that isn't changing: nothing can be
        // emitted from it, and waiting out the threshold would leave the head
        // of the video without a picture. The clock is armed at commit, so
        // one tick's worth of staleness is enough.
        let stale = RecordingClock.keepAliveStaleDuration(
            now: t(100.033),
            lastEmitHostTime: t(100),
            lastEmittedVideoPTS: .invalid
        )
        XCTAssertEqual(stale ?? .nan, 0.033, accuracy: 1e-6)
    }

    func testTheThresholdAppliesAgainOnceSomethingHasBeenEmitted() {
        // Only the first held frame skips the threshold — after that a static
        // run holds at the keep-alive rate rather than re-emitting per tick.
        XCTAssertNil(RecordingClock.keepAliveStaleDuration(
            now: t(100.066),
            lastEmitHostTime: t(100.033),
            lastEmittedVideoPTS: t(0.033)
        ))
    }

    func testKeepAliveThresholdSitsBetweenATickAndASegment() {
        // Much greater than a 60fps tick so we don't spam duplicates; well
        // under the segment interval so no segment ever sees enough dead air
        // to come out empty.
        XCTAssertGreaterThan(RecordingClock.keepAliveThresholdSeconds, 1.0 / 60.0)
        XCTAssertLessThan(RecordingClock.keepAliveThresholdSeconds, WriterActor.segmentIntervalSeconds)
    }

    // MARK: - Pause accounting

    func testResumeAccumulatesThePauseDuration() {
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: t(60),
            pauseAccumulator: t(5),
            lastEmittedSourcePTS: t(59),
            lastEmitHostTime: t(59)
        )
        XCTAssertEqual(resumed.pauseAccumulator.seconds, 15, accuracy: 1e-6)
        XCTAssertEqual(resumed.pauseSeconds, 10, accuracy: 1e-6)
    }

    func testPauseIsInvisibleOnTheOutputTimeline() {
        // The property that matters: content captured either side of a pause
        // is contiguous in logical time. Record at 59s, pause for 10s, record
        // again immediately after resume — the output gap is ~0, not ~10s.
        let start = t(10)
        let beforePause = RecordingClock.logicalPTS(capturePTS: t(59), start: start, pauseAccumulator: .zero)
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: t(60),
            pauseAccumulator: .zero,
            lastEmittedSourcePTS: t(59),
            lastEmitHostTime: t(59)
        )
        let afterResume = RecordingClock.logicalPTS(
            capturePTS: t(70.1),
            start: start,
            pauseAccumulator: resumed.pauseAccumulator
        )
        XCTAssertEqual((afterResume - beforePause).seconds, 1.1, accuracy: 1e-6)
    }

    func testResumeBumpsTheSourceWatermarkPastThePause() {
        // A screen frame captured mid-pause is newer than the pre-pause emit,
        // so without this bump it passes the freshness gate and then computes
        // an encoder PTS below the last emitted one.
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: t(60),
            pauseAccumulator: .zero,
            lastEmittedSourcePTS: t(59),
            lastEmitHostTime: t(59)
        )
        XCTAssertTrue(RecordingClock.isStaleSource(
            capturePTS: t(65),
            lastEmittedSourcePTS: resumed.lastEmittedSourcePTS,
            start: t(10),
            pauseAccumulator: resumed.pauseAccumulator
        ))
    }

    func testResumeRestartsTheKeepAliveRun() {
        // Without this, a 10s pause looks like a 10s static run and fires a
        // synthetic frame on the very first post-resume tick.
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: t(60),
            pauseAccumulator: .zero,
            lastEmittedSourcePTS: t(59),
            lastEmitHostTime: t(59)
        )
        XCTAssertNil(RecordingClock.keepAliveStaleDuration(
            now: t(70.001),
            lastEmitHostTime: resumed.lastEmitHostTime,
            lastEmittedVideoPTS: t(49)
        ))
    }

    func testResumeLeavesInvalidWatermarksAlone() {
        // Invalid means nothing has been emitted yet and the clock was never
        // armed, so the freshness gate falls through to its anchor test and
        // the keep-alive path short-circuits. A pause must not be what
        // initialises either.
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: t(60),
            pauseAccumulator: .zero,
            lastEmittedSourcePTS: .invalid,
            lastEmitHostTime: .invalid
        )
        XCTAssertFalse(resumed.lastEmittedSourcePTS.isValid)
        XCTAssertFalse(resumed.lastEmitHostTime.isValid)
    }

    func testResumeWithoutARecordedPauseStartIsANoOp() {
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: nil,
            pauseAccumulator: t(3),
            lastEmittedSourcePTS: t(59),
            lastEmitHostTime: t(59)
        )
        XCTAssertEqual(resumed.pauseAccumulator.seconds, 3, accuracy: 1e-6)
        XCTAssertEqual(resumed.pauseSeconds, 0)
    }

    func testWatermarkBumpNeverMovesBackwards() {
        // `now` can be older than the watermark if a source stamped a frame
        // slightly ahead of the host clock. max() keeps the gate monotonic.
        let resumed = RecordingClock.resume(
            now: t(70),
            pauseStartHostTime: t(69),
            pauseAccumulator: .zero,
            lastEmittedSourcePTS: t(75),
            lastEmitHostTime: t(75)
        )
        XCTAssertEqual(resumed.lastEmittedSourcePTS.seconds, 75, accuracy: 1e-6)
    }

    // MARK: - Metronome scheduling

    func testTickTargetsSitOnAFixedGrid() {
        let start = t(10)
        let first = RecordingClock.nextTickTarget(start: start, pauseAccumulator: .zero, tickIdx: 1, frameRate: 30)
        let sixtieth = RecordingClock.nextTickTarget(start: start, pauseAccumulator: .zero, tickIdx: 60, frameRate: 30)
        XCTAssertEqual(first.seconds, 10 + 1.0 / 30.0, accuracy: 1e-6)
        XCTAssertEqual(sixtieth.seconds, 12, accuracy: 1e-6)
    }

    func testTickTargetsShiftByTimeSpentPaused() {
        let target = RecordingClock.nextTickTarget(
            start: t(10),
            pauseAccumulator: t(5),
            tickIdx: 30,
            frameRate: 30
        )
        XCTAssertEqual(target.seconds, 16, accuracy: 1e-6)
    }

    func testDriftCorrectionShortensTheSleepWhenTheLoopRunsLate() {
        // The point of correcting against the anchor rather than accumulating
        // sleeps: a slow iteration is absorbed instead of pushing every
        // subsequent tick later.
        let target = RecordingClock.nextTickTarget(start: t(10), pauseAccumulator: .zero, tickIdx: 30, frameRate: 30)
        let onTime = RecordingClock.sleepSeconds(untilTarget: target, now: t(10.9))
        let late = RecordingClock.sleepSeconds(untilTarget: target, now: t(10.99))
        XCTAssertNotNil(onTime)
        XCTAssertNotNil(late)
        XCTAssertLessThan(late ?? .infinity, onTime ?? 0)
    }

    func testNoSleepWhenAlreadyPastTheTarget() {
        let target = RecordingClock.nextTickTarget(start: t(10), pauseAccumulator: .zero, tickIdx: 30, frameRate: 30)
        XCTAssertNil(RecordingClock.sleepSeconds(untilTarget: target, now: t(12)))
        XCTAssertNil(RecordingClock.sleepSeconds(untilTarget: target, now: target))
    }
}
