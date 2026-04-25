CREATE TABLE `video_transcripts` (
	`video_id` text PRIMARY KEY NOT NULL,
	`format` text NOT NULL,
	`plain_text` text NOT NULL,
	`word_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
