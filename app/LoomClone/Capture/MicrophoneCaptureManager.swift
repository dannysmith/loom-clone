@preconcurrency import AVFoundation
import CoreMedia
import Foundation

final class MicrophoneCaptureManager: NSObject, @unchecked Sendable {
    var onAudioSample: (@Sendable (CMSampleBuffer) -> Void)?
    var onSessionError: (@Sendable (Error) -> Void)?
    var onSessionInterrupted: (@Sendable () -> Void)?

    private var session: AVCaptureSession?
    private let captureQueue = DispatchQueue(label: "com.loomclone.mic-capture", qos: .userInteractive)
    private var sessionObservers: [NSObjectProtocol] = []

    static func availableDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        ).devices
    }

    func startCapture(device: AVCaptureDevice) async {
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            Log.mic.log("Permission denied")
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
            Log.mic.log("Failed to create input: \(error)")
            return
        }

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: captureQueue)

        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
        self.session = session

        let errorObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error
                ?? NSError(domain: "AVCaptureSession", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown runtime error"])
            Log.mic.log("Session runtime error: \(error)")
            self.onSessionError?(error)
        }
        let interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.wasInterruptedNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            Log.mic.log("Session interrupted: \(notification.userInfo ?? [:])")
            self.onSessionInterrupted?()
        }
        sessionObservers = [errorObserver, interruptionObserver]

        // startRunning() blocks until the session is actually running. Wait for
        // it to complete before returning so callers don't race against the
        // hardware coming up.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                continuation.resume()
            }
        }
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(device.activeFormat.formatDescription)
        if let asbd {
            Log.mic.log(
                "Capture started: \(device.localizedName) — \(Int(asbd.pointee.mChannelsPerFrame))ch, \(Int(asbd.pointee.mSampleRate)) Hz"
            )
        } else {
            Log.mic.log("Capture started: \(device.localizedName)")
        }
    }

    func stopCapture() async {
        for observer in sessionObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        sessionObservers.removeAll()
        guard let session else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
                continuation.resume()
            }
        }
        self.session = nil
        Log.mic.log("Capture stopped")
    }
}

extension MicrophoneCaptureManager: AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from _: AVCaptureConnection
    ) {
        onAudioSample?(sampleBuffer)
    }
}
