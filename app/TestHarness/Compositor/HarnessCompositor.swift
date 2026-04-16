import CoreImage
import CoreVideo
import Foundation
import Metal

// MARK: - HarnessCompositor

//
// Minimal analogue of the main-app CompositionActor. CIContext-based,
// renders a composited frame into a CVPixelBuffer that feeds the
// composited HLS writer.
//
// Scope in the harness:
// - Screen-only and screen-plus-camera (PiP circle) modes.
// - Lanczos toggle for the downscale path.
// - render-to-bounds vs startTask-toRender toggle (task-0A Phase 3
//   proposed path).
// - No pause / resume / mode-switch machinery — the harness runs one
//   composited configuration for the duration and stops.
//
// This class is not thread-safe; HarnessRunner drives it serially
// from the metronome.

final class HarnessCompositor {
    private let ciContext: CIContext
    private let outputWidth: Int
    private let outputHeight: Int
    private let useLanczos: Bool
    private let renderMode: String
    private let outputBounds: CGRect
    private let outputPool: CVPixelBufferPool
    private let events: EventLog

    private var latestCameraImage: CIImage?
    private var circleMask: CIImage?
    private let overlayDiameter: CGFloat
    private let overlayPadding: CGFloat

    init(
        outputWidth: Int,
        outputHeight: Int,
        useLanczos: Bool,
        renderMode: String,
        events: EventLog
    ) throws {
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue()
        else {
            throw HarnessCompositorError.metalUnavailable
        }

        self.ciContext = CIContext(
            mtlCommandQueue: queue,
            options: [.cacheIntermediates: false]
        )

        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.useLanczos = useLanczos
        self.renderMode = renderMode
        self.outputBounds = CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight)
        self.events = events

        // Scale PiP diameter with output height (240 @ 1080p).
        let ratio = CGFloat(outputHeight) / 1080.0
        self.overlayDiameter = (240.0 * ratio).rounded()
        self.overlayPadding = (20.0 * ratio).rounded()

        let bufferAttrs: [String: Any] = [
            kCVPixelBufferWidthKey as String: outputWidth,
            kCVPixelBufferHeightKey as String: outputHeight,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferMetalCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]
        let poolAttrs: [String: Any] = [
            kCVPixelBufferPoolMinimumBufferCountKey as String: 4,
        ]
        var pool: CVPixelBufferPool?
        let status = CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            poolAttrs as CFDictionary,
            bufferAttrs as CFDictionary,
            &pool
        )
        guard status == kCVReturnSuccess, let pool else {
            throw HarnessCompositorError.poolCreateFailed
        }
        self.outputPool = pool
    }

    // MARK: - Camera input

    func updateCameraFrame(_ buffer: CVPixelBuffer) {
        latestCameraImage = CIImage(cvPixelBuffer: buffer)
    }

    // MARK: - Composite

    func compositeFrame(screen: CVPixelBuffer?, includeCameraOverlay: Bool) -> CVPixelBuffer? {
        var output: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(
            kCFAllocatorDefault, outputPool, &output
        )
        guard status == kCVReturnSuccess, let outputBuffer = output else {
            events.log("compositor.pool-exhausted")
            return nil
        }

        let composited: CIImage
        if let screen {
            let screenImage = CIImage(cvPixelBuffer: screen)
            let scaled = scaledToFill(screenImage)
            if includeCameraOverlay, let camera = latestCameraImage {
                let overlay = createCircularOverlay(camera)
                composited = overlay.composited(over: scaled)
            } else {
                composited = scaled
            }
        } else if let camera = latestCameraImage {
            composited = scaledToFill(camera)
        } else {
            return nil
        }

        let colorSpace = CGColorSpace(name: CGColorSpace.itur_709)!

        if renderMode == "start-task" {
            // Task-0A Phase 3 proposed path: startTask(toRender:to:).
            // This gives us more control over cancellation and async
            // completion but is less battle-tested in our pipeline.
            do {
                let dest = CIRenderDestination(pixelBuffer: outputBuffer)
                dest.colorSpace = colorSpace
                let task = try ciContext.startTask(toRender: composited, to: dest)
                try task.waitUntilCompleted()
            } catch {
                events.log("compositor.render-error", [
                    "mode": "start-task",
                    "error": error.localizedDescription,
                ])
                return nil
            }
        } else {
            // Current main-app path: render(to:bounds:colorSpace:).
            ciContext.render(
                composited,
                to: outputBuffer,
                bounds: outputBounds,
                colorSpace: colorSpace
            )
        }

        return outputBuffer
    }

    // MARK: - Private helpers

    private func scaledToFill(_ image: CIImage) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return image }

        let scaleX = CGFloat(outputWidth) / extent.width
        let scaleY = CGFloat(outputHeight) / extent.height
        let scale = max(scaleX, scaleY)

        let scaled: CIImage = if useLanczos, scale < 0.95 {
            image.applyingFilter("CILanczosScaleTransform", parameters: [
                kCIInputScaleKey: scale,
                kCIInputAspectRatioKey: 1.0,
            ])
        } else {
            image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        let se = scaled.extent
        let cropX = (se.width - CGFloat(outputWidth)) / 2
        let cropY = (se.height - CGFloat(outputHeight)) / 2
        let cropRect = CGRect(
            x: se.minX + cropX,
            y: se.minY + cropY,
            width: CGFloat(outputWidth),
            height: CGFloat(outputHeight)
        )
        return scaled.cropped(to: cropRect)
            .transformed(by: CGAffineTransform(translationX: -cropRect.minX, y: -cropRect.minY))
    }

    private func createCircularOverlay(_ camera: CIImage) -> CIImage {
        let diameter = overlayDiameter
        let padding = overlayPadding

        let cameraExtent = camera.extent
        guard cameraExtent.width > 0, cameraExtent.height > 0 else { return CIImage.empty() }

        let scale = diameter / min(cameraExtent.width, cameraExtent.height)
        var scaled = camera.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        let scaledExtent = scaled.extent
        let cropX = (scaledExtent.width - diameter) / 2
        let cropY = (scaledExtent.height - diameter) / 2
        scaled = scaled.cropped(to: CGRect(
            x: scaledExtent.minX + cropX,
            y: scaledExtent.minY + cropY,
            width: diameter,
            height: diameter
        ))
        scaled = scaled.transformed(by: CGAffineTransform(
            translationX: -scaled.extent.minX,
            y: -scaled.extent.minY
        ))

        if circleMask == nil || Int(circleMask!.extent.width) != Int(diameter) {
            circleMask = Self.makeCircleMask(diameter: Int(diameter))
        }

        let masked = scaled.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputMaskImageKey: circleMask!,
            kCIInputBackgroundImageKey: CIImage.empty(),
        ])

        let posX = CGFloat(outputWidth) - diameter - padding
        let posY = padding
        return masked.transformed(by: CGAffineTransform(translationX: posX, y: posY))
    }

    private static func makeCircleMask(diameter: Int) -> CIImage {
        let size = diameter
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let context = CGContext(
            data: nil,
            width: size, height: size,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return CIImage.empty()
        }
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        context.setFillColor(gray: 1, alpha: 1)
        context.fillEllipse(in: CGRect(x: 0, y: 0, width: size, height: size))
        guard let cg = context.makeImage() else { return CIImage.empty() }
        return CIImage(cgImage: cg)
    }
}

enum HarnessCompositorError: Error {
    case metalUnavailable
    case poolCreateFailed
}
