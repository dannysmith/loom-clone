import CoreVideo

final class PixelBufferPool: @unchecked Sendable {
    let pool: CVPixelBufferPool

    init(width: Int, height: Int, pixelFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
        let poolAttrs: [String: Any] = [
            kCVPixelBufferPoolMinimumBufferCountKey as String: 3
        ]
        let bufferAttrs: [String: Any] = [
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
            kCVPixelBufferMetalCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]

        var poolOut: CVPixelBufferPool?
        let status = CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            poolAttrs as CFDictionary,
            bufferAttrs as CFDictionary,
            &poolOut
        )

        guard status == kCVReturnSuccess, let pool = poolOut else {
            fatalError("Failed to create pixel buffer pool: \(status)")
        }
        self.pool = pool
    }

    func createBuffer() -> CVPixelBuffer? {
        var bufferOut: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(
            kCFAllocatorDefault,
            pool,
            &bufferOut
        )
        guard status == kCVReturnSuccess else { return nil }
        return bufferOut
    }
}
