CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_title_uq` ON `categories` (`user_id`,`title`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`hash` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`comments_url` text,
	`author` text,
	`content` text NOT NULL,
	`published_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`changed_at` integer NOT NULL,
	`status` text DEFAULT 'unread' NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`reading_time` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`language` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_feed_hash_uq` ON `entries` (`feed_id`,`hash`);--> statement-breakpoint
CREATE INDEX `entries_user_status_published_idx` ON `entries` (`user_id`,`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `entries_feed_published_idx` ON `entries` (`feed_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `feed_icons` (
	`feed_id` text PRIMARY KEY NOT NULL,
	`icon_id` text NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`icon_id`) REFERENCES `icons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category_id` text NOT NULL,
	`title` text NOT NULL,
	`feed_url` text NOT NULL,
	`site_url` text,
	`etag_header` text,
	`last_modified_header` text,
	`checked_at` integer,
	`parsing_error_count` integer DEFAULT 0 NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_user_url_uq` ON `feeds` (`user_id`,`feed_url`);--> statement-breakpoint
CREATE INDEX `feeds_user_idx` ON `feeds` (`user_id`);--> statement-breakpoint
CREATE TABLE `icons` (
	`id` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`data` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
-- Hand-added (drizzle-kit does not model FTS5 virtual tables). External-content
-- index over entries(title, content), maintained by the app through
-- src/server/db/search-sync.ts. Re-apply by hand if this file is regenerated.
CREATE VIRTUAL TABLE entries_fts USING fts5(title, content, content='entries');
