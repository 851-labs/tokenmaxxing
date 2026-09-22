ALTER TABLE `devices` ADD `service_repair_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_repair_completed_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_repair_error` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_repair_reason` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_repair_status` text;