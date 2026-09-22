CREATE TABLE `usage_source_stats` (
	`device_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `source`)
);
--> statement-breakpoint
CREATE INDEX `usage_source_stats_user_idx` ON `usage_source_stats` (`user_id`);