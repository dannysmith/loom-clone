@preconcurrency import AVFoundation
import Foundation

/// Subscribes to an `AVCaptureSession`'s failure notifications so a device
/// disconnect, resource conflict, or system interruption surfaces as a
/// callback instead of the session simply going quiet.
///
/// Both capture managers need exactly this, and both had a verbatim copy of
/// it. It lives here so a fix to one is a fix to both — the two paths feed the
/// same `SourceHealthTracker` on the other end.
enum CaptureSessionObservers {
    /// Install the observers and hand back the tokens. The caller owns them
    /// and must pass them to `remove(_:)` when it tears the session down.
    static func install(
        on session: AVCaptureSession,
        log: LoomLogger,
        onError: @escaping @Sendable (Error) -> Void,
        onInterrupted: @escaping @Sendable () -> Void
    ) -> [NSObjectProtocol] {
        let center = NotificationCenter.default
        let errorObserver = center.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: nil
        ) { notification in
            // AVFoundation doesn't always attach an error to the notification;
            // synthesise one so downstream handlers have something to record
            // on the timeline rather than dropping the failure.
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error
                ?? NSError(
                    domain: "AVCaptureSession",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Unknown runtime error"]
                )
            log.log("Session runtime error: \(error)")
            onError(error)
        }
        let interruptionObserver = center.addObserver(
            forName: AVCaptureSession.wasInterruptedNotification,
            object: session,
            queue: nil
        ) { notification in
            log.log("Session interrupted: \(notification.userInfo ?? [:])")
            onInterrupted()
        }
        return [errorObserver, interruptionObserver]
    }

    static func remove(_ observers: [NSObjectProtocol]) {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
