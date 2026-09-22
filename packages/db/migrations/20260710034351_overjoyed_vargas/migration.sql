ALTER TABLE `users` ADD `shadow_banned_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `shadow_ban_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `shadow_banned_by_user_id` text;