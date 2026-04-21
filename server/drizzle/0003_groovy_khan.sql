CREATE TABLE `admin_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hashed_token` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_tokens_hashed_token_unique` ON `admin_tokens` (`hashed_token`);