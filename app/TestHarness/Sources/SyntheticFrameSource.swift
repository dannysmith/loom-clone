import CoreMedia
import CoreVideo
import Foundation

// MARK: - SyntheticFrameSource
//
// Produces CVPixelBuffer + CMSampleBuffer frames without touching any
// capture API. This is the default frame source for the harness
// because it removes ScreenCaptureKit / AVCaptureSession as a
// confounding variable — if a test fails with synthetic frames we know
// the capture layer is not involved.
//
// Design intent:
// - Pure CPU writes into a CVPixelBuffer from a pool. No CIContext.
// - Cheap pattern generation that changes per frame so the encoder
//   has non-static content to work on (static content compresses to
//   almost nothing and doesn't stress the encoder realistically).
// - Colour-space attachment tags that match real capture (sRGB for
//   screen, Rec. 709 for camera) so the downstream writer sees the
//   same input shape it would in the real pipeline.
//
// Not implemented here: the metronome. HarnessRunner drives the
// fetch-frame cadence. The source just vends a frame when asked.

final class SyntheticFrameSource: @unchecked Sendable {

    // MARK: - Configuration

    enum Kind: Sendable {
        case screenBGRA      // 32BGRA, full range
        case camera420v      // 420YpCbCr8BiPlanarVideoRange (video range)
        case audioSilentPCM  // stereo f32 silence
    }

    enum Pattern: Sendable {
        case solid
        case gradient
        case moving
        case noise
    }

    enum ColorSpaceTag: Sendable {
        case srgb
        case p3
        case rec709
    }

    let kind: Kind
    let width: Int
    let height: Int
    let pattern: Pattern
    let colorSpace: ColorSpaceTag

    // MARK: - Internal state

    private var pool: CVPixelBufferPool?
    private var frameIndex: Int64 = 0

    init(kind: Kind,
         width: Int,
         height: Int,
         pattern: Pattern = .moving,
         colorSpace: ColorSpaceTag = .srgb) {
        self.kind = kind
        self.width = width
        self.height = height
        self.pattern = pattern
        self.colorSpace = colorSpace
        self.pool = Self.makePool(kind: kind, width: width, height: height)
    }

    // MARK: - Pool construction

    private static func makePool(kind: Kind, width: Int, height: Int) -> CVPixelBufferPool? {
        let pixelFormat: OSType
        switch kind {
        case .screenBGRA:
            pixelFormat = kCVPixelFormatType_32BGRA
        case .camera420v:
            pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        case .audioSilentPCM:
            return nil
        }
        let poolAttrs: [String: Any] = [
            kCVPixelBufferPoolMinimumBufferCountKey as String: 4
        ]
        let bufferAttrs: [String: Any] = [
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
            kCVPixelBufferMetalCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]
        var out: CVPixelBufferPool?
        CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            poolAttrs as CFDictionary,
            bufferAttrs as CFDictionary,
            &out
        )
        return out
    }

    // MARK: - Public API

    /// Vend a pixel buffer for frame `index` with content appropriate
    /// for the configured pattern. Returns nil if the pool is
    /// exhausted or the kind is audio-only.
    func makePixelBuffer(index: Int64) -> CVPixelBuffer? {
        guard let pool = pool else { return nil }
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(
            kCFAllocatorDefault, pool, &buffer
        )
        guard status == kCVReturnSuccess, let px = buffer else { return nil }

        applyPattern(to: px, frameIndex: index)
        attachColorMetadata(to: px)
        return px
    }

    /// Build a CMSampleBuffer around the pixel buffer at the requested
    /// presentation time. The PTS is computed from `index / frameRate`
    /// so every call with the same index produces the same timestamp.
    func makeSampleBuffer(pixelBuffer: CVPixelBuffer,
                          index: Int64,
                          frameRate: Int) -> CMSampleBuffer? {
        let scale = CMTimeScale(frameRate * 100)
        let duration = CMTime(value: 100, timescale: scale)
        let pts = CMTime(value: index * 100, timescale: scale)

        var formatDescription: CMFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard let fmt = formatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: fmt,
            sampleTiming: &timing,
            sampleBufferOut: &sample
        )
        return sample
    }

    // MARK: - Pattern application

    private func applyPattern(to buffer: CVPixelBuffer, frameIndex: Int64) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        switch kind {
        case .screenBGRA:
            fillBGRA(buffer: buffer, frameIndex: frameIndex)
        case .camera420v:
            fillYCbCr420(buffer: buffer, frameIndex: frameIndex)
        case .audioSilentPCM:
            break
        }
    }

    /// Fills the BGRA buffer in-place. We write rows directly so we
    /// don't depend on GPU work — this is a pure CPU path.
    private func fillBGRA(buffer: CVPixelBuffer, frameIndex: Int64) {
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }

        // Pick per-frame base colour so the encoder sees motion.
        let phase = Int(frameIndex % 256)

        switch pattern {
        case .solid:
            memsetBGRA(base: base, stride: stride, h: h,
                       b: UInt8(phase), g: UInt8((phase * 2) % 256), r: UInt8((phase * 3) % 256))

        case .gradient:
            for y in 0..<h {
                let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
                let shade = UInt8((y * 255 / max(h - 1, 1)) % 256)
                var x = 0
                while x < w {
                    row[x * 4 + 0] = shade          // B
                    row[x * 4 + 1] = shade          // G
                    row[x * 4 + 2] = UInt8(phase)   // R
                    row[x * 4 + 3] = 0xFF           // A
                    x += 1
                }
            }

        case .moving:
            // Diagonal stripe that shifts every frame. Creates both
            // high-frequency detail (edges) and motion, which is what
            // the H.264 encoder actually has to work on.
            let offset = Int(frameIndex * 8)
            for y in 0..<h {
                let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
                var x = 0
                while x < w {
                    let bucket = ((x + y + offset) / 32) % 2
                    let c: UInt8 = bucket == 0 ? 0x22 : 0xDD
                    row[x * 4 + 0] = c
                    row[x * 4 + 1] = c
                    row[x * 4 + 2] = UInt8(phase)
                    row[x * 4 + 3] = 0xFF
                    x += 1
                }
            }

        case .noise:
            // Cheap LCG so we don't have to call arc4random per pixel.
            var state = UInt32(truncatingIfNeeded: frameIndex &* 2654435761)
            for y in 0..<h {
                let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
                var x = 0
                while x < w {
                    state = state &* 1664525 &+ 1013904223
                    row[x * 4 + 0] = UInt8(truncatingIfNeeded: state >> 24)
                    row[x * 4 + 1] = UInt8(truncatingIfNeeded: state >> 16)
                    row[x * 4 + 2] = UInt8(truncatingIfNeeded: state >> 8)
                    row[x * 4 + 3] = 0xFF
                    x += 1
                }
            }
        }
    }

    private func memsetBGRA(base: UnsafeMutableRawPointer, stride: Int, h: Int,
                            b: UInt8, g: UInt8, r: UInt8) {
        for y in 0..<h {
            let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
            var x = 0
            let pixelsPerRow = stride / 4
            while x < pixelsPerRow {
                row[x * 4 + 0] = b
                row[x * 4 + 1] = g
                row[x * 4 + 2] = r
                row[x * 4 + 3] = 0xFF
                x += 1
            }
        }
    }

    /// Two-plane YCbCr 420v. Plane 0 is Y (one byte per luma pixel),
    /// plane 1 is interleaved CbCr at half resolution in both axes.
    /// Video range means Y is in [16, 235], CbCr in [16, 240].
    private func fillYCbCr420(buffer: CVPixelBuffer, frameIndex: Int64) {
        let h = CVPixelBufferGetHeight(buffer)

        // Luma plane
        if let yBase = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
            let yStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
            let phase = Int(frameIndex % 220)
            for row in 0..<h {
                let line = yBase.advanced(by: row * yStride).assumingMemoryBound(to: UInt8.self)
                let y: UInt8 = UInt8(16 + ((row + phase) % 220))
                memset(line, Int32(y), yStride)
            }
        }

        // Chroma plane (half height)
        let chromaH = CVPixelBufferGetHeightOfPlane(buffer, 1)
        if let cBase = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
            let cStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
            for row in 0..<chromaH {
                let line = cBase.advanced(by: row * cStride).assumingMemoryBound(to: UInt8.self)
                // 128 / 128 = neutral chroma. Adjust slightly per frame
                // so the encoder sees non-static content.
                let cb = UInt8(truncatingIfNeeded: 128 + Int(frameIndex % 16) - 8)
                let cr = UInt8(truncatingIfNeeded: 128 - Int(frameIndex % 16) + 8)
                var x = 0
                while x < cStride {
                    line[x] = cb
                    if x + 1 < cStride { line[x + 1] = cr }
                    x += 2
                }
            }
        }
    }

    // MARK: - Colour metadata

    private func attachColorMetadata(to buffer: CVPixelBuffer) {
        // Matches how CameraCaptureManager tags camera buffers in the
        // main app, and how ScreenCaptureKit hands out screen buffers.
        // AVAssetWriter reads these attachments when no explicit output
        // colour properties are set on the writer input.
        let (primaries, transfer, matrix): (CFString, CFString, CFString)
        switch colorSpace {
        case .srgb:
            primaries = kCVImageBufferColorPrimaries_ITU_R_709_2
            transfer = kCVImageBufferTransferFunction_sRGB
            matrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        case .p3:
            primaries = kCVImageBufferColorPrimaries_P3_D65
            transfer = kCVImageBufferTransferFunction_sRGB
            matrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        case .rec709:
            primaries = kCVImageBufferColorPrimaries_ITU_R_709_2
            transfer = kCVImageBufferTransferFunction_ITU_R_709_2
            matrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        }
        CVBufferSetAttachment(buffer,
                              kCVImageBufferColorPrimariesKey,
                              primaries,
                              .shouldPropagate)
        CVBufferSetAttachment(buffer,
                              kCVImageBufferTransferFunctionKey,
                              transfer,
                              .shouldPropagate)
        CVBufferSetAttachment(buffer,
                              kCVImageBufferYCbCrMatrixKey,
                              matrix,
                              .shouldPropagate)
    }

    // MARK: - Audio helper
    //
    // For the audio-only synthetic source we produce short CMSampleBuffers
    // of silent float32 stereo PCM at 48 kHz, matching what the main app's
    // microphone writer would see. Called by HarnessRunner in an audio loop.

    static func makeSilentAudioSampleBuffer(
        index: Int64,
        samplesPerBuffer: Int = 1024,
        sampleRate: Double = 48_000.0,
        channels: Int = 2
    ) -> CMSampleBuffer? {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(4 * channels),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(4 * channels),
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 32,
            mReserved: 0
        )

        var formatDescription: CMFormatDescription?
        CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: &asbd,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &formatDescription
        )
        guard let fmt = formatDescription else { return nil }

        let byteCount = samplesPerBuffer * 4 * channels
        let data = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 16)
        memset(data, 0, byteCount)

        var blockBuffer: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: data,
            blockLength: byteCount,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: byteCount,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard let block = blockBuffer else {
            data.deallocate()
            return nil
        }

        let pts = CMTime(value: index * Int64(samplesPerBuffer),
                         timescale: CMTimeScale(sampleRate))

        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateWithPacketDescriptions(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: fmt,
            sampleCount: samplesPerBuffer,
            presentationTimeStamp: pts,
            packetDescriptions: nil,
            sampleBufferOut: &sample
        )
        return sample
    }
}
