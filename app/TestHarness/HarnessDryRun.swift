import Foundation

// MARK: - HarnessDryRun
//
// Validates a config and prints what the harness WOULD do, without
// calling any AVFoundation entry point. The first thing a new test
// config should be run with — especially anything in Tier 3+. Per
// task-0C doc: "Dry-run should also be the first thing any new test
// configuration is run with."
//
// This deliberately doesn't touch AVAssetWriter, VTCompressionSession,
// ScreenCaptureKit, AVCaptureSession, or CIContext. All it does is
// parse, echo, and exit. If the dry-run crashes, the config is wrong
// in a way we'd want to know about before running it for real.

enum HarnessDryRun {

    static func describe(config: HarnessConfig) {
        print("=== DRY RUN: \(config.name) ===")
        if let d = config.description { print("description: \(d)") }
        if let t = config.tier { print("tier: \(t)") }
        print("duration: \(config.durationSeconds)s (watchdog fires at +\(config.watchdogGraceSeconds)s)")
        print("frame rate: \(config.frameRate) fps")
        print("expected: \(config.expected)")
        print("")
        print("source: \(config.source.kind)")
        if let w = config.source.width, let h = config.source.height {
            print("  dimensions: \(w)x\(h)")
        }
        print("  pattern: \(config.source.pattern)")
        print("  colorSpace: \(config.source.colorSpace)")
        if let extras = config.source.additional, !extras.isEmpty {
            print("  additional sources: \(extras.count)")
            for (i, s) in extras.enumerated() {
                print("    [\(i)] \(s.kind) \(s.width ?? 0)x\(s.height ?? 0) \(s.pattern)")
            }
        }
        print("")
        if let comp = config.compositor {
            print("compositor: ENABLED")
            print("  output: \(comp.outputWidth)x\(comp.outputHeight)")
            print("  camera overlay: \(comp.includeCameraOverlay)")
            print("  lanczos scaling: \(comp.useLanczosScaling)")
            print("  render mode: \(comp.renderMode)")
        } else {
            print("compositor: DISABLED (writers fed directly from source)")
        }
        print("")
        print("writers: \(config.writers.count)")
        for (i, w) in config.writers.enumerated() {
            var parts: [String] = [w.kind, w.name]
            if let width = w.width, let height = w.height {
                parts.append("\(width)x\(height)")
            }
            if let b = w.bitrate { parts.append("\(b/1_000_000)Mbps") }
            print("  [\(i)] \(parts.joined(separator: " "))")
            if let tunings = w.tunings, !tunings.isEmpty {
                for (k, _) in tunings {
                    print("      tuning: \(k)")
                }
            }
        }
        print("")
        print("(nothing in AVFoundation was touched. run without --dry-run to execute.)")
    }
}
