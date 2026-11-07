ALTER TABLE `users` DROP COLUMN `is_admin`;--> statement-breakpoint
ALTER TABLE `feeds` DROP COLUMN `disabled`;--> statement-breakpoint
ALTER TABLE `entries` DROP COLUMN `comments_url`;--> statement-breakpoint
ALTER TABLE `entries` DROP COLUMN `language`;--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_error_at` integer;
