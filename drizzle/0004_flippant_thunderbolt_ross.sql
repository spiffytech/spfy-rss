PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category_id` text,
	`title` text NOT NULL,
	`feed_url` text NOT NULL,
	`site_url` text,
	`etag_header` text,
	`last_modified_header` text,
	`checked_at` integer,
	`parsing_error_count` integer DEFAULT 0 NOT NULL,
	`next_check_at` integer,
	`fetch_after_at` integer,
	`websub_hub` text,
	`websub_lease_until` integer,
	`websub_token` text,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_feeds`("id", "user_id", "category_id", "title", "feed_url", "site_url", "etag_header", "last_modified_header", "checked_at", "parsing_error_count", "next_check_at", "fetch_after_at", "websub_hub", "websub_lease_until", "websub_token", "disabled", "created_at") SELECT "id", "user_id", "category_id", "title", "feed_url", "site_url", "etag_header", "last_modified_header", "checked_at", "parsing_error_count", "next_check_at", "fetch_after_at", "websub_hub", "websub_lease_until", "websub_token", "disabled", "created_at" FROM `feeds`;--> statement-breakpoint
DROP TABLE `feeds`;--> statement-breakpoint
ALTER TABLE `__new_feeds` RENAME TO `feeds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_user_url_uq` ON `feeds` (`user_id`,`feed_url`);--> statement-breakpoint
CREATE INDEX `feeds_user_idx` ON `feeds` (`user_id`);--> statement-breakpoint
UPDATE `feeds` SET `category_id` = NULL
 WHERE `category_id` IN (SELECT `id` FROM `categories` WHERE `title` = 'All');--> statement-breakpoint
DELETE FROM `categories`
 WHERE `title` = 'All'
   AND NOT EXISTS (SELECT 1 FROM `feeds` WHERE `category_id` = `categories`.`id`);
