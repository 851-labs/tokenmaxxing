ALTER TABLE `cli_login_requests` ADD `device_code_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `cli_login_requests_device_code_hash_unique` ON `cli_login_requests` (`device_code_hash`);--> statement-breakpoint
CREATE INDEX `cli_login_requests_expires_at_idx` ON `cli_login_requests` (`expires_at`);--> statement-breakpoint
ALTER TABLE `cli_login_requests` DROP COLUMN `token`;--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);