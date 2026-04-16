# Task: Turn menubar app into a clean MVP

Goal: Turn our macos app into a proper high-quality MVP to start building on top of.

## Phase 1 - Developer Tooling [DONE]

Let's make sure that we have the `app/` project set up as well as we can for both development in XCode and specifically for Agentic development. In a typesript project I'd be looking to install linters, formatters, static analysis tools and a testing framework and make sure we've also got an AGENTS.md inside the project dir with some stuff specific to that codebase. I'd also be looking to ensure we have a good setup for consistent UI etc.

I don't know what the e equivalent of this kind of thing is for workingwith Swift/SwiftUI - It may be that we already have all of that stuff sorted and we're basically good to go. But if not then there's stuff that a really experienced Swift and Swift UI developer building an app like this would include in order to make development less error prone and easier for humans and agents, then let's make sure that we've got the right tooling set up, the right config, the right stuff for all of that. 

### Additions

- Add SwiftLint, SwiftFormat, and stricter build settings (1282f4e94c990201ad05e7534a41178015f66f4b)
  - SwiftLint config (.swiftlint.yml) with post-compile build phase in both targets
  - SwiftFormat config (.swiftformat) with consistent style rules
  - Upgrade SWIFT_STRICT_CONCURRENCY from targeted to complete
  - Enable SWIFT_TREAT_WARNINGS_AS_ERRORS and GCC_TREAT_WARNINGS_AS_ERRORS
  - Add settingGroups in project.yml so both targets share quality settings
  - Enable createIntermediateGroups for cleaner Xcode navigator
  - Document tooling in app CLAUDE.md
- Added Makefile for common commands
- Formatted codebase and fixed linting errors etc

## Phase 2 - Full Review and Architecture Review [DONE]

Now let's conduct a full review of the entire macOS app codebase, as an expert in building strong performant apps like this. Let's look at the code quality. Let's look at the overall architecture and naming conventions how we're splitting our code up either into different files or different functions, whether we're following standard/common "best practices" etc.

### Improvements

#### 1. Fix UserDefaults key inconsistency in RecordingCoordinator

`RecordingCoordinator` (line 112-118) defines `outputPresetDefaultsKey` as a static constant but the property initialiser reads from a hardcoded string `"outputPresetID"` instead of using `Self.outputPresetDefaultsKey`. Use the constant in both places.

#### 2. Extract shared H.264 encoder settings

H.264 compression settings (hardware requirement, High profile, CABAC entropy, RealTime=false, no B-frames, 2s keyframe interval, 30fps expected source rate) are duplicated between `WriterActor.configure()` (lines 132-182) and `RawStreamWriter.configure()` (lines 89-110). Extract the shared compression properties into a factory so changes stay in sync. The two contexts differ only in bitrate and whether colour properties are declared, so the factory should accept those as parameters.

#### 3. Split RecordingActor into focused files

At 1,279 lines, `RecordingActor` is the largest file in the codebase by a wide margin. The MARK sections show clear seams. Extract these into extensions in separate files:
- **Metronome** (~60 lines): `startMetronome`, `cancelMetronome`, `metronomeLoop` — the drift-corrected 30fps emit loop.
- **Frame handling** (~150 lines): `handleScreenFrame`, `handleCameraFrame`, `handleAudioSample`, `emitMetronomeFrame` — the capture callback handlers and metronome frame composition.
- **PTS and clock** (~60 lines): `logicalElapsedSeconds`, `retimedSampleForRawWriter`, the PTS retiming helpers — the recording clock arithmetic.
- **Composition failure recovery** (~65 lines): `handleCompositionResult`, rebuild logic, terminal error escalation.

The main file keeps the two-phase start, stop, pause/resume, mode switch, and segment handling — the state machine core.

#### 4. Mark RecordingTimelineBuilder as @unchecked Sendable

`RecordingTimelineBuilder` is a mutable class accessed exclusively from `RecordingActor` but has no `Sendable` annotation. It works today because the actor serialises access, but if strict concurrency ever flags the builder crossing an actor boundary (e.g. being captured in a closure that crosses isolation), it'll fail to compile. Add `@unchecked Sendable` with a comment stating the confinement contract ("only accessed from RecordingActor").

#### 5. Minor fixes (low-hanging fruit)

- **`RecordingMode.next()` force-unwrap** (line 26): `firstIndex(of: self)!` is safe because `self` is always in `allCases`, but add a comment documenting why.
- **`KeyboardShortcutManager` magic key codes**: Replace bare integers (15, 35, 46) with named constants (e.g. `private static let kVK_R: UInt16 = 15`).
- **`MicrophonePreviewManager` missing format logging**: Camera capture logs its resolved format and colour extensions on startup; the mic manager doesn't log sample rate, channel count, or codec. Add a matching diagnostic log after `startRunning()` for consistency.

## Phase 3 - Tests

I don't know what the normal pattern for testing is. But we should probably make sure that we have whatever nor automated tests would be normal in a mac OS app like this. 

Added tests:

- RecordingTimelineBuilderTests (20 tests) — the heaviest coverage: segment tracking, upload result patching, event ordering, stable sort, composition stats, raw streams, JSON encoding
- TimestampAdjusterTests (6 tests) — priming offset, single/multi pause cycles, resume-without-pause safety
- OutputPresetTests (5 tests) — fromID lookup/fallback, uniqueness, ordering
- RecordingModeTests (4 tests) — cycle, wrap-around, display names, system images
- H264SettingsTests (4 tests) — factory keys, bitrate variation, Rec. 709 properties
- JSONValueTests (4 tests) — encoding round-trip for all four cases

## Phase 4 - Performance Review

Now let's conduct another full review of the code base, but this time purely focused on finding any glaring performance issues or low-hanging fruit.

### Improvements

#### 1. Avoid redundant SwiftUI re-renders from device polling

`refreshDevices()` in `RecordingCoordinator` unconditionally assigns `availableDisplays`, `availableCameras`, and `availableMicrophones` every 2 seconds. With `@Observable`, every assignment fires observation even if the list hasn't changed — and these are arrays of reference types with no value equality. This causes `MenuView` to re-evaluate its entire body and rebuild all three `NativePopUpPicker` menus every 2 seconds for no reason. Fix by comparing device IDs before assigning.

#### 2. Cache CGColorSpace on the 30fps composition path

`CompositionActor` line 204 and `CameraPreviewLayerView` line 179 both call `CGColorSpace(name: CGColorSpace.itur_709)` on every frame. The CompositionActor call runs at 30fps during recording. Cache as a static to avoid the CoreFoundation registry lookup per frame.

#### 3. Cache CIImage extent in overlay creation

`CompositionActor.createCircularOverlay` reads `.extent` on the camera CIImage, then again on the scaled result, then again for the translation. Store extent in a local variable to avoid redundant lazy-graph metadata queries.
