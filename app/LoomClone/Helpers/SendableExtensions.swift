import ScreenCaptureKit
import AVFoundation

// These framework types are reference types that are safe to send across actors,
// but Apple hasn't added Sendable conformance yet. This is a common pattern.
extension SCDisplay: @retroactive @unchecked Sendable {}
extension AVCaptureDevice: @retroactive @unchecked Sendable {}
