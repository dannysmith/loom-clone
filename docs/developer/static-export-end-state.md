# The static-export end state

A design constraint, not a plan. The 2026-07 architecture review recommended recording this so no future feature accidentally breaks it.

**The intent: when this system eventually reaches end-of-life, the entire public surface can be frozen onto any static host, and every URL keeps working.** "Own my URLs / permanent URLs" is the requirement that outlives everything else — some videos are embedded in knowledge bases that will still be read years from now, on a domain that must not go dark just because the server does.

The current design is already close to a terminal static export, and that is worth protecting:

- Everything viewer-facing is **slug-addressed flat files** (`/:slug`, `/:slug.mp4`, `/:slug/poster.jpg`, captions, storyboards, feeds) plus two small tables (`videos`, `slug_redirects`).
- A hypothetical export script would walk the database and emit: one static HTML page per public/unlisted video, the media files as-is, the feeds, and a redirect map from `slug_redirects`. Nothing else is needed.

## The constraint on future work

**No feature may make the *viewer* surface depend on something dynamic that can't be exported.** Concretely:

- Viewer pages must stay renderable to plain HTML with no per-request state — no viewer sessions, no server-computed personalisation, no APIs a page needs at view time. (The `?t=` deep link is fine: it's client-side.)
- Media must stay servable as plain files with ordinary HTTP — no auth gates or dynamic manifests on the public path.
- Slug redirects must stay expressible as a static map (old slug → new slug), which any host or CDN can apply.

Admin surfaces are exempt — they die with the server, by design.

If a future feature wants to bend one of these, that's the moment to actually build the exporter first and make the trade-off consciously. Related: icebox issue #4 (media on object storage) is the natural first step of this story if it ever thaws.
