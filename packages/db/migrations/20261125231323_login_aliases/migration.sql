CREATE TABLE `login_aliases` (
	`login` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_login_aliases_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `user_accounts` ADD `login_checked_at` integer;--> statement-breakpoint
CREATE INDEX `login_aliases_user_idx` ON `login_aliases` (`user_id`);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): a login that is another
-- user's alias is reserved, so no signup or rename may take it, whatever its
-- case. Aliases are stored lowercased, so the lookup stays on the primary key.
CREATE TRIGGER `users_login_reserved_insert` BEFORE INSERT ON `users`
WHEN EXISTS (
	SELECT 1 FROM `login_aliases`
	WHERE `login_aliases`.`login` = lower(NEW.`login`) AND `login_aliases`.`user_id` <> NEW.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'login_reserved: users.login is another user''s alias');
END;--> statement-breakpoint
CREATE TRIGGER `users_login_reserved_update` BEFORE UPDATE OF `login` ON `users`
WHEN EXISTS (
	SELECT 1 FROM `login_aliases`
	WHERE `login_aliases`.`login` = lower(NEW.`login`) AND `login_aliases`.`user_id` <> NEW.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'login_reserved: users.login is another user''s alias');
END;
