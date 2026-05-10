# Task 20: Support 60fps recording/streaming

GitHub: #20

## Goal

Add 30/60fps toggle to the recording pipeline. The entire pipeline currently assumes 30fps. Users pick fps before recording via a segmented toggle next to the resolution picker.

Valid combinations:

| | 30fps | 60fps |
|---|---|---|
| 720p | Yes | No |
| 1080p | Yes (default) | Yes (when source supports) |
| 1440p | Yes | Yes (when source supports) |

## Decisions

From the issue plus pre-implementation discussion:

1. **Separate axis, not baked into OutputPreset.** A new `FrameRate` enum (`.thirtyFPS`, `.sixtyFPS`) lives as an independent published property on `RecordingCoordinator`, persisted in UserDefaults. Bitrate is computed: `preset.bitrate * (fps == 60 ? 1.4 : 1.0)`. This keeps the preset model clean.
2. **Permissive 60fps gating.** 60fps is shown whenever *any* non-`None` selected source can deliver 60fps at the chosen resolution. Not gated on the most restrictive source.
3. **720p/60 not offered.** 720p is a bandwidth escape hatch; 60fps signals quality. Auto-downgrade to 30fps if user switches to 720p while 60fps is selected.
4. **1440p/60 ships with guards, not gating.** Strong logging on the M2 Pro failure path. Clean crashes are acceptable if logs make the cause obvious.
5. **Bitrate: 1.4x scaling** per Apple HLS Authoring Spec (not Cap's 2x). 1080p/60 = ~11.2 Mbps, 1440p/60 = ~18.0 Mbps.
6. **Camera FIFO: always 8.** Bumping from 4 regardless of fps. A bigger buffer is more forgiving for USB cameras at any rate, and the memory cost is negligible.
7. **Peek-with-repeat for cameraOnly at mismatched rates.** Pop when FIFO has frames (save as `lastEmittedFrame`); re-emit `lastEmittedFrame` with current tick's PTS when empty. Every camera frame still reaches output exactly once; repeated frames compress to nearly nothing in H.264.
8. **Raw camera bitrate stays at 12 Mbps.** The raw master is a safety net, not the primary output. Bump later only if quality issues appear.
9. **ZV-1: no special-casing.** Rate filter at >= 59.0 naturally excludes it from 60fps eligibility.
10. **120fps / ProMotion out of scope.** Cap requested fps at 60 even on 120Hz displays.

## Hardcoded 30fps locations

### Critical (must change)

| File | Line(s) | What |
|---|---|---|
| `RecordingActor.swift` | 229-230 | `static let targetFrameRate: Int32 = 30` + `frameDuration` |
| `RecordingActor+Metronome.swift` | 66 | `Task.sleep(for: .nanoseconds(33_333_333))` |
| `H264Settings.swift` | 22 | `AVVideoExpectedSourceFrameRateKey: 30` |
| `ScreenCaptureManager.swift` | 56, 59, 66 | `minimumFrameInterval = CMTime(1, 30)`, `queueDepth = 5`, log string |
| `CameraCaptureManager.swift` | 27, 109-115, 123 | `minAcceptableFrameRate: 29.0`, `CMTime(1, 30)` lock, log cap |

### Low priority (metadata/diagnostics)

| File | Line(s) | What |
|---|---|---|
| `RecordingTimeline.swift` | 646 | `targetFPS: 30` in encoder metadata snapshot |
| `RawStreamWriter.swift` | 87-102 | Inherits H264Settings hardcoding via `compressionProperties()` |

### No changes needed

- `WriterActor.swift` — segment interval is duration-based (4s), already fps-agnostic
- `OutputPreset.swift` — bitrate stays resolution-only; fps multiplier computed at use site
- Server — no fps assumptions anywhere (confirmed in issue audit)

## Implementation plan

### Phase 1: Core plumbing

Parameterize `targetFrameRate` through the pipeline so it's no longer a static constant.

- [ ] Create `FrameRate` enum in Models (`.thirtyFPS`, `.sixtyFPS`, with `rawValue: Int32` and a `multiplier: Double` for bitrate scaling)
- [ ] `RecordingActor`: replace `static let targetFrameRate` with instance property set at init/prepare time
- [ ] `RecordingActor+Metronome.swift`: derive sleep nanoseconds from `frameDuration` instead of hardcoded `33_333_333`
- [ ] `H264Settings`: add `fps` parameter to `compressionProperties(bitrate:fps:)`
- [ ] `RawStreamWriter`: thread fps through to H264Settings calls
- [ ] `RecordingTimeline`: thread actual fps into encoder metadata snapshot
- [ ] Bump camera FIFO capacity from 4 to 8

### Phase 2: Capture layer

- [ ] `ScreenCaptureManager`: accept fps parameter, set `minimumFrameInterval` accordingly, scale `queueDepth` with fps (`ceil(fps/30 * 5)`), clamp to display refresh rate
- [ ] `CameraCaptureManager`: parameterize `bestFormat()` to accept target fps, extend frame duration locking for 60fps with UVC safety guard, add 59.0 threshold for 60fps eligibility
- [ ] Add `is60fpsAvailable` capability query — checks if any non-`None` selected source supports 60fps at the current resolution

### Phase 3: Peek-with-repeat

- [ ] `RecordingActor+FrameHandling.swift`: extend cameraOnly mode — track `lastEmittedFrame`, pop when FIFO has frames, re-emit last frame on empty tick
- [ ] Verify screenOnly and screenAndCamera modes handle 60fps correctly (screen cache repeat is already the existing behaviour; camera PiP peek is already non-destructive)

### Phase 4: Model + coordinator

- [ ] Add `frameRate` published property to `RecordingCoordinator`, persisted in UserDefaults
- [ ] Compute effective bitrate at recording start: `preset.bitrate * frameRate.multiplier`
- [ ] Add auto-downgrade: switching to 720p forces 30fps; switching away re-enables previous choice
- [ ] Thread `frameRate` into `prepareRecording()` call

### Phase 5: UI

- [ ] `MenuView.swift`: add 30/60 segmented toggle next to resolution picker
- [ ] Disable/hide 60fps option when resolution is 720p
- [ ] Disable/hide 60fps when no source supports it at current resolution
- [ ] Visual indication when 60fps is unavailable (greyed out, not hidden — so user knows the option exists)

### Phase 6: Tests

- [ ] Update `H264SettingsTests` — parameterize for both 30 and 60fps
- [ ] Unit test: `FrameRate` enum, bitrate multiplier computation
- [ ] Unit test: 60fps camera format selection with mock formats (including NTSC 59.94 tolerance)
- [ ] Unit test: 720p + 60fps exclusion and auto-downgrade
- [ ] Unit test: peek-with-repeat FIFO behaviour (pop when available, repeat when empty, every source frame emitted exactly once)
- [ ] Unit test: display refresh rate clamping
- [ ] Test harness: thread `HarnessConfig.frameRate` into `HarnessRawH264Writer` and `HarnessCompositedHLSWriter`

### Phase 7: 1440p/60 logging

- [ ] Add ProRes bytes-per-second to composition stats (useful for diagnosing whether ProRes is a contributor to GPU contention)
- [ ] Verify existing logging covers: IOGPUFamily allocation stalls, segment cadence drift, encoder bitrate vs target, composition recovery attempts
- [ ] Add any missing logging surface identified during implementation

## Testing notes

- **Screen 60fps**: testable immediately on any 60Hz+ display
- **Camera 60fps**: no 60fps camera currently available. Covered by unit tests (mock formats), test harness (synthetic frames), and the peek-with-repeat unit tests. Real-world UVC format negotiation at 60fps is the one untestable path until a 60fps camera is available.
- **1440p/60 GPU risk**: needs burn-in on M2 Pro hardware. 1080p/60 should be well within safe envelope.
