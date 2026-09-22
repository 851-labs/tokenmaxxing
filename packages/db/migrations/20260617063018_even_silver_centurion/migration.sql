CREATE TABLE `usage_raw_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`report_kind` text NOT NULL,
	`ccusage_command` text NOT NULL,
	`payload_hash` text NOT NULL,
	`object_key` text NOT NULL,
	`payload_bytes` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`processed_at` integer,
	`parser_version` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_raw_batches_device_payload_hash_unique` ON `usage_raw_batches` (`device_id`,`payload_hash`);--> statement-breakpoint
CREATE INDEX `usage_raw_batches_user_idx` ON `usage_raw_batches` (`user_id`);--> statement-breakpoint
CREATE INDEX `usage_raw_batches_device_idx` ON `usage_raw_batches` (`device_id`);--> statement-breakpoint
CREATE INDEX `usage_raw_batches_source_idx` ON `usage_raw_batches` (`source`);