@preconcurrency import AVFoundation
import Foundation

/// Lightweight AVCaptureSession used to drive the popover's live microphone
/// level meter. Separate from `MicrophoneCaptureManager` (which owns the
/// recording path) so the preview can start/stop independently of recording.
///
/// Levels come from `AVCaptureConnection.audioChannels[].averagePowerLevel`
/// (dBFS), which AVFoundation computes for free — no manual DSP on sample
/// buffers. A 20 Hz timer polls the connection on the capture queue and hops
/// to the main actor to publish a normalised 0…1 value for SwiftUI.
@MainActor
@Observable
final class MicrophonePreviewManager {

    /// Observable presence flag — true when the preview session is live.
    private(set) var isActive: Bool = false

    /// Smoothed input level in 0…1 (1 ≈ 0 dBFS, 0 ≈ -60 dBFS or quieter).
    /// SwiftUI meter binds to this.
    private(set) var level: Float = 0

    private var session: AVCaptureSession?
    private var output: AVCaptureAudioDataOutput?
    private var currentDeviceID: String?
    private var pollTimer: Timer?

    /// Floor (dBFS) used when normalising averagePowerLevel into 0…1.
    /// -50 matches roughly the noise floor of a typical quiet room — below
    /// this, the meter should read as silent.
    private static let silenceFloorDB: Float = -50

    /// Poll interval for reading averagePowerLevel.
    private static let pollInterval: TimeInterval = 0.05  // 20 Hz

    /// Envelope smoothing — fast attack so peaks register, slower release so
    /// the bar doesn't jitter back to zero on every quiet frame.
    private static let attack: Float = 0.6
    private static let release: Float = 0.2

    func start(device: AVCaptureDevice) async {
        if device.uniqueID == currentDeviceID, session?.isRunning == true { return }
        await stop()

        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            print("[mic-preview] Permission denied")
            return
        }

        let session = AVCaptureSession()
        session.beginConfiguration()

        do {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) {
                session.addInput(input)
            }
        } catch {
            print("[mic-preview] Failed to create input: \(error)")
            return
        }

        let output = AVCaptureAudioDataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
        self.session = session
        self.output = output
        self.currentDeviceID = device.uniqueID

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        self.isActive = true
        startPolling()
        print("[mic-preview] Started: \(device.localizedName)")
    }

    func stop() async {
        pollTimer?.invalidate()
        pollTimer = nil

        guard let session else {
            resetState()
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
                continuation.resume()
            }
        }
        resetState()
        print("[mic-preview] Stopped")
    }

    private func resetState() {
        session = nil
        output = nil
        currentDeviceID = nil
        isActive = false
        level = 0
    }

    private func startPolling() {
        pollTimer?.invalidate()
        let timer = Timer(timeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleLevel() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private func sampleLevel() {
        guard let output, let connection = output.connections.first else { return }
        // Peak across channels, so a mono-driven stereo input still reads.
        var peakDB: Float = -.infinity
        for channel in connection.audioChannels {
            peakDB = max(peakDB, channel.averagePowerLevel)
        }
        let normalised = Self.normalise(db: peakDB)
        // Fast attack, slow release — keeps the meter lively but not jittery.
        let coeff: Float = normalised > level ? Self.attack : Self.release
        level = level + (normalised - level) * coeff
    }

    private static func normalise(db: Float) -> Float {
        guard db.isFinite else { return 0 }
        if db <= silenceFloorDB { return 0 }
        if db >= 0 { return 1 }
        // Linear dB → 0…1, then squared so quiet signals stay low and the
        // meter only approaches full on genuinely loud input. Without the
        // curve, a -10 dBFS signal (easy to hit by nudging a sensitive mic)
        // sat at ~80% full, which felt overblown.
        let linear = (db - silenceFloorDB) / -silenceFloorDB
        return linear * linear
    }
}
