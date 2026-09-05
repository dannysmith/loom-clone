-- Hand-written data migration for the presentation-master restructure. It is
-- pure SQL over existing rows: no ffmpeg, no filesystem, nothing that can take
-- minutes. The video files are migrated separately, after the deploy, by
-- `bun run videos:migrate-presentation`.
--
-- Order matters. `source_pristine` is derived from the legacy `audio` rows, so
-- it has to happen before those rows are deleted.

-- A legacy `audio` step that reached `ready` means the chain was written into
-- source.mp4 in place, so the original audio for that video is gone and the
-- chain must never run over it again. Deliberately conservative: backfill
-- inferred `audio` ready from "the source has an audio stream", so a video that
-- was never actually loudnormed can be marked non-pristine here. The only cost
-- of that is a future audio reprocess leaving its audio alone; the reverse
-- mistake would double-process it.
UPDATE videos
SET source_pristine = 0
WHERE id IN (
  SELECT video_id FROM video_processing_steps WHERE kind = 'audio' AND state = 'ready'
);
--> statement-breakpoint

-- `edited_output` produced the {H}p.mp4 an edited video served, which is exactly
-- what `presentation` produces now — so the receipt carries over rather than
-- being thrown away and re-earned. Clear any presentation row first so the
-- rename can't collide with the (video_id, kind) primary key.
DELETE FROM video_processing_steps
WHERE kind = 'presentation'
  AND video_id IN (SELECT video_id FROM video_processing_steps WHERE kind = 'edited_output');
--> statement-breakpoint

UPDATE video_processing_steps SET kind = 'presentation' WHERE kind = 'edited_output';
--> statement-breakpoint

-- `audio` is subsumed by `presentation`: the chain is one part of building the
-- master, not a step of its own. Its receipt has already been read into
-- source_pristine above.
DELETE FROM video_processing_steps WHERE kind = 'audio';
