CREATE TABLE `user_prefs` (
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`user_id`, `scope`)
);
