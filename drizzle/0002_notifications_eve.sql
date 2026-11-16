CREATE TABLE `discord_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`webhook_id` integer,
	`webhook_url_enc` text NOT NULL,
	`embed` text NOT NULL,
	`kind` text DEFAULT 'alert' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`error` text,
	FOREIGN KEY (`webhook_id`) REFERENCES `discord_webhooks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `discord_queue_status_idx` ON `discord_queue` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `discord_webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`url_enc` text NOT NULL,
	`topics` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `eve_characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`owner_hash` text NOT NULL,
	`corporation_id` integer,
	`alliance_id` integer,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`token_expires_at` integer,
	`scopes` text DEFAULT '[]' NOT NULL,
	`token_revoked_at` integer,
	`roles` text DEFAULT '[]' NOT NULL,
	`roles_checked_at` integer,
	`affiliation_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eve_characters_character_id_unique` ON `eve_characters` (`character_id`);--> statement-breakpoint
CREATE INDEX `eve_characters_user_idx` ON `eve_characters` (`user_id`);--> statement-breakpoint
CREATE INDEX `eve_characters_corp_idx` ON `eve_characters` (`corporation_id`);--> statement-breakpoint
CREATE TABLE `eve_corp_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`corporation_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	`added_by` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`status_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eve_corp_links_uniq` ON `eve_corp_links` (`workspace_id`,`corporation_id`);--> statement-breakpoint
CREATE INDEX `eve_corp_links_corp_idx` ON `eve_corp_links` (`corporation_id`);--> statement-breakpoint
CREATE TABLE `eve_corporations` (
	`corporation_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ticker` text,
	`alliance_id` integer,
	`alliance_name` text,
	`alliance_ticker` text,
	`ceo_id` integer,
	`member_count` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eve_customs_offices` (
	`office_id` integer PRIMARY KEY NOT NULL,
	`corporation_id` integer NOT NULL,
	`system_id` integer NOT NULL,
	`reinforce_exit_start` integer,
	`reinforce_exit_end` integer,
	`corporation_tax_rate` real,
	`alliance_tax_rate` real,
	`standing_level` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eve_customs_corp_idx` ON `eve_customs_offices` (`corporation_id`);--> statement-breakpoint
CREATE TABLE `eve_extractions` (
	`structure_id` integer NOT NULL,
	`corporation_id` integer NOT NULL,
	`moon_id` integer NOT NULL,
	`extraction_start_time` integer NOT NULL,
	`chunk_arrival_time` integer NOT NULL,
	`natural_decay_time` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`structure_id`, `extraction_start_time`)
);
--> statement-breakpoint
CREATE INDEX `eve_extractions_corp_idx` ON `eve_extractions` (`corporation_id`);--> statement-breakpoint
CREATE TABLE `eve_members` (
	`corporation_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	`logon_date` integer,
	`logoff_date` integer,
	`location_id` integer,
	`ship_type_id` integer,
	`start_date` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`corporation_id`, `character_id`)
);
--> statement-breakpoint
CREATE TABLE `eve_names` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`extra` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eve_notifications` (
	`notification_id` integer PRIMARY KEY NOT NULL,
	`character_id` integer NOT NULL,
	`corporation_id` integer,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`text` text,
	`data` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eve_notifications_corp_idx` ON `eve_notifications` (`corporation_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `eve_sso_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`user_id` integer,
	`workspace_id` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eve_starbases` (
	`starbase_id` integer PRIMARY KEY NOT NULL,
	`corporation_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`system_id` integer NOT NULL,
	`moon_id` integer,
	`state` text,
	`reinforced_until` integer,
	`unanchor_at` integer,
	`fuel_blocks` integer,
	`strontium` integer,
	`fuel_expires_estimate` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eve_starbases_corp_idx` ON `eve_starbases` (`corporation_id`);--> statement-breakpoint
CREATE TABLE `eve_structures` (
	`structure_id` integer PRIMARY KEY NOT NULL,
	`corporation_id` integer NOT NULL,
	`name` text,
	`type_id` integer NOT NULL,
	`system_id` integer NOT NULL,
	`state` text NOT NULL,
	`state_timer_start` integer,
	`state_timer_end` integer,
	`fuel_expires` integer,
	`reinforce_hour` integer,
	`next_reinforce_hour` integer,
	`next_reinforce_apply` integer,
	`unanchors_at` integer,
	`services` text DEFAULT '[]' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eve_structures_corp_idx` ON `eve_structures` (`corporation_id`);--> statement-breakpoint
CREATE TABLE `eve_sync` (
	`key` text PRIMARY KEY NOT NULL,
	`last_sync_at` integer,
	`next_sync_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`source_character_id` integer
);
--> statement-breakpoint
CREATE TABLE `eve_wallets` (
	`corporation_id` integer NOT NULL,
	`division` integer NOT NULL,
	`name` text,
	`balance` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`corporation_id`, `division`)
);
--> statement-breakpoint
CREATE TABLE `tg_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tg_user_id` integer NOT NULL,
	`text` text NOT NULL,
	`kind` text DEFAULT 'alert' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `tg_queue_status_idx` ON `tg_queue` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `telegram_user_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `telegram_username` text;--> statement-breakpoint
ALTER TABLE `users` ADD `telegram_link_token_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `telegram_link_expires_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `telegram_linked_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `notify_topics` text;