ALTER TABLE `devices` ADD `last_check_in_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_backend` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_error` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_reload_required` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_scheduler_active` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_status` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `service_template_version` integer;