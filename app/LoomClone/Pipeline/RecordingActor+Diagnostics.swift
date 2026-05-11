import CoreMedia
import Foundation

// MARK: - Diagnostic value types

/// One row in the per-tick metronome trace. Packed tight (~80 bytes) so a
/// rolling buffer of 4 000 entries stays under 400 KB. Times are seconds
/// relative to `recordingStartTime` so they line up with everything else on
/// the timeline.
struct MetronomeTickEntry: Encodable {
    /// Iteration counter — increments on every loop body, not just on emit.
    let iter: Int64
    /// `metronomeTickIdx` at the moment of decision (only advances on emit).
    let emittedTickIdx: Int64
    /// Host-clock seconds since `recordingStartTime`.
    let hostT: Double
    /// Camera FIFO depth before any pop this tick.
    let queueDepthBefore: Int
    /// `cameraOnly` branch taken: "pop" | "repeat" | "noSource" | "n/a"
    let cameraBranch: String
    /// Candidate sourcePTS (seconds since `recordingStartTime`).
    /// `nil` when no source frame was available.
    let sourcePTS: Double?
    /// Logical elapsed (= sourcePTS - start - pauseAcc). Same units.
    let elapsedLogical: Double?
    /// Computed emit PTS (= primingOffset + elapsedLogical). Same units.
    /// Note: in actual encoder PTS this has the priming offset added; we
    /// strip it here so all numbers in the trace are recording-time seconds.
    let emitPTS: Double?
    /// `lastEmittedVideoPTS` AS-OBSERVED by this tick's monotonicity guard,
    /// stripped of the priming offset for readability.
    let lastEmitPTS: Double?
    /// Composition duration (seconds). 0 when composition was skipped.
    let compositeS: Double
    /// What happened: see `MetronomeTickAction`.
    let action: String
    /// Drift signed seconds at end of iteration (negative = behind schedule).
    let driftS: Double
    /// Sleep duration the loop took at end of iteration (seconds).
    /// 0 if the drift-corrected sleep was non-positive.
    let sleepS: Double
}

enum MetronomeTickAction {
    static let emit = "emit"
    static let rejectMonotonicity = "reject:mono"
    static let rejectNegElapsed = "reject:negElapsed"
    static let rejectInvalidPTS = "reject:invalidPTS"
    static let rejectSampleBuild = "reject:sampleBuild"
    /// Source-PTS freshness check skipped this tick (Phase 1/2). Distinct
    /// from `noSource` — we have a cached frame, it's just not strictly
    /// newer than what we last emitted.
    static let skipStale = "skipStale"
    /// Phase 3 keep-alive: emitted a synthetic-PTS repeat of the last
    /// cached source during a long static-source run.
    static let keepalive = "keepalive"
    static let noSource = "noSource"
    static let compositionFail = "compositionFail"
    static let notRecording = "notRecording"
    static let noStart = "noStart"
}

/// First-N camera frames captured in detail. Each entry is independent of
/// the metronome — fired from `handleCameraFrame`. Used to characterise the
/// camera's actual delivery cadence (e.g. confirm Opal at 30fps or detect
/// 60→30 downsampling under low light).
struct CameraFrameTraceEntry: Encodable {
    /// Sequential count of camera frame arrivals, starting at 1.
    let n: Int64
    /// Host-clock seconds at the moment the callback fired, relative to
    /// `recordingStartTime` (negative if before commit).
    let hostT: Double
    /// Raw capturePTS (seconds since `recordingStartTime`).
    let capturePTS: Double
    /// `hostT - capturePTS` — the latency between the camera's reported
    /// capture moment and our handler firing.
    let captureLagS: Double
    /// Gap between this frame's capturePTS and the previous frame's
    /// capturePTS, in seconds. nil for the first frame.
    let gapFromPreviousS: Double?
    /// Camera FIFO depth AFTER this frame was appended (and any
    /// over-capacity eviction).
    let queueDepthAfter: Int
    /// True if this frame caused an eviction (FIFO was at capacity).
    let causedEviction: Bool
}

/// Same shape but for the screen capture path. Captured in detail for the
/// first N frames; aggregate-only after that.
struct ScreenFrameTraceEntry: Encodable {
    let n: Int64
    let hostT: Double
    let capturePTS: Double
    let captureLagS: Double
    let gapFromPreviousS: Double?
}

/// Camera format dump: what the device advertises before we pick one. Logged
/// to the timeline as a single event so we can see what Opal (or whoever) is
/// reporting without re-running the recording.
struct CameraAdvertisedFormat: Encodable {
    let width: Int
    let height: Int
    let pixelFormat: String
    /// One entry per `videoSupportedFrameRateRanges` member.
    let rateRanges: [RateRange]

    struct RateRange: Encodable {
        let minFrameRate: Double
        let maxFrameRate: Double
        let minFrameDurationSeconds: Double
        let maxFrameDurationSeconds: Double
    }
}

// MARK: - MetronomeDiagnostics

/// Aggregate counters + bounded ring buffers for one recording. Lives on
/// `RecordingActor` so all mutations are actor-isolated; we don't need any
/// extra synchronisation.
///
/// Memory ceiling: ~500 KB total. The trace buffers are pre-allocated at
/// reset time to avoid per-tick allocations.
struct MetronomeDiagnostics {
    // MARK: Configuration

    static let metronomeTraceCapacity = 4000 // ~67s at 60fps, ~133s at 30fps
    static let cameraTraceCapacity = 300 // first N camera frames in detail
    static let screenTraceCapacity = 300 // first N screen frames in detail

    // MARK: Counters — metronome

    var iterations: Int64 = 0
    var emitOK: Int64 = 0
    var rejectMonotonicity: Int64 = 0
    var rejectNegElapsed: Int64 = 0
    var rejectInvalidPTS: Int64 = 0
    var rejectSampleBuild: Int64 = 0
    /// Ticks that found a cached source frame but its capturePTS wasn't
    /// strictly newer than `lastEmittedSourcePTS`. Distinct from
    /// `noSourceTicks` (which counts ticks where no cached frame existed
    /// at all). Expected to be non-zero — screen-bursty deliveries and
    /// metronome-over-runs both contribute — and not a regression.
    var skipsStale: Int64 = 0
    /// Phase 3 keep-alive emits — synthetic-PTS repeats fired during a
    /// long static-source run so the segment cutter doesn't see dead air.
    var keepAliveEmits: Int64 = 0
    var noSourceTicks: Int64 = 0
    var compositionFailures: Int64 = 0
    var cameraOnlyPopBranch: Int64 = 0
    /// Pre task-21 (PR #25): the synthetic-host-clock peek-with-repeat
    /// path's fire count. Bug A removed this path; the counter is kept
    /// for one release as a regression-detector — any non-zero value
    /// after task-21 means the path silently re-emerged.
    var cameraOnlyRepeatBranch: Int64 = 0
    var cameraOnlyNoSourceBranch: Int64 = 0
    var idleSleeps: Int64 = 0
    var driftPositiveSleep: Int64 = 0
    var driftZeroSleep: Int64 = 0

    // MARK: Counters — sources

    var cameraFramesReceived: Int64 = 0
    var cameraFramesEvicted: Int64 = 0
    var screenFramesReceived: Int64 = 0
    var audioSamplesReceived: Int64 = 0

    // MARK: Histograms

    // Buckets are inclusive of the right edge of the previous bucket and
    // exclusive of their own right edge: [0, edge[0]), [edge[0], edge[1]), …
    // Last bucket is "≥ last edge".

    /// Camera capture-to-capture interval distribution (host time).
    /// Edges chosen to bracket both 30fps (~33.3ms) and 60fps (~16.7ms).
    static let cameraIntervalEdgesMs: [Double] = [4, 8, 12, 16, 20, 25, 30, 35, 40, 50, 67, 100, 200, 500]
    var cameraIntervalHist: [Int64] = Array(repeating: 0, count: cameraIntervalEdgesMs.count + 1)

    /// Screen capture-to-capture interval distribution.
    static let screenIntervalEdgesMs: [Double] = [4, 8, 12, 16, 20, 25, 30, 35, 40, 50, 67, 100, 200, 500]
    var screenIntervalHist: [Int64] = Array(repeating: 0, count: screenIntervalEdgesMs.count + 1)

    /// FIFO depth distribution at the moment a `cameraOnly` tick popped.
    static let queueDepthEdges: [Int] = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    var queueDepthHist: [Int64] = Array(repeating: 0, count: queueDepthEdges.count + 1)

    /// Composition wall time per tick.
    static let compositeEdgesMs: [Double] = [1, 2, 5, 10, 16, 25, 33, 50, 100, 200, 500, 1000]
    var compositeHist: [Int64] = Array(repeating: 0, count: compositeEdgesMs.count + 1)

    /// Output-PTS gap between consecutive *successful* emits (the actual
    /// cadence we delivered to the encoder).
    static let emitGapEdgesMs: [Double] = [2, 4, 8, 12, 16, 20, 25, 30, 35, 40, 50, 67, 100, 200, 500]
    var emitGapHist: [Int64] = Array(repeating: 0, count: emitGapEdgesMs.count + 1)

    /// How much *older* a monotonicity-rejected sourcePTS was than
    /// `lastEmittedVideoPTS`. All values are positive (delta in ms).
    static let monoRejectEdgesMs: [Double] = [1, 2, 5, 10, 16, 25, 33, 50, 100, 200, 500]
    var monoRejectHist: [Int64] = Array(repeating: 0, count: monoRejectEdgesMs.count + 1)

    /// Capture lag (host_t - capturePTS) when a camera frame arrives.
    /// Tells us how far behind the wall clock the Opal stamps its frames.
    static let captureLagEdgesMs: [Double] = [1, 2, 5, 10, 16, 25, 33, 50, 75, 100, 150, 200]
    var captureLagHist: [Int64] = Array(repeating: 0, count: captureLagEdgesMs.count + 1)

    // MARK: Ring buffers

    var metronomeTrace: [MetronomeTickEntry] = []
    var cameraTrace: [CameraFrameTraceEntry] = []
    var screenTrace: [ScreenFrameTraceEntry] = []

    /// Stored once at startup. Empty until set.
    var advertisedCameraFormats: [CameraAdvertisedFormat] = []
    /// Format actually picked, plus the effective active min/max durations
    /// after we tried to lock to the target rate. Logged in detail so we
    /// can tell whether `activeVideoMin/MaxFrameDuration` actually got set.
    var selectedCameraFormat: SelectedCameraFormat?

    /// Frozen at stop time so derived rates (`effectiveCameraFps`, etc.)
    /// can normalise against the actual recording duration rather than
    /// `cameraTrace.last?.hostT` (which caps at 300 frames). 0 until set.
    var recordingDurationS: Double = 0

    struct SelectedCameraFormat: Encodable {
        let width: Int
        let height: Int
        let pixelFormat: String
        let targetFPS: Int
        let didLockRate: Bool
        let activeMinFrameDurationSeconds: Double
        let activeMaxFrameDurationSeconds: Double
        let advertisedMaxFrameRate: Double
    }

    /// Periodic checkpoint snapshots. Pushed every ~2s during recording so
    /// we can correlate metrics with pauses/mode switches and see if the
    /// drop rate worsens over time.
    var periodicSnapshots: [PeriodicSnapshot] = []

    struct PeriodicSnapshot: Encodable {
        let t: Double
        let iterations: Int64
        let emitOK: Int64
        let rejectMonotonicity: Int64
        let rejectNegElapsed: Int64
        let noSourceTicks: Int64
        let cameraOnlyRepeatBranch: Int64
        let cameraFramesReceived: Int64
        let screenFramesReceived: Int64
    }

    // MARK: Phase 4 — runtime / camera-format projections

    /// Build the v3 `runtime` block on `RecordingTimeline` from the
    /// counters and histograms collected during this recording.
    func buildRuntime() -> RecordingTimeline.Runtime {
        let dur = recordingDurationS
        let canRate = dur > 0.1
        let camFps: Double? = canRate ? Double(cameraFramesReceived) / dur : nil
        let scrFps: Double? = canRate ? Double(screenFramesReceived) / dur : nil
        let outFps: Double? = canRate ? Double(emitOK + keepAliveEmits) / dur : nil
        let camP50 = Self.percentileFromHistogram(
            cameraIntervalHist, edges: Self.cameraIntervalEdgesMs, percentile: 0.5
        )
        let camP95 = Self.percentileFromHistogram(
            cameraIntervalHist, edges: Self.cameraIntervalEdgesMs, percentile: 0.95
        )
        let scrP50 = Self.percentileFromHistogram(
            screenIntervalHist, edges: Self.screenIntervalEdgesMs, percentile: 0.5
        )
        let scrP95 = Self.percentileFromHistogram(
            screenIntervalHist, edges: Self.screenIntervalEdgesMs, percentile: 0.95
        )
        return RecordingTimeline.Runtime(
            effectiveCameraFps: camFps,
            effectiveScreenFps: scrFps,
            outputFps: outFps,
            cameraIntervalP50Ms: camP50,
            cameraIntervalP95Ms: camP95,
            screenIntervalP50Ms: scrP50,
            screenIntervalP95Ms: scrP95,
            metronome: .init(
                iterations: iterations,
                emitOK: emitOK,
                skipsStale: skipsStale,
                keepAliveEmits: keepAliveEmits,
                monoRejects: rejectMonotonicity
            )
        )
    }

    /// Estimate a percentile from a bucketed histogram.
    ///
    /// Conventions:
    /// - For non-overflow buckets, returns the bucket's **upper edge**
    ///   (`edges[i]`). The true percentile lies in `[edges[i-1], edges[i])`.
    /// - For the overflow bucket (counts past `edges.count`), returns
    ///   `edges.last` — which is the overflow bucket's **lower bound**,
    ///   not an upper bound. Samples here are ≥ `edges.last` by an
    ///   unknown amount.
    /// - `percentile == 1.0` therefore commonly hits `edges.last` (the
    ///   overflow bucket's lower bound) when even a single sample
    ///   overflows. Treat it as a floor, not a ceiling.
    /// - Cumulative target uses `ceil(total * percentile)`, so a
    ///   percentile-100% query on a 1-sample histogram still resolves
    ///   to whichever bucket holds that one sample.
    /// - Returns nil when the histogram is empty (total == 0).
    ///
    /// Coarse — resolution is one bucket width — but enough for "is
    /// camera delivery ~33ms?" questions.
    private static func percentileFromHistogram(
        _ counts: [Int64],
        edges: [Double],
        percentile: Double
    ) -> Double? {
        let total = counts.reduce(0, +)
        guard total > 0 else { return nil }
        let target = Int64((Double(total) * percentile).rounded(.up))
        var cumulative: Int64 = 0
        for (i, c) in counts.enumerated() {
            cumulative += c
            if cumulative >= target {
                return i < edges.count ? edges[i] : edges.last
            }
        }
        return edges.last
    }

    /// Trimmed advertised-formats list for the recording.json
    /// `inputs.camera.advertisedFormats` field. Deduplicates by
    /// `(width, height, maxFrameRate)` so the JSON stays small even on
    /// cameras that expose many format descriptors for the same dims.
    func trimmedAdvertisedFormats() -> [RecordingTimeline.Inputs.AdvertisedFormat]? {
        guard !advertisedCameraFormats.isEmpty else { return nil }
        var seen: Set<String> = []
        var result: [RecordingTimeline.Inputs.AdvertisedFormat] = []
        for fmt in advertisedCameraFormats {
            let maxRate = fmt.rateRanges.map(\.maxFrameRate).max() ?? 0
            let minRate = fmt.rateRanges.map(\.minFrameRate).min() ?? 0
            let key = "\(fmt.width)x\(fmt.height)@\(maxRate)"
            if seen.insert(key).inserted {
                result.append(.init(
                    width: fmt.width,
                    height: fmt.height,
                    pixelFormat: fmt.pixelFormat,
                    minFrameRate: minRate,
                    maxFrameRate: maxRate
                ))
            }
        }
        return result
    }

    /// Selected-format projection for `inputs.camera.selectedFormat`.
    /// Drops the diagnostic-only fields (`targetFPS`,
    /// `advertisedMaxFrameRate`) that already exist in
    /// `diagnostics.json`.
    func selectedFormatForRecordingJson() -> RecordingTimeline.Inputs.SelectedFormat? {
        guard let s = selectedCameraFormat else { return nil }
        return .init(
            width: s.width,
            height: s.height,
            pixelFormat: s.pixelFormat,
            didLockRate: s.didLockRate,
            activeMinFrameDurationSeconds: s.activeMinFrameDurationSeconds,
            activeMaxFrameDurationSeconds: s.activeMaxFrameDurationSeconds
        )
    }

    // MARK: Reset

    /// Called from `resetPrepareState`. Re-allocates buffers so a fresh
    /// recording starts with empty arrays of full capacity.
    mutating func reset() {
        self = MetronomeDiagnostics()
        metronomeTrace.reserveCapacity(Self.metronomeTraceCapacity)
        cameraTrace.reserveCapacity(Self.cameraTraceCapacity)
        screenTrace.reserveCapacity(Self.screenTraceCapacity)
        periodicSnapshots.reserveCapacity(256)
    }

    // MARK: Hot-path recording helpers

    /// Record a per-tick row. Ring-buffer semantics: when full, the oldest
    /// entry is overwritten (we keep the most-recent N).
    mutating func pushTick(_ entry: MetronomeTickEntry) {
        if metronomeTrace.count < Self.metronomeTraceCapacity {
            metronomeTrace.append(entry)
        } else {
            // Index by iter modulo capacity. We post-process at dump time
            // to put them back in order.
            let idx = Int(entry.iter % Int64(Self.metronomeTraceCapacity))
            metronomeTrace[idx] = entry
        }
    }

    mutating func pushCameraFrame(_ entry: CameraFrameTraceEntry) {
        guard cameraTrace.count < Self.cameraTraceCapacity else { return }
        cameraTrace.append(entry)
    }

    mutating func pushScreenFrame(_ entry: ScreenFrameTraceEntry) {
        guard screenTrace.count < Self.screenTraceCapacity else { return }
        screenTrace.append(entry)
    }

    /// Static so callers can do `MetronomeDiagnostics.bumpHistogram(&diagnostics.foo, ...)`
    /// without triggering Swift's exclusive-access rules (a `mutating`
    /// method on the same struct that takes one of its own properties as
    /// `inout` conflicts).
    static func bumpHistogram(_ hist: inout [Int64], edges: [Double], valueMs: Double) {
        for (i, edge) in edges.enumerated() where valueMs < edge {
            hist[i] += 1
            return
        }
        hist[edges.count] += 1
    }

    static func bumpHistogram(_ hist: inout [Int64], edges: [Int], value: Int) {
        for (i, edge) in edges.enumerated() where value < edge {
            hist[i] += 1
            return
        }
        hist[edges.count] += 1
    }

    // MARK: Periodic snapshot

    mutating func pushPeriodicSnapshot(t: Double) {
        guard periodicSnapshots.count < 1024 else { return }
        periodicSnapshots.append(
            PeriodicSnapshot(
                t: t,
                iterations: iterations,
                emitOK: emitOK,
                rejectMonotonicity: rejectMonotonicity,
                rejectNegElapsed: rejectNegElapsed,
                noSourceTicks: noSourceTicks,
                cameraOnlyRepeatBranch: cameraOnlyRepeatBranch,
                cameraFramesReceived: cameraFramesReceived,
                screenFramesReceived: screenFramesReceived
            )
        )
    }

    // MARK: Summary

    /// Human-readable one-line summary, written to console at stop and
    /// included as a single timeline event for at-a-glance diagnosis.
    func summaryLine() -> String {
        let dropRate: Double = iterations > 0
            ? Double(rejectMonotonicity + rejectNegElapsed + rejectInvalidPTS + rejectSampleBuild)
            / Double(iterations)
            : 0
        // Camera rate denominator is the actual recording duration —
        // not `cameraTrace.last?.hostT`, which caps at the 300th frame
        // and would massively over-estimate fps on long recordings.
        let camRate = String(
            format: "%.2f",
            cameraFramesReceived > 0 && recordingDurationS > 0.1
                ? Double(cameraFramesReceived) / recordingDurationS : 0
        )
        return """
        iters=\(iterations) emit=\(emitOK) \
        skipStale=\(skipsStale) keepAlive=\(keepAliveEmits) \
        mono=\(rejectMonotonicity) neg=\(rejectNegElapsed) noSrc=\(noSourceTicks) \
        peek=\(cameraOnlyRepeatBranch) pop=\(cameraOnlyPopBranch) \
        camFrames=\(cameraFramesReceived) (~\(camRate)fps) \
        scrFrames=\(screenFramesReceived) \
        evictions=\(cameraFramesEvicted) \
        compFails=\(compositionFailures) \
        dropRate=\(String(format: "%.1f", dropRate * 100))%
        """
    }

    /// JSON payload written to `diagnostics.json` at stop. Includes ring
    /// buffers, histograms, formats, and periodic snapshots.
    func makeFullDump(sessionID: String, recordedAt: String) -> FullDump {
        // Re-order metronome trace by iter when we wrapped the ring.
        let orderedTrace: [MetronomeTickEntry] = {
            guard iterations > Int64(Self.metronomeTraceCapacity) else { return metronomeTrace }
            // The next-to-write slot holds the oldest live row.
            let nextSlot = Int(iterations % Int64(Self.metronomeTraceCapacity))
            return Array(metronomeTrace[nextSlot...] + metronomeTrace[..<nextSlot])
        }()

        return FullDump(
            schemaVersion: 1,
            sessionId: sessionID,
            recordedAt: recordedAt,
            summary: summaryLine(),
            counters: Counters(
                iterations: iterations,
                emitOK: emitOK,
                rejectMonotonicity: rejectMonotonicity,
                rejectNegElapsed: rejectNegElapsed,
                rejectInvalidPTS: rejectInvalidPTS,
                rejectSampleBuild: rejectSampleBuild,
                skipsStale: skipsStale,
                keepAliveEmits: keepAliveEmits,
                noSourceTicks: noSourceTicks,
                compositionFailures: compositionFailures,
                cameraOnlyPopBranch: cameraOnlyPopBranch,
                cameraOnlyRepeatBranch: cameraOnlyRepeatBranch,
                cameraOnlyNoSourceBranch: cameraOnlyNoSourceBranch,
                idleSleeps: idleSleeps,
                driftPositiveSleep: driftPositiveSleep,
                driftZeroSleep: driftZeroSleep,
                cameraFramesReceived: cameraFramesReceived,
                cameraFramesEvicted: cameraFramesEvicted,
                screenFramesReceived: screenFramesReceived,
                audioSamplesReceived: audioSamplesReceived
            ),
            histograms: Histograms(
                cameraIntervalMs: makeHistogram(edges: Self.cameraIntervalEdgesMs, counts: cameraIntervalHist),
                screenIntervalMs: makeHistogram(edges: Self.screenIntervalEdgesMs, counts: screenIntervalHist),
                queueDepthOnPop: makeIntHistogram(edges: Self.queueDepthEdges, counts: queueDepthHist),
                compositeMs: makeHistogram(edges: Self.compositeEdgesMs, counts: compositeHist),
                emitGapMs: makeHistogram(edges: Self.emitGapEdgesMs, counts: emitGapHist),
                monoRejectMs: makeHistogram(edges: Self.monoRejectEdgesMs, counts: monoRejectHist),
                captureLagMs: makeHistogram(edges: Self.captureLagEdgesMs, counts: captureLagHist)
            ),
            cameraFormats: advertisedCameraFormats,
            selectedCameraFormat: selectedCameraFormat,
            periodicSnapshots: periodicSnapshots,
            metronomeTrace: orderedTrace,
            cameraTrace: cameraTrace,
            screenTrace: screenTrace
        )
    }

    private func makeHistogram(edges: [Double], counts: [Int64]) -> [HistogramBucket] {
        var buckets: [HistogramBucket] = []
        var prev: Double = 0
        for (i, edge) in edges.enumerated() {
            buckets.append(.init(rangeMin: prev, rangeMaxExclusive: edge, count: counts[i]))
            prev = edge
        }
        buckets.append(.init(rangeMin: prev, rangeMaxExclusive: nil, count: counts[edges.count]))
        return buckets
    }

    private func makeIntHistogram(edges: [Int], counts: [Int64]) -> [HistogramBucket] {
        makeHistogram(edges: edges.map(Double.init), counts: counts)
    }

    struct HistogramBucket: Encodable {
        let rangeMin: Double
        let rangeMaxExclusive: Double?
        let count: Int64
    }

    struct Counters: Encodable {
        let iterations: Int64
        let emitOK: Int64
        let rejectMonotonicity: Int64
        let rejectNegElapsed: Int64
        let rejectInvalidPTS: Int64
        let rejectSampleBuild: Int64
        let skipsStale: Int64
        let keepAliveEmits: Int64
        let noSourceTicks: Int64
        let compositionFailures: Int64
        let cameraOnlyPopBranch: Int64
        let cameraOnlyRepeatBranch: Int64
        let cameraOnlyNoSourceBranch: Int64
        let idleSleeps: Int64
        let driftPositiveSleep: Int64
        let driftZeroSleep: Int64
        let cameraFramesReceived: Int64
        let cameraFramesEvicted: Int64
        let screenFramesReceived: Int64
        let audioSamplesReceived: Int64
    }

    struct Histograms: Encodable {
        let cameraIntervalMs: [HistogramBucket]
        let screenIntervalMs: [HistogramBucket]
        let queueDepthOnPop: [HistogramBucket]
        let compositeMs: [HistogramBucket]
        let emitGapMs: [HistogramBucket]
        let monoRejectMs: [HistogramBucket]
        let captureLagMs: [HistogramBucket]
    }

    /// Top-level dump shape. Written to `diagnostics.json` next to
    /// `recording.json`.
    ///
    /// Buffer caps to be aware of when reading the dump:
    /// - `metronomeTrace` is a ring buffer of `metronomeTraceCapacity`
    ///   (4000) entries. At 60fps that fills in ~67s; at 30fps ~133s.
    ///   Longer recordings retain only the most-recent N ticks — earlier
    ///   ones are overwritten by `pushTick`. Aggregate counters +
    ///   histograms cover the whole recording regardless.
    /// - `cameraTrace` and `screenTrace` are first-N captures
    ///   (`cameraTraceCapacity` = `screenTraceCapacity` = 300), so they
    ///   describe the recording's start-up window, not its steady
    ///   state.
    struct FullDump: Encodable {
        let schemaVersion: Int
        let sessionId: String
        let recordedAt: String
        let summary: String
        let counters: Counters
        let histograms: Histograms
        let cameraFormats: [CameraAdvertisedFormat]
        let selectedCameraFormat: SelectedCameraFormat?
        let periodicSnapshots: [PeriodicSnapshot]
        let metronomeTrace: [MetronomeTickEntry]
        let cameraTrace: [CameraFrameTraceEntry]
        let screenTrace: [ScreenFrameTraceEntry]
    }
}

// MARK: - Encodable helper for fourcc-style pixel formats

/// Convert an OSType pixel format to a "420v"-style FourCC, falling back to
/// a hex string for non-printable codes.
enum PixelFormatLabel {
    static func string(for fourCC: OSType) -> String {
        let bytes = [
            UInt8((fourCC >> 24) & 0xFF),
            UInt8((fourCC >> 16) & 0xFF),
            UInt8((fourCC >> 8) & 0xFF),
            UInt8(fourCC & 0xFF),
        ]
        if bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) {
            return String(bytes: bytes, encoding: .ascii) ?? String(format: "0x%08X", fourCC)
        }
        return String(format: "0x%08X", fourCC)
    }
}

// MARK: - RecordingActor dump helpers

extension RecordingActor {
    /// Writes `diagnostics.json` next to the recording bundle and logs a
    /// one-line summary to console. No-op if there's no local save path.
    func writeDiagnosticsDump(sessionID: String) {
        let summary = diagnostics.summaryLine()
        print("[diag-summary] \(summary)")

        guard let localDir = localSavePath else { return }
        let path = localDir.appendingPathComponent("diagnostics.json")
        let dump = diagnostics.makeFullDump(
            sessionID: sessionID,
            recordedAt: ISO8601DateFormatter().string(from: Date())
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(dump)
            try data.write(to: path)
            print("[diag] Wrote \(data.count) bytes to diagnostics.json")
        } catch {
            print("[diag] Failed to write diagnostics dump: \(error)")
        }
    }

    /// Convenience: append a `diagnostics.summary` event to the recording
    /// timeline so the one-line summary is visible in `recording.json` too.
    /// Called from `stopRecording` after the timeline builder has the
    /// recording.stopped event recorded.
    func recordDiagnosticsSummaryEvent() {
        let summary = diagnostics.summaryLine()
        timeline.recordError(message: "diagnostics: \(summary)", t: logicalElapsedSeconds())
    }
}
