# Task 2 — Adaptive Quality for Viewers

**Adaptive quality for viewers**: The viewer-facing players at `/:slug` and `/:slug/embed` currently serve either the `source.mp4` or if it doesn't yet exist, the playlist of HLS segments. Is there anything we could do better here to provide client browsers with a variery of options to automatically choose from? (ie let them choose between source.mp4, 1080p.mp4, 720p.mp4 etc if they exist. If we choose to do this, we should do so either by using web standard HTML in the `<video>` tag and/or features which come with our vidstack player already.)

## Phases

### Phase 1 — Research
Investigate what Vidstack and standard `<video>`/`<source>` elements already support for multi-quality selection. Determine whether this is a noop (already handled by the player or trivially enabled), a small change, or something more involved. Document findings and decide whether to proceed.
