import Foundation

extension RecordingActor {
    // MARK: - Composition Failure Recovery

    //
    // When `CompositionActor.compositeFrame` surfaces a render error or a
    // stall, we:
    //   1. Record the failure + counter in the timeline.
    //   2. Ask the compositor to rebuild its CIContext + MTLCommandQueue so
    //      the next tick renders against a fresh command queue (the old one is
    //      assumed poisoned after the first GPU-timeout cascade).
    //   3. If rebuild itself fails, fire the terminal-error callback so the
    //      coordinator can stop the recording cleanly and alert the user.
    //
    // The metronome returns false on any failure so this tick is skipped. The
    // next tick runs with a fresh context (on success) or finds `isRecording`
    // flipped false (on terminal failure, once the coordinator's stopRecording
    // lands).

    func handleCompositionFailure(_ error: CompositionError) async {
        // If the stop flow is already in progress, don't wait for the 2s
        // rebuild — the context is about to be torn down. This avoids a
        // spurious gpu_wobble flag when the final metronome tick races the
        // stop signal.
        if isStopping {
            print("[recording] Composition failure during stop — skipping rebuild")
            return
        }

        let t = logicalElapsedSeconds()
        let kind: String
        let detail: String
        switch error {
        case let .renderFailed(underlying):
            kind = "renderError"
            detail = (underlying as NSError).localizedDescription
        case .stallTimeout:
            kind = "stallTimeout"
            detail = "waitUntilCompleted exceeded 2s"
        }
        timeline.recordCompositionFailure(kind: kind, t: t, detail: detail)
        print("[recording] Composition failure: \(kind) — \(detail). Attempting rebuild.")

        let rebuilt = await composition.rebuildContext()
        if rebuilt {
            timeline.recordCompositionRebuilt(t: logicalElapsedSeconds())
            print("[recording] Rebuild succeeded, recording continues")
            return
        }

        print("[recording] Rebuild failed; escalating to terminal stop")
        await escalateCompositionTerminalFailure(detail: "Rebuild failed after \(kind)")
    }

    func escalateCompositionTerminalFailure(detail: String) async {
        guard !terminalErrorFired else { return }
        terminalErrorFired = true

        timeline.recordCompositionTerminalFailure(
            t: logicalElapsedSeconds(),
            detail: detail
        )

        let message = "Recording stopped: the GPU became unresponsive. Your recording has been saved up to this point."

        // Fire the callback on a detached task so we don't deadlock — the
        // coordinator's response will call back into stopRecording(), which
        // awaits cancelMetronome(), which awaits the metronome task we're
        // currently running inside.
        if let callback = onTerminalError {
            Task { await callback(message) }
        } else {
            print("[recording] WARN: terminal composition failure but no onTerminalError callback wired")
        }
    }
}
