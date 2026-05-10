import CoreMedia

/// Holds the AAC priming offset shared between RecordingActor (video PTS
/// computation, metronome) and WriterActor (initial segment start time
/// + session start). All other timing — pause accumulation, audio
/// retiming — lives in RecordingActor so there's a single source of
/// truth for logical recording time.
enum TimestampAdjuster {
    /// Canonical offset applied to every PTS emitted into the HLS writer
    /// to handle AAC audio priming. Without it, the first ~50ms of audio
    /// (decoder priming samples) would land at negative PTS and get dropped
    /// by AVAssetWriter, leaving a gap at t=0. Anchoring at +10s gives the
    /// priming samples a positive landing pad and shifts all real audio
    /// to PTS≥10s.
    static let defaultPrimingOffset = CMTime(seconds: 10, preferredTimescale: 600)
}
