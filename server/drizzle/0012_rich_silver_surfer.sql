CREATE TABLE `video_processing_steps` (
	`video_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`produced_at` text,
	`size_bytes` integer,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`video_id`, `kind`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Status enum rename (task-4). The `status` column has no SQL CHECK constraint
-- (enums are TS-only), so existing rows must be migrated explicitly:
--   complete   → ready              (footage uploaded + assumed-served becomes the validated-MP4 state)
--   processing → reprocessing       (the editor's transient in-flight value is redefined)
--   failed     → processing_failed  (dead value, never written; mapped defensively)
-- NOTE: the video_processing_steps rows for existing videos are NOT created
-- here — that requires ffprobe validation and runs as a one-time backfill
-- script (scripts/backfill-processing-steps.ts) immediately after this migrates.
UPDATE `videos` SET `status` = 'ready' WHERE `status` = 'complete';--> statement-breakpoint
UPDATE `videos` SET `status` = 'reprocessing' WHERE `status` = 'processing';--> statement-breakpoint
UPDATE `videos` SET `status` = 'processing_failed' WHERE `status` = 'failed';
