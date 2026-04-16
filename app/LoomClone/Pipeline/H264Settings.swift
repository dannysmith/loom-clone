import AVFoundation
import VideoToolbox

enum H264Settings {
    /// Encoder specification requiring hardware-accelerated H.264.
    ///
    /// VTCompressionProperties.h documents the failure modes explicitly,
    /// including "the hardware encoding resources on the machine are busy."
    /// Setting this means silent software fallback fails loudly at
    /// startWriting() instead of dragging the GPU into a deadlock.
    static let encoderSpecification: [String: Any] = [
        kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: kCFBooleanTrue as Any,
    ]

    /// Shared H.264 compression properties. Both the HLS writer and the raw
    /// camera writer use these — only bitrate differs between them.
    static func compressionProperties(bitrate: Int) -> [String: Any] {
        [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: 30,
            AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
            // OBS/FFmpeg/HandBrake all ship RealTime=false on Apple Silicon
            // after OBS issue #5840 documented framedrops and unreliability
            // with it set to true on M1/M2.
            kVTCompressionPropertyKey_RealTime as String: kCFBooleanFalse as Any,
            // Disable B-frames. HLS low-latency does not require frame
            // reordering, and the reorder buffer is a per-slot IOSurface
            // reference chain inside the encoder.
            AVVideoAllowFrameReorderingKey: false,
        ]
    }

    /// Rec. 709 colour properties. Used by the HLS writer (whose input is
    /// the compositor's Rec. 709–tagged output). NOT used by the raw camera
    /// writer — omitting the key lets AVFoundation infer colour space from
    /// pixel buffer attachments, which avoids a forced GPU-side colour
    /// conversion that can wedge the GPU on contended pipelines.
    static let rec709ColorProperties: [String: Any] = [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ]
}
