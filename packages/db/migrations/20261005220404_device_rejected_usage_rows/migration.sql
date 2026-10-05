ALTER TABLE `devices` ADD `rejected_usage_rows` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `last_rejected_usage_at` integer;