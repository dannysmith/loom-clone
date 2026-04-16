import Foundation
import Network

/// Thin wrapper around `NWPathMonitor` exposing a sync `isOnline` getter.
///
/// Used by `UploadActor` to gate retry attempts: if the network path is
/// `.unsatisfied`, we poll (cheap) rather than burning exponential-backoff
/// retries on a destination we can't reach. When the path recovers, the
/// next poll resumes and uploads drain immediately.
///
/// **Caveat on localhost.** `NWPathMonitor` reflects physical network
/// reachability, not server reachability. With the server on `localhost`
/// and Wi-Fi off, this reports `.unsatisfied` even though loopback works.
/// Accepted rough edge for dev — the gate behaves correctly once the
/// server moves to a remote host.
final class ReachabilityMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ReachabilityMonitor")
    private let lock = NSLock()
    private var _isOnline: Bool = true

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.handleUpdate(path)
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }

    var isOnline: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isOnline
    }

    private func handleUpdate(_ path: NWPath) {
        lock.lock()
        let wasOnline = _isOnline
        _isOnline = (path.status == .satisfied)
        let nowOnline = _isOnline
        lock.unlock()

        if wasOnline != nowOnline {
            print("[reachability] \(nowOnline ? "online" : "offline")")
        }
    }
}
