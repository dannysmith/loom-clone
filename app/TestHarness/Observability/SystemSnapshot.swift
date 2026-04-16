import Foundation

// MARK: - SystemSnapshot

//
// Captures a before / after picture of kernel-visible state around a
// test run. Uses subprocess shell-outs to standard macOS tools. The
// snapshots go into the run directory as plain text files so they can
// be diffed manually.
//
// The tools we call — `vm_stat`, `sysctl`, `ioreg`, `powermetrics`, `ps`
// — are all macOS built-ins and don't require special privileges for
// the fields we care about, EXCEPT powermetrics which requires root.
// We call it without sudo and capture whatever comes out (including the
// "permission denied" error) so the snapshot still records the attempt.
//
// All shell-outs are bounded by a short timeout so a stuck tool can't
// block the harness.

enum SystemSnapshot {
    /// Run all snapshot commands and write results to
    /// `<run-dir>/system-snapshot-<label>.txt`.
    static func capture(runDirectory: URL, label: String) {
        let outURL = runDirectory.appendingPathComponent("system-snapshot-\(label).txt")
        var buffer = "# SystemSnapshot (\(label)) — \(ISO8601DateFormatter().string(from: Date()))\n\n"

        buffer += section("uname -a", run: ["/usr/bin/uname", "-a"])
        buffer += section("sw_vers", run: ["/usr/bin/sw_vers"])
        buffer += section(
            "sysctl hw.model hw.cpufrequency hw.memsize hw.physicalcpu hw.logicalcpu",
            run: [
                "/usr/sbin/sysctl",
                "hw.model",
                "hw.cpufrequency",
                "hw.memsize",
                "hw.physicalcpu",
                "hw.logicalcpu",
            ]
        )
        buffer += section("vm_stat", run: ["/usr/bin/vm_stat"])
        buffer += section(
            "ps -o pid,rss,vsz,%cpu,%mem,command (harness process)",
            run: [
                "/bin/ps",
                "-o",
                "pid,rss,vsz,%cpu,%mem,command",
                "-p",
                String(ProcessInfo.processInfo.processIdentifier),
            ]
        )
        buffer += section(
            "ps -M (harness threads)",
            run: [
                "/bin/ps",
                "-M",
                "-p",
                String(ProcessInfo.processInfo.processIdentifier),
            ]
        )
        buffer += section(
            "ioreg -c IOSurfaceRoot -l (truncated)",
            run: ["/usr/sbin/ioreg", "-c", "IOSurfaceRoot", "-l"],
            maxBytes: 64 * 1024
        )
        // powermetrics needs root; if it fails the stderr capture still
        // tells us what happened. We skip the --samplers gpu_power flag
        // if powermetrics is unavailable at all.
        buffer += section(
            "powermetrics --samplers gpu_power -n 1 -i 100 (may require sudo)",
            run: [
                "/usr/bin/powermetrics",
                "--samplers",
                "gpu_power",
                "-n",
                "1",
                "-i",
                "100",
            ],
            maxBytes: 8 * 1024,
            timeout: 3.0
        )

        try? buffer.write(to: outURL, atomically: true, encoding: .utf8)
    }

    // MARK: - Section runner

    private static func section(
        _ title: String,
        run argv: [String],
        maxBytes: Int = 32 * 1024,
        timeout: TimeInterval = 2.0
    ) -> String {
        var body = "## \(title)\n"
        let result = spawn(argv, timeout: timeout)
        if let out = result.stdout, !out.isEmpty {
            body += truncate(out, to: maxBytes)
            if !out.hasSuffix("\n") { body += "\n" }
        }
        if let err = result.stderr, !err.isEmpty {
            body += "[stderr] " + err.replacingOccurrences(of: "\n", with: "\n[stderr] ")
            if !err.hasSuffix("\n") { body += "\n" }
        }
        if let code = result.exitCode, code != 0 {
            body += "[exit] \(code)\n"
        }
        if result.timedOut {
            body += "[timeout after \(timeout)s]\n"
        }
        body += "\n"
        return body
    }

    private static func truncate(_ s: String, to max: Int) -> String {
        if s.utf8.count <= max { return s }
        let idx = s.index(s.startIndex, offsetBy: max, limitedBy: s.endIndex) ?? s.endIndex
        return String(s[s.startIndex ..< idx]) + "\n... [truncated to \(max) bytes]\n"
    }

    // MARK: - Bounded subprocess

    private struct SpawnResult {
        let stdout: String?
        let stderr: String?
        let exitCode: Int32?
        let timedOut: Bool
    }

    private static func spawn(_ argv: [String], timeout: TimeInterval) -> SpawnResult {
        guard !argv.isEmpty else {
            return SpawnResult(stdout: nil, stderr: nil, exitCode: nil, timedOut: false)
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: argv[0])
        task.arguments = Array(argv.dropFirst())

        let outPipe = Pipe()
        let errPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = errPipe

        do {
            try task.run()
        } catch {
            return SpawnResult(
                stdout: nil,
                stderr: "launch failed: \(error)",
                exitCode: nil,
                timedOut: false
            )
        }

        // Wait with a deadline. Process doesn't take a timeout directly,
        // so we spin briefly and terminate if it runs long.
        let deadline = Date().addingTimeInterval(timeout)
        while task.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        if task.isRunning {
            task.terminate()
            Thread.sleep(forTimeInterval: 0.05)
            if task.isRunning { kill(task.processIdentifier, SIGKILL) }
            return SpawnResult(
                stdout: nil,
                stderr: String(data: errPipe.fileHandleForReading.availableData, encoding: .utf8),
                exitCode: nil,
                timedOut: true
            )
        }

        let out = String(
            data: outPipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        )
        let err = String(
            data: errPipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        )
        return SpawnResult(stdout: out, stderr: err, exitCode: task.terminationStatus, timedOut: false)
    }
}
