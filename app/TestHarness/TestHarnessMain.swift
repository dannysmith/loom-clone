import AppKit
@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - TestHarnessMain
//
// The harness is an app bundle (not a CLI) because screen capture and
// camera access require a signed, bundled app with entitlements. See
// docs/tasks-todo/task-0C-isolation-test-harness.md.
//
// Lifecycle:
//  1. launch -> parse argv for --config / --dry-run
//  2. load HarnessConfig from the given JSON path
//  3. run the test on a background task
//  4. write result.json, remove the in-progress marker
//  5. call exit() — we don't want a dock icon or window lingering
//
// Argv is read from CommandLine.arguments. When launched via
// `open -a LoomCloneTestHarness --args --config /tmp/x.json`, macOS
// forwards the args to the process argv.

@main
enum TestHarnessMain {

    static func main() {
        // Must install the shared app BEFORE calling run(). setActivationPolicy
        // to .accessory keeps us out of the Dock and command-tab switcher.
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let delegate = HarnessAppDelegate()
        app.delegate = delegate
        app.run()
    }
}

// MARK: - AppDelegate

private final class HarnessAppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Kick off the run on a background task so we don't block the
        // main run loop. The main loop stays alive so AVFoundation's own
        // main-thread work (delegate callbacks, etc.) can proceed.
        Task.detached(priority: .userInitiated) {
            await runHarnessAndExit()
        }
    }
}

// MARK: - Top-level runner

private func runHarnessAndExit() async {
    let args = HarnessArgs.parse(CommandLine.arguments)

    if args.listDevices {
        await listDevicesAndExit()
    }

    guard let configPath = args.configPath else {
        printStderr("error: --config <path> required (or pass --list-devices)")
        exitNow(code: 2)
    }

    let configURL = URL(fileURLWithPath: configPath)
    let config: HarnessConfig
    do {
        config = try HarnessConfig.load(from: configURL)
    } catch {
        printStderr("error: failed to load config at \(configPath): \(error)")
        exitNow(code: 2)
    }

    if args.dryRun {
        HarnessDryRun.describe(config: config)
        exitNow(code: 0)
    }

    let runner = HarnessRunner(config: config, testRunsRoot: args.testRunsRoot)
    let outcome = await runner.run()

    switch outcome.outcome {
    case "pass":
        exitNow(code: 0)
    case "degraded":
        exitNow(code: 20)
    case "fail-recorded":
        exitNow(code: 30)
    case "fail-killed":
        exitNow(code: 40)
    default:
        exitNow(code: 1)
    }
}

// MARK: - Argv parsing

struct HarnessArgs {
    var configPath: String?
    var dryRun: Bool = false
    var listDevices: Bool = false
    var testRunsRoot: String

    static func parse(_ argv: [String]) -> HarnessArgs {
        var args = HarnessArgs(
            configPath: nil,
            dryRun: false,
            listDevices: false,
            testRunsRoot: defaultTestRunsRoot()
        )
        var i = 1
        while i < argv.count {
            let a = argv[i]
            switch a {
            case "--config":
                i += 1
                if i < argv.count { args.configPath = argv[i] }
            case "--dry-run":
                args.dryRun = true
            case "--list-devices":
                args.listDevices = true
            case "--test-runs-root":
                i += 1
                if i < argv.count { args.testRunsRoot = argv[i] }
            default:
                break
            }
            i += 1
        }
        return args
    }

    /// Default test-runs location: resolved relative to the current working
    /// directory of the launching shell. `open --args` inherits the current
    /// directory from the terminal that invoked it, so this works as long
    /// as the runner script cd's into the repo root first.
    private static func defaultTestRunsRoot() -> String {
        let cwd = FileManager.default.currentDirectoryPath
        return (cwd as NSString).appendingPathComponent("test-runs")
    }
}

// MARK: - Device listing (--list-devices)
//
// Prints displays (via SCShareableContent) and cameras (via
// AVCaptureDevice.DiscoverySession) with their stable IDs so the user
// can copy them into `source.displayID` / `source.deviceUniqueID` in
// Tier 4 configs.
//
// This path also triggers the TCC permission prompts: running
// `--list-devices` once is the recommended first step on a fresh
// machine, because it'll either prompt or tell you clearly where to
// grant permission.

private func listDevicesAndExit() async -> Never {
    print("== Displays ==")
    do {
        let content = try await SCShareableContent.current
        if content.displays.isEmpty {
            print("  (no displays returned by SCShareableContent — Screen Recording permission likely denied)")
            print("  grant permission: System Settings → Privacy & Security → Screen & System Audio Recording → enable LoomCloneTestHarness")
        } else {
            for d in content.displays {
                let name = CapturedScreenSource.localizedName(for: d.displayID)
                let scale = CapturedScreenSource.backingScaleFactor(for: d.displayID)
                let pxW = Int(CGFloat(d.width) * scale)
                let pxH = Int(CGFloat(d.height) * scale)
                let isMain = d.displayID == CGMainDisplayID() ? " [main]" : ""
                print("  displayID=\(d.displayID)\(isMain)")
                print("    name:     \(name)")
                print("    points:   \(d.width)x\(d.height)")
                print("    pixels:   \(pxW)x\(pxH) (scale \(scale))")
            }
        }
    } catch {
        let err = error as NSError
        if err.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && err.code == -3801 {
            print("  Screen Recording permission DENIED (SCStreamError -3801).")
        } else {
            print("  error querying SCShareableContent: \(error)")
        }
        print("  grant permission: System Settings → Privacy & Security → Screen & System Audio Recording → enable LoomCloneTestHarness, then re-run.")
    }

    print()
    print("== Cameras ==")
    let granted = await AVCaptureDevice.requestAccess(for: .video)
    if !granted {
        print("  Camera permission denied — System Settings → Privacy & Security → Camera → enable LoomCloneTestHarness")
    }
    let devices = CapturedCameraSource.discoverDevices()
    if devices.isEmpty {
        print("  (no cameras discovered)")
    } else {
        for d in devices {
            print("  deviceUniqueID=\(d.uniqueID)")
            print("    name:           \(d.localizedName)")
            let maxH = CapturedCameraSource.bestFormat(for: d, maxHeight: Int.max).map { fmt -> String in
                let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
                return "\(dims.width)x\(dims.height)"
            } ?? "no 30fps-capable format"
            print("    best @30fps:    \(maxH)")
        }
    }

    print()
    print("Use these IDs in Tier 4 configs:")
    print("  source.displayID       (UInt32)")
    print("  source.deviceUniqueID  (String)")

    exitNow(code: 0)
}

// MARK: - Helpers

func printStderr(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}

func exitNow(code: Int32) -> Never {
    // Flush stdout/stderr then hard-exit. NSApp.terminate would run the
    // AppKit shutdown sequence, which is slower and occasionally blocks
    // on resource cleanup — defeating the point of a diagnostic tool.
    fflush(stdout)
    fflush(stderr)
    exit(code)
}
