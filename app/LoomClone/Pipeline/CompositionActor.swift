import CoreImage
import CoreVideo
import Metal

/// Failure modes from the compositor's render path. `renderFailed` wraps any
/// error CoreImage reports through `CIRenderTask.waitUntilCompleted` —
/// typically `kIOGPUCommandBufferCallbackErrorTimeout` or the
/// `SubmissionsIgnored` cascade (see failure mode 3 in
/// `docs/m2-pro-video-pipeline-failures.md`). `stallTimeout` fires when the
/// wrapper below gives up on `waitUntilCompleted` returning at all — a weaker
/// signal than the GPU watchdog, but worth having in case the userspace
/// watchdog is itself blocked.
///
/// Both cases are handled the same way by the metronome: rebuild the context
/// and carry on. If rebuild itself fails, the metronome escalates to a clean
/// user-visible stop.
enum CompositionError: Error {
    case renderFailed(Error)
    case stallTimeout
}

actor CompositionActor {

    // MARK: - Configuration

    private(set) var outputWidth: Int = OutputPreset.default.width
    private(set) var outputHeight: Int = OutputPreset.default.height

    var overlayDiameter: CGFloat = 240
    var overlayPadding: CGFloat = 20

    // MARK: - Core Image Pipeline

    /// `var` rather than `let` so `rebuildContext()` can swap in a fresh
    /// context after a GPU error poisons the underlying Metal command queue.
    private var ciContext: CIContext
    private var outputPool: PixelBufferPool
    private var outputBounds: CGRect

    /// How long we wait for a single `CIRenderTask` to report completion
    /// before treating it as a stall. Generous versus a single frame's budget
    /// (33 ms) but well below the ~5 s GPU watchdog threshold that WindowServer
    /// enforces.
    private let renderStallTimeoutSeconds: Double = 2.0

    // MARK: - Camera State

    private var latestCameraImage: CIImage?
    private var circleMask: CIImage

    // MARK: - Camera Adjustments (task-5 Phase 2)
    //
    // Optional reference to the shared state box owned by RecordingCoordinator.
    // nil means "no adjustments" — identical behaviour to the pre-Phase-2
    // code. When set, `updateCameraFrame` wraps incoming camera frames in the
    // filter chain declared by the state box's current value. Because the
    // filter chain is built lazily as a CIImage graph, the per-frame cost is
    // paid only at render time inside `compositeFrame`.

    private var cameraAdjustmentsState: CameraAdjustmentsState?

    func setCameraAdjustmentsState(_ state: CameraAdjustmentsState?) {
        cameraAdjustmentsState = state
    }

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
        let base = CIImage(cvPixelBuffer: pixelBuffer)
        latestCameraImage = applyCameraAdjustments(to: base)
    }

    /// Task-5 Phase 2: add CITemperatureAndTint + CIExposureAdjust onto the
    /// camera-only path. Cheap when the state box is unset or the current
    /// values are defaults — returns the input image unchanged so CoreImage
    /// doesn't build a trivial passthrough graph every frame.
    ///
    /// The raw `camera.mp4` writer is untouched because it consumes the
    /// original CMSampleBuffer upstream of the compositor — see
    /// `RecordingActor.handleCameraFrame`.
    private func applyCameraAdjustments(to image: CIImage) -> CIImage {
        guard let state = cameraAdjustmentsState else { return image }
        let adj = state.value
        guard !adj.isDefault else { return image }

        // CITemperatureAndTint: inputNeutral declares what the filter should
        // treat as the image's current neutral (6500 K, the Rec. 709 white
        // point we're tagging camera buffers with in CameraCaptureManager);
        // inputTargetNeutral is the temperature we want the new neutral to
        // be. Slider value below 6500 warms the image, above cools it.
        let neutral = CIVector(x: CameraAdjustments.defaultTemperature, y: 0)
        let target = CIVector(x: adj.temperature, y: 0)
        var adjusted = image.applyingFilter("CITemperatureAndTint", parameters: [
            "inputNeutral": neutral,
            "inputTargetNeutral": target,
        ])
        adjusted = adjusted.applyingFilter("CIExposureAdjust", parameters: [
            kCIInputEVKey: adj.brightness,
        ])
        return adjusted
    }

    // MARK: - Composition

    /// Render one frame.
    ///
    /// Return values:
    /// - `nil` — the source frame or output pixel buffer isn't available this
    ///   tick. Transient condition; the metronome should just retry next tick.
    /// - `.success` — a rendered buffer ready to hand to the writer.
    /// - `.failure` — CoreImage reported an error (or the wait timed out).
    ///   The metronome should rebuild the context before the next tick.
    func compositeFrame(
        screenBuffer: CVPixelBuffer?,
        mode: RecordingMode
    ) async -> Result<CVPixelBuffer, CompositionError>? {
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

        // Render into Rec. 709. This relies on the camera pipeline tagging
        // every incoming pixel buffer with matching Rec. 709 colour metadata
        // (`CameraCaptureManager.captureOutput`, task-0A Phase 1). Without
        // those tags CIContext can't know the source colour space and falls
        // back to an expensive multi-stage conversion chain on every frame.
        let destination = CIRenderDestination(pixelBuffer: output)
        destination.colorSpace = CGColorSpace(name: CGColorSpace.itur_709)

        // Use the task-based render API so we can see errors and wrap the
        // wait in a timeout. The void-return `render(to:bounds:colorSpace:)`
        // we used previously had no feedback channel at all — a stuck
        // command buffer silently hung the metronome until the GPU watchdog
        // cleared it.
        let renderTask: CIRenderTask
        do {
            renderTask = try ciContext.startTask(toRender: composited, to: destination)
        } catch {
            return .failure(.renderFailed(error))
        }

        return await waitForRenderTask(renderTask, producing: output)
    }

    /// Race `waitUntilCompleted` on a detached task against a sleep. First to
    /// finish wins. Returns the pixel buffer on success. The underlying
    /// CIRenderTask is not cancellable — if we time out, the render may still
    /// land, but the metronome treats this as a stall and rebuilds the context
    /// so any in-flight work against the old command queue is orphaned cleanly.
    private func waitForRenderTask(
        _ task: CIRenderTask,
        producing output: CVPixelBuffer
    ) async -> Result<CVPixelBuffer, CompositionError> {
        // CIRenderTask is an Objective-C class and isn't Sendable, but its
        // `waitUntilCompleted` is thread-safe. Wrap it for the detached task.
        struct UnsafeRenderTask: @unchecked Sendable {
            let task: CIRenderTask
        }
        let wrapped = UnsafeRenderTask(task: task)
        let timeout = renderStallTimeoutSeconds

        enum Outcome: Sendable {
            case completed
            case failed(Error)
            case timedOut
        }

        return await withTaskGroup(of: Outcome.self) { group in
            group.addTask {
                do {
                    _ = try await Task.detached(priority: .userInitiated) {
                        try wrapped.task.waitUntilCompleted()
                    }.value
                    return .completed
                } catch {
                    return .failed(error)
                }
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(timeout))
                return .timedOut
            }

            let first = await group.next() ?? .timedOut
            group.cancelAll()

            switch first {
            case .completed:
                return .success(output)
            case .failed(let err):
                return .failure(.renderFailed(err))
            case .timedOut:
                return .failure(.stallTimeout)
            }
        }
    }

    // MARK: - Rebuild

    /// Tear down the current `CIContext` + `MTLCommandQueue` and rebuild them.
    /// Called by `RecordingActor` when `compositeFrame` reports a render
    /// failure or stall — a fresh command queue shakes off the "poisoned"
    /// state that `kIOGPUCommandBufferCallbackErrorSubmissionsIgnored`
    /// leaves behind on the old one.
    ///
    /// Returns `false` if Metal itself is unavailable — at that point the
    /// metronome escalates to a clean terminal stop.
    func rebuildContext() -> Bool {
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else {
            print("[composition] Rebuild failed: MTLCreateSystemDefaultDevice / makeCommandQueue returned nil")
            return false
        }

        ciContext = CIContext(
            mtlCommandQueue: queue,
            options: [.cacheIntermediates: false]
        )
        print("[composition] Rebuilt CIContext and MTLCommandQueue")
        return true
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
