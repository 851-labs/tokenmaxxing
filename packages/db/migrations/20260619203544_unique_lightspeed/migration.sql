ALTER TABLE `cli_login_requests` ADD `device_arch` text;--> statement-breakpoint
ALTER TABLE `cli_login_requests` ADD `device_version` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `arch` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `version` text;