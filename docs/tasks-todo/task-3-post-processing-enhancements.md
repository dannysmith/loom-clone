# Task 3: Post-Processing Enhancements

Goal: extend the server's completion pipeline so finished recordings pick up useful metadata, better thumbnails, consistent audio loudness, downsampled variants for slower connections, and scrub previews.

## Context

Today the server runs two fire-and-forget ffmpeg recipes after each `/complete` transition: `source.mp4` (HLS segments stitched with `-c copy +faststart`) and `thumbnail.jpg` (single frame at `min(1s, duration/2)`, scaled to 1280 px). The `videos` row has `width`/`height` columns defined in the schema but nothing populates them. `recording.json` is saved per video but nothing from it is surfaced into the DB.

All additions below fit the existing recipe-array pattern in `server/src/lib/derivatives.ts`. No new infrastructure required.

Scope boundaries:

- Transcription lives in [task 4](task-4-mac-transcription.md) — not covered here.
- Object storage and backups live in [task 5](task-5-storage-and-backups.md) — not covered here.

## Design notes

### One source of truth for metadata

The `videos` row represents **the canonical `source.mp4` only**. Its width, height, aspect ratio, and file size are the authoritative properties of the video. Downsampled variants (Phase 3) do not get their own DB columns.

Reasons: aspect ratio is invariant across renditions (squashing is a bug); pixel dimensions communicate "this is a 1440p video" as a property of the video itself; per-variant accounting has no use case today. If per-variant storage breakdowns are ever wanted in admin, add a `video_variants` table then.

### Uploaded videos can exceed 1080p

Recorded videos generally top out at 1080p today, but the upload path at `server/src/routes/admin/upload.tsx` enforces no resolution cap — in practice a user could upload 1440p, 4K, or anything else. A source taller than 1080p means both a 1080p and a 720p variant should be generated in Phase 3. Source height determines what variants make sense — see that phase.

### Loudness target

Phase 2 normalises to `-14 LUFS integrated, -1.5 dBTP, LRA 11` — the dominant YouTube/Vimeo web target. Two-pass `loudnorm` (measure pass 1, feed JSON into pass 2) is meaningfully more accurate than single-pass and trivially cheap offline.

### Source.mp4 is re-encoded from Phase 2 onwards

Today's pipeline uses `-c copy`, so `source.mp4` is just the HLS segments concatenated. From Phase 2 onwards, audio gets re-encoded (AAC at ~160 kbps). Video stays `-c copy` unless Phase 3's variant generation comes from a different input — see that phase. The metadata step in Phase 1 runs last in the recipe chain, so it reads whatever `source.mp4` exists after all prior recipes have landed.

## Phase 1: Metadata & thumbnails [DONE]

### 1.1 Columns on `videos`

New migration. Only columns with a clear use case:

| Column                | Type    | Use                                                                            |
| --------------------- | ------- | ------------------------------------------------------------------------------ |
| `aspect_ratio`        | real    | CSS / iframe sizing without float-rounding surprises                           |
| `file_bytes`          | integer | Storage auditing in admin UI; sort by size                                     |
| `camera_name`         | text    | Library filter: "all videos recorded with camera X"                            |
| `microphone_name`     | text    | Library filter: "all videos with mic X"                                        |
| `recording_health`    | text    | Nullable enum: `null` (clean) \| `gpu_wobble` \| `terminal_failure`            |

Existing `width`/`height` columns get populated for the first time.

Explicitly rejected: `video_codec`, `video_bitrate_kbps`, `audio_codec`, `audio_bitrate_kbps`, `fps` (all effectively constants for recorded videos; low signal for uploaded ones), `display_id` (an integer without a display name is not useful), `mode_switch_count`, `pause_count`, `pause_total_seconds` (debugging-only, no actionable use).

### 1.2 Metadata extraction step

Runs after all source-modifying recipes complete. Extract via ffprobe + read from the stored `recording.json`:

- From ffprobe on `source.mp4`: `width`, `height`, `aspect_ratio` (width / height, rounded to 4 dp), `file_bytes`.
- From `recording.json`: `camera_name` (`inputs.camera.name`), `microphone_name` (`inputs.microphone.name`), `recording_health` (`null` if `compositionStats` absent; `terminal_failure` if `compositionStats.terminalFailure`; `gpu_wobble` if any other counter non-zero).

Single UPDATE per video. Idempotent — re-running the pipeline re-updates.

**Backfilling existing rows.** The migration adds nullable columns, so videos already in the DB start with null values. Ship a one-off CLI (`bun run videos:backfill-metadata` or similar) that iterates all videos and runs the metadata extraction step against each. Existing rows stay null until either backfilled or re-derived.

### 1.3 Thumbnail candidate extraction

Replaces the current single-frame recipe. The best thumbnail for most recordings is near the beginning — the presenter's "hey, here's a quick video about X" frame. Sampling is therefore deliberately front-loaded, with a sparse tail for videos long enough to warrant variety.

**Step 1: build the candidate timestamp set.**

Start from the union of fixed anchors and percentage anchors:

- Fixed (seconds from start): `2`, `5`, `15`
- Percentage of duration: `10%`, `20%`, `40%`, `60%`

**Step 2: prune to what makes sense for this video.**

1. Drop any timestamp greater than `duration - 2s` (avoid reaching-for-stop frames).
2. Drop any timestamp less than `1s` (usually an encoder warm-up artefact, not useful).
3. Sort ascending.
4. Dedupe by a minimum gap of `2s` — walk the sorted list and drop any candidate within 2 s of the previously kept one. This collapses overlap in short videos without a special case (e.g. on a 30 s video, `10% = 3s` falls within 2 s of the fixed `2s` or `5s` anchors and drops out; `20% = 6s` drops against `5s`; `40% = 12s` drops against `15s`; leaving roughly `{2, 5, 15, 18}`).

Result: a variable-length set of between 1 (very short videos) and 7 (longer videos) timestamps, always front-loaded.

**Fallback for pathologically short videos.** If pruning leaves an empty set (e.g. a 1.5 s recording), fall back to a single timestamp at `duration / 2`. There is always at least one candidate.

**Seek accuracy.** The current `thumbnailRecipe` uses pre-input `-ss` (fast seek, keyframe-snapped). Modern ffmpeg usually decodes forward from the nearest keyframe to the requested time, making this accurate in practice — but with ~4 s HLS keyframe intervals this has edge cases. Verify frame accuracy on a real recording during implementation; if off, switch to post-input `-ss` (`-i source.mp4 -ss <t>`), which is slower but frame-exact.

**Step 3: extract and score.**

1. Write each frame as `derivatives/thumbnail-candidates/auto-N.jpg` (1280 px wide, JPEG q~5). `N` is the position in the final sorted-and-deduped list, zero-padded.
2. Compute luminance variance per candidate (cheap — ffmpeg `signalstats` or a simple Bun read of downscaled pixels).

**Step 4: promote one to `derivatives/thumbnail.jpg` by atomic copy.**

- Walk candidates in time order. Promote the first whose variance exceeds a near-blank threshold.
- If all are below threshold, promote the highest-variance one regardless — something is better than nothing.

Because the candidate set is already biased toward the beginning, "first non-blank" naturally picks an early preview frame without any extra scoring gymnastics. No admin interaction required for a thumbnail to exist. The selection is deterministic and re-runnable.

### 1.4 Admin thumbnail picker

UI and endpoints under the existing admin surface:

- **List candidates.** Reads `derivatives/thumbnail-candidates/` and returns a JSON array of `{ id, url, kind: "auto" | "custom", promoted: boolean }`. `id` is the filename without extension.
- **Upload custom.** Accepts a JPEG upload (size and dimension caps to enforce — suggest max 5 MB, max 3840 px wide). Scales down to 1280 px wide if larger. Writes as `custom-<basic-ISO-timestamp>.jpg` — use the compact form (`20260423T120000123Z`, no colons) to stay URL-safe and path-parser-friendly.
- **Promote a candidate.** Body specifies a candidate id. The server atomically copies that file to `thumbnail.jpg` (via `.tmp` + rename).

Admin UI presents the candidates as a grid. Clicking a candidate promotes. A separate button uploads a new JPEG and adds it to the grid. The currently-promoted candidate is highlighted.

### 1.5 Tests

- Candidate extraction: fixtures at three representative durations (e.g. 8 s, 30 s, 5 min) each produce the expected set of deduped timestamps — confirms the short-video collapse behaviour and the full seven-candidate set on longer ones.
- Heuristic selection: fixture with a known-blank leading frame and a known-varied later frame — confirms the blank frame is rejected and the next non-blank candidate is promoted.
- All-blank case: fixture of a uniformly dark/black video — confirms something still gets promoted (highest variance) rather than nothing.
- Custom upload: confirms a too-large JPEG gets resized; confirms dimension/size limits reject abusive uploads.
- Metadata extraction: verifies `aspect_ratio` matches `width/height`; verifies `recording_health` derivation from timeline fixtures.

All ffmpeg-dependent tests gated on `Bun.which("ffmpeg") !== null` per existing convention.

## Phase 2: Audio improvements [DONE]

One pipeline, done properly up front. The received-wisdom chain for speech cleanup:

```
highpass=f=80 → arnndn=m=<model>.rnnn → loudnorm=I=-14:TP=-1.5:LRA=11 (two-pass)
```

- **`highpass=f=80`** kills sub-speech rumble (HVAC, traffic, fan hum) the denoiser would otherwise waste cycles on.
- **`arnndn`** is an RNN-based denoiser shipped in every standard ffmpeg build since 4.3. Models are not bundled — ship one `.rnnn` file in `server/assets/audio-models/`. Candidates: `bd.rnnn` from [richardpl/arnndn-models](https://github.com/richardpl/arnndn-models) or the equivalent from [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models), both BSD-licensed. Test a couple on real recordings before committing; document the choice in `server/assets/audio-models/README.md`.
- **Two-pass `loudnorm`** with target `I=-14`, true-peak ceiling `-1.5 dBTP`, loudness range `11`. Pass 1 measures, pass 2 applies the measured values with `linear=true`.
- **`dynaudnorm` is explicitly not included** — consensus is that `loudnorm` in dynamic mode handles typical speech input, and `dynaudnorm` in front of it can raise the noise floor and make the denoiser's job harder.

The full chain replaces the current `source.mp4` recipe. Video track stays `-c copy`; only the audio is re-encoded (AAC at 160 kbps). Atomic write pattern preserved.

### Implementation notes

- **Two-pass wiring.** Pass 1 applies the full `highpass → arnndn → loudnorm` chain with `print_format=json` on `loudnorm`; ffmpeg writes the JSON block to stderr. Parse it (Bun's subprocess stderr capture is straightforward), extract the five `input_i`, `input_tp`, `input_lra`, `input_thresh`, `target_offset` fields, and inject them as `measured_I=...:measured_TP=...:measured_LRA=...:measured_thresh=...:offset=...:linear=true` on pass 2. The denoise chain runs in both passes because the measurement must reflect the signal the listener actually hears.
- **Pass-1 input source.** Decide between reading the HLS playlist twice or staging a temp decoded WAV/FLAC once. For long recordings the staging option halves total I/O at the cost of a scratch file. Recommended: stage to a temp file, delete at end. Not a blocker either way.

### Validation

Before shipping, test on three or four real recordings representative of the use cases (quiet office, noisy coffee shop, laptop fan, outdoor). Subjective listening is the right judge here — the goal is "consistently intelligible and pleasant" not a LUFS number on a spreadsheet. Iterate on which `.rnnn` model sounds best.

### Tests

- Integration test: runs the full chain against a fixture, confirms the output LUFS measured by a second ffmpeg pass is within ±1 LU of target.
- Failure test: confirms a missing `.rnnn` model surfaces a clear error rather than a silent fallback.

## Phase 3: Video variants

Generate downsampled MP4 renditions so slower connections have something to fall back to. Source height determines what's needed:

| Source height | Generate                          |
| ------------- | --------------------------------- |
| ≤ 720p        | nothing (source is the fallback)  |
| 721–1080p     | `720p.mp4`                        |
| ≥ 1081p       | `1080p.mp4` **and** `720p.mp4`    |

Variants land in `data/<id>/derivatives/`. Recipe per target height:

```
ffmpeg -i source.mp4 \
  -vf "scale=-2:<H>" \
  -c:v libx264 -preset medium -crf <CRF> -profile:v high \
  -c:a copy \
  -movflags +faststart \
  -f mp4 <H>p.mp4.tmp
```

- `scale=-2:H` preserves aspect ratio and enforces even width (required by H.264).
- `crf 20` for 1080p, `crf 23` for 720p — quality-based encoding, no target bitrate juggling.
- Audio copied from source (already loudnormed in Phase 2).
- Atomic `.tmp` → rename as with other recipes.

### Player wiring

Actual variant selection at playback time is downstream of [task-x-view-layer.md](task-x-view-layer.md) — detecting viewer bandwidth and picking the right rendition needs real client-side or edge logic. Multiple `<source>` elements in descending resolution order does **not** work: browsers pick by MIME-type compatibility, not bandwidth, so they'd always take the first (highest-resolution) one. Until the view-layer task lands, the viewer page continues to serve `source.mp4` by default. Phase 3's job is strictly to make the variants exist on disk, ready for the view-layer task to wire up.

### Encoding cost

libx264 `medium` at CRF 20 for a 30-minute 1440p source can take 10–20 minutes per variant on a modest Hetzner CPU. Fire-and-forget recipes serialise correctly, but multiple recordings landing close together will queue behind each other — viewers may see "720p.mp4 not ready yet" for a while after a long recording. Not a blocker. Consider `-preset fast` as a starting point (slight quality loss, significant speed gain) and revisit if output quality is unsatisfying.

### Tests

- 1440p fixture generates both variants; 1080p generates only 720p; 720p generates nothing.
- Each variant is a valid MP4 with expected dimensions (ffprobe check).

## Phase 4: Storyboard / scrubber thumbnails

Generate a sprite sheet and accompanying WebVTT so Vidstack's `<media-slider-thumbnail>` shows preview frames on hover.

### When to skip

For videos shorter than **60 seconds**, skip storyboard generation entirely — hover-scrub on a short clip is not useful enough to justify the tiles, and a partial grid invites edge cases (see below).

### Recipe

Compute interval and grid dimensions dynamically so the sheet is fully populated regardless of duration:

```
interval_seconds = max(5, round(duration / 100))
expected_frames  = floor(duration / interval_seconds)
cols             = min(10, expected_frames)
rows             = ceil(expected_frames / cols)

ffmpeg -i source.mp4 \
  -vf "fps=1/${interval_seconds},scale=240:-2,tile=${cols}x${rows}" \
  -qscale:v 5 \
  storyboard.jpg.tmp
```

Worked examples:

| Duration | Interval | Frames | Grid    |
| -------- | -------- | ------ | ------- |
| 2 min    | 5 s      | 24     | 10 × 3  |
| 5 min    | 5 s      | 60     | 10 × 6  |
| 10 min   | 6 s      | 100    | 10 × 10 |
| 1 hour   | 36 s     | 100    | 10 × 10 |

`scale=240:-2` enforces even height (matching Phase 3's convention; `-1` can produce odd numbers that some encoders reject). The accompanying VTT generator must emit exactly `expected_frames` cues with coordinates computed from the same `cols` and `rows` values.

Programmatically emit `storyboard.vtt` with one cue per tile, using the `image.jpg#xywh=x,y,w,h` spatial-fragment form that Vidstack expects:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
storyboard.jpg#xywh=0,0,240,135

00:00:05.000 --> 00:00:10.000
storyboard.jpg#xywh=240,0,240,135

...
```

(Actual dimensions depend on aspect ratio — use the values from the ffmpeg scale output.)

Serve both files at `/:slug/storyboard.jpg` and `/:slug/storyboard.vtt`. Wire into the viewer via `<media-slider-thumbnail src="/:slug/storyboard.vtt" />`.

### Tests

- Very short (< 60 s): confirms no storyboard is generated.
- Medium (say 2 min): confirms a partial grid (e.g. 10 × 3) with the right number of cues in the VTT.
- Long (simulated or trimmed): confirms interval scales so the grid maxes out at 10 × 10.
- VTT alignment: confirms every tile in the sprite has a matching cue with correct `xywh` coordinates.

## Out of scope

- Chapter markers — no reliable signal to generate them from (mode switches and pauses don't correlate with topical boundaries).
- Full HLS ABR ladder — a single 1080p + 720p fallback is adequate for personal scale. Revisit only if viewer bandwidth becomes a demonstrated problem.
- Re-uploading raw video masters from the Mac — ProRes screen/camera files stay local-only.
- Raw audio upload from the Mac for server-side re-encode — perceptual gap is small post-denoise.
- Async job infrastructure, object storage, backups — see tasks 4 and 5.
