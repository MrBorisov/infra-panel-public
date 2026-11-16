-- Свои боты Telegram и Discord у пространства. Discord-вебхуки переезжают в общую таблицу
-- каналов с теми же id (на них ссылается очередь), очереди пересобираются: появились свой
-- токен бота и адрес назначения. Внешние ключи на время миграций выключает runMigrations().
CREATE TABLE `notify_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`secret_enc` text NOT NULL,
	`target` text,
	`topics` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`last_sent_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `notify_channels` (`id`, `workspace_id`, `kind`, `name`, `secret_enc`, `target`, `topics`, `enabled`, `created_by`, `created_at`, `updated_at`)
SELECT `id`, `workspace_id`, 'discord_webhook', `name`, `url_enc`, NULL, `topics`, `enabled`, `created_by`, `created_at`, `updated_at` FROM `discord_webhooks`;
--> statement-breakpoint
CREATE TABLE `__new_tg_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer,
	`chat_id` text NOT NULL,
	`bot_token_enc` text,
	`text` text NOT NULL,
	`kind` text DEFAULT 'alert' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`error` text,
	FOREIGN KEY (`channel_id`) REFERENCES `notify_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_tg_queue` (`id`, `channel_id`, `chat_id`, `bot_token_enc`, `text`, `kind`, `status`, `created_at`, `sent_at`, `error`)
SELECT `id`, NULL, CAST(`tg_user_id` AS TEXT), NULL, `text`, `kind`, `status`, `created_at`, `sent_at`, `error` FROM `tg_queue`;
--> statement-breakpoint
DROP TABLE `tg_queue`;
--> statement-breakpoint
ALTER TABLE `__new_tg_queue` RENAME TO `tg_queue`;
--> statement-breakpoint
CREATE INDEX `tg_queue_status_idx` ON `tg_queue` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `__new_discord_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer,
	`webhook_url_enc` text,
	`bot_token_enc` text,
	`target` text,
	`embed` text NOT NULL,
	`kind` text DEFAULT 'alert' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`error` text,
	FOREIGN KEY (`channel_id`) REFERENCES `notify_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_discord_queue` (`id`, `channel_id`, `webhook_url_enc`, `bot_token_enc`, `target`, `embed`, `kind`, `status`, `created_at`, `sent_at`, `error`)
SELECT `id`, `webhook_id`, `webhook_url_enc`, NULL, NULL, `embed`, `kind`, `status`, `created_at`, `sent_at`, `error` FROM `discord_queue`;
--> statement-breakpoint
DROP TABLE `discord_queue`;
--> statement-breakpoint
ALTER TABLE `__new_discord_queue` RENAME TO `discord_queue`;
--> statement-breakpoint
CREATE INDEX `discord_queue_status_idx` ON `discord_queue` (`status`,`created_at`);
--> statement-breakpoint
DROP TABLE `discord_webhooks`;
