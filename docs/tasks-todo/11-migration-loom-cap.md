# Research: Migration — Getting Videos Out of Loom & Cap

## Priority

Tier 3 — Not blocking any technical decisions, but important for actually being able to switch over. Understanding the migration path early helps us avoid designing a schema or workflow that makes import painful later.

## Context

There are hundreds of existing videos on Loom and some on Cap that need to migrate to our new system. The requirements mention "the ability to import MP4 exports of these" as important. But we should understand exactly what's available from each platform — not just the video files but also metadata, transcripts, and any other data. Read `requirements.md` for full project context, particularly the "Constraints" section about the existing video library.

## Key Questions

### Loom Export

- What does Loom's export give us? Can we download individual videos as MP4?
- Is there a bulk export option, or is it one-at-a-time?
- Does the export include metadata? (Title, description, date created, view count, transcript?)
- Does Loom have an API we could use for programmatic export?
- What video quality/resolution is the export? (Original quality, or re-encoded?)
- Are transcripts available for export? In what format?
- What about thumbnails?
- Is there a limit on how many videos we can export, or rate limiting on downloads?
- What does the Loom URL structure look like, and do we want to set up redirects from our system to handle people who have old Loom links?

### Cap Export

- What does Cap's export look like? (Since it's self-hosted or uses own storage, this might be simpler.)
- What format are videos stored in?
- What metadata is available?

### Import Pipeline Design

- What should our import workflow look like? (Upload MP4 → server processes it → video is available at a new URL.)
- What metadata do we want to preserve during import? (Title, description, creation date, transcript.)
- Should imported videos go through the same processing pipeline as new recordings? (Probably yes — they need HLS renditions.)
- How do we handle the initial bulk import of hundreds of videos? Is this a one-time batch job?
- Do we want to preserve original creation dates, or is import date sufficient?
- Should we consider importing video quality tiers, or just re-encode from the source MP4?

### Practical Considerations

- How long would it take to export and import hundreds of videos? (This is a one-time cost, but worth estimating.)
- How much storage do hundreds of imported videos require? (Affects cost modelling.)
- Should we import everything, or is this a good opportunity to prune old/irrelevant videos?

## Research Approach

- Check Loom's settings, export options, and API documentation.
- If Loom has an API, investigate what endpoints are available for listing and downloading videos.
- Check Cap's export/download capabilities.
- Look for any community tools or scripts that automate Loom export.
- Estimate the storage requirements for a bulk import.

## Expected Output

A research document that:

1. Describes exactly what Loom and Cap export gives us (file format, quality, metadata).
2. Identifies whether bulk export is possible or if it's one-at-a-time.
3. Notes whether transcripts and metadata are available for export.
4. Outlines a practical import pipeline for our system.
5. Estimates the effort and time for migrating the existing library.
6. Flags any limitations or gotchas (rate limits, quality loss, missing metadata).

## Related Tasks

- Task 05 (Video Processing & Encoding) — imported MP4s need to go through the encoding pipeline.
- Task 06 (Storage, CDN & Cost Modelling) — the existing library affects storage cost estimates.
- Task 07 (Server & Admin Stack) — the server needs an upload/import endpoint.
