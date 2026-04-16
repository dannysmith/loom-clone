CREATE TABLE `slug_redirects` (
	`old_slug` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slug_redirects_video_id_idx` ON `slug_redirects` (`video_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `video_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_events_video_id_created_at_idx` ON `video_events` (`video_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `video_segments` (
	`video_id` text NOT NULL,
	`filename` text NOT NULL,
	`duration_seconds` real NOT NULL,
	`uploaded_at` text NOT NULL,
	PRIMARY KEY(`video_id`, `filename`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `video_tags` (
	`video_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`video_id`, `tag_id`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_tags_tag_id_idx` ON `video_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'recording' NOT NULL,
	`visibility` text DEFAULT 'unlisted' NOT NULL,
	`title` text,
	`description` text,
	`duration_seconds` real,
	`width` integer,
	`height` integer,
	`source` text DEFAULT 'recorded' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`trashed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_slug_unique` ON `videos` (`slug`);--> statement-breakpoint
CREATE INDEX `videos_trashed_at_idx` ON `videos` (`trashed_at`);--> statement-breakpoint
CREATE INDEX `videos_created_at_idx` ON `videos` (`created_at`);