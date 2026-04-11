@README.md

## Agent notes

- This is a diagnostic tool, not a shippable feature. Favour observability and safety over polish — it's fine for the code to be a bit coupled or a bit verbose if it makes a run easier to diagnose.
- Never touch the main LoomClone recording pipeline (`app/LoomClone/`) from this directory. Findings that suggest a main-app change should be recorded as notes in the run directory or in `docs/m2-pro-video-pipeline-failures.md`, not applied directly.
- Before running a config that might stress the known-hang region of the configuration space, `--dry-run` it first and verify the safety scaffolding (watchdog, `_in-progress.json` marker) is behaving.
- When the user reports a hang, check `test-runs/_in-progress.json` before doing anything else.
- The harness is an app bundle target (`LoomCloneTestHarness`), not a CLI. Build it via `xcodebuild -target LoomCloneTestHarness` from `app/`, not `swift build`.
- `project.yml` is the source of truth for the Xcode project. After editing it, run `xcodegen generate` from `app/` to regenerate `LoomClone.xcodeproj` (which is gitignored).
