import CoreImage
import CoreVideo
import Metal

actor CompositionActor {

    // MARK: - Configuration

    private(set) var outputWidth: Int = OutputPreset.default.width
    private(set) var outputHeight: Int = OutputPreset.default.height

    var overlayDiameter: CGFloat = 240
    var overlayPadding: CGFloat = 20

    // MARK: - Core Image Pipeline

    private let ciContext: CIContext
    private var outputPool: PixelBufferPool
    private var outputBounds: CGRect

    // MARK: - Camera State

    private var latestCameraImage: CIImage?
    private var circleMask: CIImage

    init() {
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else {
            fatalError("Metal not available")
        }

        ciContext = CIContext(
            mtlCommandQueue: queue,
            options: [.cacheIntermediates: false]
        )

        outputPool = PixelBufferPool(
            width: outputWidth,
            height: outputHeight
        )

        outputBounds = CGRect(
            x: 0, y: 0,
            width: outputWidth,
            height: outputHeight
        )

        circleMask = CircleMaskGenerator.mask(diameter: 240)
    }

    /// Configure the output canvas for the current recording. Must be called
    /// before any compositeFrame() calls. The PiP overlay diameter scales with
    /// the output height so it looks proportionally the same across presets.
    func configure(preset: OutputPreset) {
        outputWidth = preset.width
        outputHeight = preset.height
        outputBounds = CGRect(x: 0, y: 0, width: preset.width, height: preset.height)
        outputPool = PixelBufferPool(width: preset.width, height: preset.height)

        // PiP diameter: 240 at 1080p → scale proportionally. Keeps the circle
        // visually the same size at any output preset.
        let ratio = CGFloat(preset.height) / 1080.0
        overlayDiameter = (240.0 * ratio).rounded()
        overlayPadding = (20.0 * ratio).rounded()
        circleMask = CircleMaskGenerator.mask(diameter: Int(overlayDiameter))

        print("[composition] Configured: \(preset.width)x\(preset.height), PiP=\(Int(overlayDiameter))px")
    }

    // MARK: - Camera Frame Update

    func updateCameraFrame(_ pixelBuffer: CVPixelBuffer) {
        latestCameraImage = CIImage(cvPixelBuffer: pixelBuffer)
    }

    // MARK: - Composition

    func compositeFrame(
        screenBuffer: CVPixelBuffer?,
        mode: RecordingMode
    ) -> CVPixelBuffer? {
        guard let output = outputPool.createBuffer() else {
            print("[composition] Failed to create output buffer")
            return nil
        }

        let composited: CIImage

        switch mode {
        case .cameraOnly:
            guard let camera = latestCameraImage else { return nil }
            composited = scaledToFill(camera)

        case .screenOnly:
            guard let screenBuffer else { return nil }
            let screen = CIImage(cvPixelBuffer: screenBuffer)
            composited = scaledToFill(screen)

        case .screenAndCamera:
            guard let screenBuffer else { return nil }
            let screen = CIImage(cvPixelBuffer: screenBuffer)
            let screenScaled = scaledToFill(screen)

            guard let camera = latestCameraImage else {
                composited = screenScaled
                break
            }

            let overlay = createCircularOverlay(camera)
            composited = overlay.composited(over: screenScaled)
        }

        let colorSpace = CGColorSpace(name: CGColorSpace.itur_709)!
        ciContext.render(composited, to: output, bounds: outputBounds, colorSpace: colorSpace)
        return output
    }

    // MARK: - Private Helpers

    /// Scale an image to fill the output, maintaining aspect ratio.
    /// Uses Lanczos for big downscales (e.g. native 4K screen → 1080p) —
    /// visibly sharper than affine scaling for text-heavy content.
    private func scaledToFill(_ image: CIImage) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return image }

        let scaleX = CGFloat(outputWidth) / extent.width
        let scaleY = CGFloat(outputHeight) / extent.height
        let scale = max(scaleX, scaleY)

        let scaled: CIImage
        if scale < 0.95 {
            // Downscale: use Lanczos for quality (sharper text).
            scaled = image.applyingFilter("CILanczosScaleTransform", parameters: [
                kCIInputScaleKey: scale,
                kCIInputAspectRatioKey: 1.0,
            ])
        } else {
            // Upscale or near-identity: cheap affine.
            scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        // Center crop to output size
        let scaledExtent = scaled.extent
        let cropX = (scaledExtent.width - CGFloat(outputWidth)) / 2
        let cropY = (scaledExtent.height - CGFloat(outputHeight)) / 2
        let cropRect = CGRect(
            x: scaledExtent.minX + cropX,
            y: scaledExtent.minY + cropY,
            width: CGFloat(outputWidth),
            height: CGFloat(outputHeight)
        )

        return scaled.cropped(to: cropRect)
            .transformed(by: CGAffineTransform(translationX: -cropRect.minX, y: -cropRect.minY))
    }

    /// Create a circular camera overlay positioned in the bottom-right corner.
    private func createCircularOverlay(_ camera: CIImage) -> CIImage {
        let diameter = overlayDiameter
        let padding = overlayPadding

        // Scale camera to fit the overlay diameter
        let cameraExtent = camera.extent
        guard cameraExtent.width > 0, cameraExtent.height > 0 else { return CIImage.empty() }

        let scale = diameter / min(cameraExtent.width, cameraExtent.height)
        var scaled = camera.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        // Center crop to square
        let scaledExtent = scaled.extent
        let cropX = (scaledExtent.width - diameter) / 2
        let cropY = (scaledExtent.height - diameter) / 2
        scaled = scaled.cropped(to: CGRect(
            x: scaledExtent.minX + cropX,
            y: scaledExtent.minY + cropY,
            width: diameter,
            height: diameter
        ))
        // Move origin to (0,0) for mask alignment
        scaled = scaled.transformed(by: CGAffineTransform(
            translationX: -scaled.extent.minX,
            y: -scaled.extent.minY
        ))

        // Regenerate mask if diameter changed
        if Int(diameter) != Int(circleMask.extent.width) {
            circleMask = CircleMaskGenerator.mask(diameter: Int(diameter))
        }

        // Apply circle mask
        let masked = scaled.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputMaskImageKey: circleMask,
            kCIInputBackgroundImageKey: CIImage.empty(),
        ])

        // Position in bottom-right corner (CIImage origin is bottom-left)
        let posX = CGFloat(outputWidth) - diameter - padding
        let posY = padding
        return masked.transformed(by: CGAffineTransform(translationX: posX, y: posY))
    }
}
