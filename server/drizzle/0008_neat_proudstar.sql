CREATE TABLE `tag_slug_redirects` (
	`old_slug` text PRIMARY KEY NOT NULL,
	`tag_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_slug_redirects_tag_id_idx` ON `tag_slug_redirects` (`tag_id`);--> statement-breakpoint
ALTER TABLE `tags` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `tags` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `tags` ADD `description` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);