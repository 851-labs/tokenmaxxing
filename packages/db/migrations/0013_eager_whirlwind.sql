DROP INDEX `usage_days_user_date_idx`;--> statement-breakpoint
CREATE INDEX `usage_days_user_date_cost_tokens_idx` ON `usage_days` (`user_id`,`date`,`cost_usd`,`total_tokens`);--> statement-breakpoint
DROP INDEX `usage_raw_batches_device_idx`;--> statement-breakpoint
DROP INDEX `usage_raw_batches_source_idx`;--> statement-breakpoint
CREATE INDEX `cli_login_requests_user_idx` ON `cli_login_requests` (`user_id`);