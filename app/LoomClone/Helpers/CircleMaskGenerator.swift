import CoreGraphics
import CoreImage

/// Generates and caches circle masks for camera overlays.
/// Used exclusively from CompositionActor, so access is serialized.
enum CircleMaskGenerator {
    /// nonisolated(unsafe) is fine — only accessed from CompositionActor (a single actor)
    nonisolated(unsafe) private static var cache: [Int: CIImage] = [:]

    /// Cap on cached diameters. In practice diameter is preset-bound so the
    /// cache should hold ≤4 entries (one per PiP size), but a runaway caller
    /// could otherwise keep this growing indefinitely. Evicts the oldest
    /// inserted entry on overflow; preset rotation stays warm.
    private static let maxCachedDiameters = 16

    /// Insertion-ordered list of cached diameters, used for LRU-style eviction.
    nonisolated(unsafe) private static var insertionOrder: [Int] = []

    static func mask(diameter: Int) -> CIImage {
        if let cached = cache[diameter] {
            return cached
        }

        let size = diameter
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            fatalError("Failed to create CGContext for circle mask")
        }

        // Fill black (transparent in mask)
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))

        // Draw white circle (visible in mask)
        context.setFillColor(gray: 1, alpha: 1)
        context.fillEllipse(in: CGRect(x: 0, y: 0, width: size, height: size))

        guard let cgImage = context.makeImage() else {
            fatalError("Failed to create CGImage for circle mask")
        }

        let ciImage = CIImage(cgImage: cgImage)
        cache[diameter] = ciImage
        insertionOrder.append(diameter)
        if insertionOrder.count > maxCachedDiameters {
            let evict = insertionOrder.removeFirst()
            cache.removeValue(forKey: evict)
        }
        return ciImage
    }
}
