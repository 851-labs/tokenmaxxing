CREATE TABLE `user_accounts` (
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`login` text,
	`name` text,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `provider_account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_accounts_user_idx` ON `user_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_accounts_email_idx` ON `user_accounts` (`email`);--> statement-breakpoint
INSERT INTO `user_accounts` (
	`provider`,
	`provider_account_id`,
	`user_id`,
	`email`,
	`email_verified`,
	`login`,
	`name`,
	`avatar_url`,
	`created_at`,
	`updated_at`
)
SELECT
	'github',
	CAST(`github_id` AS text),
	`id`,
	NULL,
	false,
	`login`,
	`name`,
	`avatar_url`,
	`created_at`,
	`updated_at`
FROM `users`;--> statement-breakpoint
DROP INDEX `users_github_id_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `github_id`;
