import Darwin
import Foundation

// MARK: - WatchdogTimer

//
// Hard wall-clock kill-switch. Fires on a pthread that is completely
// separate from the Swift concurrency runtime and the main dispatch
// queue, so it stays armed even if the main pipeline is wedged.
//
// When the deadline passes, it prints a short diagnostic line, calls
// a best-effort cleanup closure (with its own 2-second bound), then
// calls exit() to bring the process down. This will NOT rescue us from
// a kernel-level wedge (if the whole machine is deadlocked, no code
// runs), but it catches every "userspace stall with a stuck thread"
// case, which is the main failure shape the task-0C doc describes.

final class WatchdogTimer: @unchecked Sendable {
    /// Wall-clock seconds from arm() until fire.
    private let deadlineSeconds: Double

    /// Called on the watchdog thread right before exit(). Keep it
    /// cheap and non-blocking — there may be a real userspace wedge
    /// in progress and the cleanup should not get stuck on it.
    private let onFire: @Sendable () -> Void

    /// Cleared atomically by cancel() to mean "don't fire".
    private let cancelled = UnsafeMutablePointer<Int32>.allocate(capacity: 1)

    /// Set once, when the watchdog actually triggers exit().
    private let fired = UnsafeMutablePointer<Int32>.allocate(capacity: 1)

    init(deadlineSeconds: Double, onFire: @escaping @Sendable () -> Void) {
        self.deadlineSeconds = deadlineSeconds
        self.onFire = onFire
        cancelled.initialize(to: 0)
        fired.initialize(to: 0)
    }

    deinit {
        cancelled.deinitialize(count: 1)
        cancelled.deallocate()
        fired.deinitialize(count: 1)
        fired.deallocate()
    }

    // MARK: - Arm / cancel

    func arm() {
        // Capture everything we need as locals so the pthread body
        // doesn't need to touch self via Swift concurrency.
        let deadline = deadlineSeconds
        let cancelledPtr = cancelled
        let firedPtr = fired
        let onFire = onFire

        let thread = Thread {
            // Poll in 200ms chunks so cancel() is observed promptly
            // and we don't sit blocked for the whole deadline.
            let start = Date()
            while Date().timeIntervalSince(start) < deadline {
                if OSAtomicCompareAndSwap32(0, 0, cancelledPtr) == false {
                    return
                }
                Thread.sleep(forTimeInterval: 0.2)
            }
            // Final cancel check before firing.
            if OSAtomicCompareAndSwap32(0, 0, cancelledPtr) == false {
                return
            }

            // Mark fired (idempotent) then run cleanup and hard-exit.
            OSAtomicCompareAndSwap32(0, 1, firedPtr)

            let msg = "[watchdog] deadline reached after \(deadline)s — hard-exiting\n"
            FileHandle.standardError.write(msg.data(using: .utf8) ?? Data())

            // Run onFire on this thread, bounded by a detached timer
            // that exits if the cleanup itself hangs.
            let cleanupDeadline = Date().addingTimeInterval(2.0)
            let cleanupDone = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
            cleanupDone.initialize(to: 0)
            let cleanupThread = Thread {
                onFire()
                OSAtomicCompareAndSwap32(0, 1, cleanupDone)
            }
            cleanupThread.name = "watchdog-cleanup"
            cleanupThread.start()
            while Date() < cleanupDeadline {
                if OSAtomicCompareAndSwap32(1, 1, cleanupDone) { break }
                Thread.sleep(forTimeInterval: 0.05)
            }

            fflush(stdout)
            fflush(stderr)
            // 40 is the harness's "killed by watchdog" exit code.
            exit(40)
        }
        thread.qualityOfService = .userInteractive
        thread.name = "harness-watchdog"
        thread.start()
    }

    /// Request the watchdog stop. It will observe this flag at its next
    /// 200ms poll and return without firing.
    func cancel() {
        OSAtomicCompareAndSwap32(0, 1, cancelled)
    }

    var didFire: Bool {
        OSAtomicCompareAndSwap32(1, 1, fired)
    }
}
