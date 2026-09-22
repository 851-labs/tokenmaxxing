ALTER TABLE `devices` ADD `service_auto_update_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_completed_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_current_version` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_enabled` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_error` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_installed_version` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_latest_version` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_manager` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_reason` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_auto_update_status` text;