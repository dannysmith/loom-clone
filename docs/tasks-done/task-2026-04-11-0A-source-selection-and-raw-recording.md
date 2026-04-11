# Task 0A — Source Selection Refactor + Raw Local Recording

Two related changes to the macOS prototype, sequenced so the second one becomes
trivial after the first lands.

**Phase 1** restructures source selection so the user picks "what's plugged
in" via the source pickers, and the recording mode is *derived* from that.
Adds a "None" option to each picker. Makes the available modes follow the
selected sources. Skips work the recording doesn't need (camera capture, PiP
overlay window, compositor PiP path) when sources are absent.

**Phase 2** adds local raw recording — alongside the composited HLS that
already gets uploaded, the app saves each selected source as a high-quality
standalone file (`screen.mp4`, `camera.mp4`, `audio.m4a`) at native
resolution. Enables future re-compositing and acts as a high-quality master.

Read `requirements.md` for product context and `docs/plan.md` for the full
architecture. Read `phase-0-prototype.md` for the prototype's current state.

---

## Phase 1 — Source Selection Refactor

### Goal

Make source selection the primary expression of intent, with mode as a
secondary choice that's only meaningful when both screen and camera are
selected.

### Behaviour after this lands

- Each input picker (Display, Camera, Microphone) has a "None" option at
  the top of its dropdown.
- The set of available recording modes is computed from which sources are
  selected:
  - Display + Camera → screenOnly, cameraOnly, screenAndCamera
  - Display only → screenOnly
  - Camera only → cameraOnly
  - Neither → record button disabled
- The mode picker is hidden entirely when only one mode is available.
- The mode strip in the recording panel only shows modes available for
  *this* recording (locked at recording start, since devices can't change
  mid-recording).
- Mic = None means no audio track. Doesn't affect mode selection.
- The microphone picker defaults to the **system default input** on first
  launch (via `AVCaptureDevice.default(for: .audio)`), not just the first
  device in the list.
- Display and Camera default to the first available device on first launch.
- Selections do **not** persist across app launches (it's two clicks to
  reset; not worth the persistence complexity right now).
- The popover preview area handles all combinations: empty placeholder when
  neither source is selected, single-source preview when one is selected,
  current PiP preview when both are.
- The 4K preset gating still works: 4K is offered when **either** the
  selected display **or** the selected camera can natively feed it.

### Performance wins

- When camera = None: no `AVCaptureSession` for the camera, no preview
  manager active, no `CameraOverlayWindow` instantiated, no per-frame
  CALayer update during recording, no PiP blend in the compositor.
- When display = None: no `SCStream`, no screen frame caching, no Lanczos
  scale of screen frames in the compositor.
- The compositor still runs in single-source mode because it does the
  native → preset scaling. It just does *less* work (no PiP blend, no mask
  generation, no two-source coordination).

### Implementation outline

**Models**
- `RecordingMode` unchanged (still the three cases). What changes is who
  decides which are valid.

**Coordinator (`RecordingCoordinator`)**
- Add a "None" sentinel for each picker — easiest is to allow `nil` directly
  (the underlying properties are already optional) and present the None
  option in the UI layer.
- New computed `availableModes: [RecordingMode]` based on
  `selectedDisplay` / `selectedCamera`.
- Auto-demote `mode` when its source goes away. E.g. user is in
  `screenAndCamera`, switches camera to None → fall back to `screenOnly`.
  If no modes remain, leave `mode` as-is and just disable the record button.
- Record button enablement: `!availableModes.isEmpty && serverReachable &&
  (selectedDisplay == nil || !screenPermissionDenied)`.
- Mic default on first launch: `AVCaptureDevice.default(for: .audio)` if
  available, else first in `availableMicrophones`, else nil.
- `updatePreviewsForCurrentState()`: gracefully handles either source being
  nil (don't try to start a preview that has no device).
- `updateCameraOverlayVisibility()`: only ever creates the overlay window
  if the camera is selected.

**Capture managers**
- No changes — they're already conditional on the device being passed.

**RecordingActor**
- `prepareRecording(displayID:cameraID:microphoneID:mode:preset:)` —
  `displayID` becomes optional. Branch on which sources to start. The
  metronome already handles "source X has no frame yet" gracefully.
- Don't start screen/camera/mic capture for sources that aren't selected.
- The composition path is unchanged structurally — it just won't be asked
  to render modes that aren't reachable.

**MenuView**
- Each `NativePopUpPicker` gets a "None" option as the first row, with a
  divider before the device list.
- Mode picker rendered only when `availableModes.count > 1`.
- Preview area handles three states: no video sources (placeholder text
  "Select an input above"), one video source (full-frame), two video
  sources (current PiP preview).
- Record button uses the new gating.

**RecordingPanelContent**
- Mode strip filtered to the locked-in `availableModes` for the recording
  in progress (snapshot at recording start). When only one mode is
  possible, hide the mode strip entirely and the divider before it.

**RecordingActor → coordinator handoff**
- The set of "modes available for this recording" needs to be passed to the
  panel so the strip can be filtered. Either snapshot it on the coordinator
  at `startRecording` time, or compute it from the locked-in source IDs.

### Exit criteria

- [x] All three pickers offer a "None" option
- [x] Mic picker defaults to system default on first launch
- [x] Setting display = None hides screenOnly and screenAndCamera modes;
      mode picker shows only cameraOnly (or hides entirely)
- [x] Setting camera = None hides cameraOnly and screenAndCamera modes;
      mode picker shows only screenOnly (or hides entirely)
- [x] Setting both display and camera to None disables the record button
- [x] Setting mic = None records video with no audio track and the
      resulting playback is silent (not broken)
- [x] Recording with display = None never shows the camera overlay window
      and never instantiates the screen capture session (verify via logs)
- [x] Recording with camera = None never shows the camera overlay window
      and the popover preview shows the screen snapshot only
- [x] Recording panel mode strip only shows modes valid for the current
      recording — and is hidden when only one mode is valid
- [x] 4K preset is offered when either selected source can feed it; hidden
      when neither can
- [x] Existing recordings (display + camera + mic) still work end-to-end
      with no regression

---

## Phase 2 — Local Raw Recording

### Goal

Save each selected capture source as a high-quality standalone file
alongside the existing composited HLS segments. These are local-only for
now (Phase 1 of `docs/plan.md` will upload them to R2 as the source backup).

### Behaviour after this lands

For each selected source, a standalone file appears in the local session
directory:

```
~/Library/Application Support/LoomClone/recordings/{id}/
  init.mp4          (HLS init — existing)
  seg_*.m4s         (HLS segments — existing)
  stream.m3u8       (existing)
  recording.json    (timeline — existing, augmented)
  screen.mp4        (NEW — native screen, video only)
  camera.mp4        (NEW — native camera, video only)
  audio.m4a         (NEW — mic, AAC)
```

- `screen.mp4`: H.264 High via VideoToolbox, native display pixel
  dimensions (post-scale-factor), 25 Mbps at 1080p, scaling proportionally
  for higher resolutions (~60 Mbps at 4K). 30fps.
- `camera.mp4`: H.264 High, camera's native format dimensions (the format
  selected by `CameraCaptureManager.bestFormat`), 12 Mbps. 30fps.
- `audio.m4a`: AAC-LC, 192 kbps, 48 kHz, stereo. Single-source — not
  duplicated into the video files.
- Files only exist for sources that are selected. Mic = None → no
  `audio.m4a`. Camera = None → no `camera.mp4`. Display = None → no
  `screen.mp4`.
- Pause/resume: handled the same way the composited path handles it —
  drop frames received during pause windows, retime resumed frames using
  the shared `recordingStartTime` + `pauseAccumulator`.
- Cancellation: raw files are deleted along with the rest of the local
  session directory.
- Always-on. No UI toggle, no auto-cleanup. The local directory is the
  safety net; Phase 1 will add the upload-and-cleanup logic.

### Why separate audio.m4a (not embedded)

- Single source (one mic), so embedding in both files would duplicate data
  for no functional gain.
- Re-compositing tools (FFmpeg, Remotion) trivially mux a separate audio
  track.
- Keeps each video writer simpler (video-only AVAssetWriter, no audio
  input plumbing per file).
- Cost: you can't double-click `camera.mp4` and hear yourself when
  spot-checking. The composited HLS is right there for that.

### Implementation outline

**New: `RawStreamWriter` actor**

A small actor wrapping a single `AVAssetWriter` writing to a file URL.
Roughly:

```swift
actor RawStreamWriter {
    enum Kind { case video(width: Int, height: Int, bitrate: Int)
                case audio(bitrate: Int) }

    init(url: URL, kind: Kind) throws { ... }
    func startSession(at time: CMTime) { ... }
    func append(_ sampleBuffer: CMSampleBuffer) { ... }
    func finish() async { ... }
}
```

No HLS delegate, no segment stream, no priming offset, no `TimestampAdjuster`.
Sample buffers are pre-retimed by the caller using the same single-anchor
formula the metronome uses:
`pts = (sampleHostTime - recordingStartTime) - pauseAccumulator`

**RecordingActor**
- Owns up to three `RawStreamWriter` instances (created in
  `prepareRecording` for whichever sources are selected). After Phase 1,
  this is just "one per non-nil source."
- `handleScreenFrame`: still caches for the metronome, *and* (if
  `screenWriter` exists and not paused) retimes and appends to the screen
  raw writer at the source's natural rate.
- `handleCameraFrame`: same — cache for compositor, *and* retime + append
  to the camera raw writer.
- `handleAudioSample`: existing path appends retimed buffer to the
  composited writer; *additionally* append a parallel retimed copy to the
  audio raw writer (it doesn't need the priming offset that the composited
  path uses for HLS).
- `stopRecording`: finalises raw writers in parallel with the composited
  writer's finish flow. Trailing data flushes naturally on
  `finishWriting()`.
- `cancelRecording`: aborts all raw writers and removes their files (the
  whole local session dir is removed today, so this falls out for free).

**RawStreamWriter encoding settings**

Screen (per preset):
- 1080p capture → 25 Mbps
- 1440p capture → 35 Mbps
- 4K capture → 60 Mbps
- (Compute from native pixel dimensions; not tied to the output preset
  since these files are *masters* at native res.)

Camera:
- Native format dimensions
- 12 Mbps

Audio:
- AAC-LC, 192 kbps, 48 kHz, stereo

Same H.264 High Profile, 2-second keyframes, CABAC entropy as the
composited path.

**Timeline (`recording.json`)**

Add a `rawStreams` block alongside the existing `preset` and `inputs`
blocks. Lists which raw files exist, their dimensions, format, bitrate,
and final byte size:

```json
"rawStreams": {
  "screen": {
    "filename": "screen.mp4",
    "width": 3840, "height": 2160,
    "videoCodec": "h264", "bitrate": 60000000,
    "bytes": 1234567890
  },
  "camera": {
    "filename": "camera.mp4",
    "width": 1920, "height": 1080,
    "videoCodec": "h264", "bitrate": 12000000,
    "bytes": 234567890
  },
  "audio": {
    "filename": "audio.m4a",
    "audioCodec": "aac-lc", "bitrate": 192000,
    "sampleRate": 48000, "channels": 2,
    "bytes": 1234567
  }
}
```

A future re-compositor reads this to know what's available locally.

**Concurrency / encoder cost**

3 simultaneous H.264 sessions (composited HLS + screen raw + camera raw)
on Apple Silicon's media engine is well within capability — Apple
documents up to 16 concurrent sessions on M1+. Worth observing on a
~10-minute recording for thermals, but no design change expected.

### Disk cost honesty

Combined output (raw screen + raw camera + composited HLS) for a 30-minute
recording:
- 1080p: ~3 GB
- 4K screen + 1080p camera: ~10 GB

Acceptable for the prototype. If it becomes a problem, the natural fix is
auto-cleanup of raw files after the server confirms upload — already
implied by the existing local-safety-net principle.

### Exit criteria

- [x] A recording with display + camera + mic produces `screen.mp4`,
      `camera.mp4`, `audio.m4a` in the local session directory
- [x] Each raw file is independently playable in QuickTime
- [x] `screen.mp4` is at the display's native pixel dimensions, not the
      output preset dimensions
- [x] `camera.mp4` is at the camera's selected-format dimensions
- [x] `audio.m4a` plays back synchronised against the composited HLS when
      muxed externally (e.g. `ffmpeg -i screen.mp4 -i audio.m4a -c copy`)
- [x] Camera = None → no `camera.mp4` written
- [x] Display = None → no `screen.mp4` written
- [x] Mic = None → no `audio.m4a` written
- [x] Pause/resume produces raw files with no gap at the pause point
      (verify by checking duration matches the composited recording)
- [x] Cancelling a recording removes the raw files along with everything
      else
- [x] `recording.json` has a `rawStreams` block listing what's there
- [x] 5-minute recording at 4K is stable (no encoder errors, no thermal
      throttling visible in logs)
- [x] Existing composited HLS upload pipeline is unchanged — recording
      still ends with a working playback URL

---

## Sequencing

Phase 1 lands as a standalone change. Phase 2 builds on it. If Phase 1
takes longer than expected we can ship it on its own and revisit Phase 2
later — Phase 2 isn't blocked by anything else in the prototype.

After both phases land, the scratchpad item "Local full-quality recordings"
is fully addressed.
