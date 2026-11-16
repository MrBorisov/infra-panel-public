-- Рабочие пространства. Миграция написана вручную: SQLite не умеет добавлять колонку
-- NOT NULL REFERENCES к таблице с данными, поэтому таблицы пересобираются по схеме
-- https://www.sqlite.org/lang_altertable.html#otheralter. Внешние ключи на это время
-- выключает runMigrations(): внутри транзакции мигратора PRAGMA foreign_keys не действует,
-- и DROP TABLE accounts обнулил бы ссылки серверов на аккаунты.
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Всё, что было до пространств, — в «Основное»
INSERT INTO `workspaces` (`id`, `name`, `created_at`, `updated_at`) VALUES (1, 'Основное', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`infra_access` text DEFAULT 'none' NOT NULL,
	`eve_access` text DEFAULT 'none' NOT NULL,
	`can_manage_members` integer DEFAULT false NOT NULL,
	`invited_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`infra_access` text DEFAULT 'none' NOT NULL,
	`eve_access` text DEFAULT 'none' NOT NULL,
	`can_manage_members` integer DEFAULT false NOT NULL,
	`note` text,
	`created_by` integer,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invites_token_hash_unique` ON `workspace_invites` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_uniq` ON `workspace_members` (`workspace_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);
--> statement-breakpoint
-- Прежние роли → права в «Основном»: первый админ — владелец, админы и редакторы правят
-- инфраструктуру, наблюдатели смотрят. EVE прежде не было — доступ к нему у админов.
INSERT INTO `workspace_members` (`workspace_id`, `user_id`, `is_owner`, `infra_access`, `eve_access`, `can_manage_members`, `created_at`, `updated_at`)
SELECT 1, `id`,
	`id` = (SELECT MIN(`id`) FROM `users` WHERE `role` = 'admin'),
	CASE WHEN `role` IN ('admin', 'editor') THEN 'edit' ELSE 'view' END,
	CASE WHEN `role` = 'admin' THEN 'manage' ELSE 'none' END,
	`role` = 'admin',
	CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `users`;
--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text,
	`name` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'user' NOT NULL,
	`last_workspace_id` integer,
	`totp_secret_enc` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`last_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_users` (`id`, `email`, `name`, `password_hash`, `role`, `last_workspace_id`, `totp_secret_enc`, `totp_enabled`, `disabled`, `last_login_at`, `created_at`, `updated_at`)
SELECT `id`, `email`, `name`, `password_hash`, CASE WHEN `role` = 'admin' THEN 'admin' ELSE 'user' END, 1, `totp_secret_enc`, `totp_enabled`, `disabled`, `last_login_at`, `created_at`, `updated_at` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TABLE `__new_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`provider` text,
	`url` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_accounts` (`workspace_id`, `id`, `name`, `provider`, `url`, `notes`, `created_at`, `updated_at`) SELECT 1, `id`, `name`, `provider`, `url`, `notes`, `created_at`, `updated_at` FROM `accounts`;
--> statement-breakpoint
DROP TABLE `accounts`;
--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;
--> statement-breakpoint
CREATE TABLE `__new_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`account_id` integer,
	`ip` text,
	`hostname` text,
	`os` text,
	`location` text,
	`plan` text,
	`price` real,
	`currency` text DEFAULT 'RUB' NOT NULL,
	`billing_period` text DEFAULT 'month' NOT NULL,
	`paid_until` text,
	`monitor_port` integer DEFAULT 22 NOT NULL,
	`notes` text,
	`monitor_enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`status_changed_at` integer,
	`last_check_at` integer,
	`last_latency_ms` integer,
	`last_error` text,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_servers` (`workspace_id`, `id`, `name`, `description`, `account_id`, `ip`, `hostname`, `os`, `location`, `plan`, `price`, `currency`, `billing_period`, `paid_until`, `monitor_port`, `notes`, `monitor_enabled`, `status`, `status_changed_at`, `last_check_at`, `last_latency_ms`, `last_error`, `fail_count`, `created_at`, `updated_at`) SELECT 1, `id`, `name`, `description`, `account_id`, `ip`, `hostname`, `os`, `location`, `plan`, `price`, `currency`, `billing_period`, `paid_until`, `monitor_port`, `notes`, `monitor_enabled`, `status`, `status_changed_at`, `last_check_at`, `last_latency_ms`, `last_error`, `fail_count`, `created_at`, `updated_at` FROM `servers`;
--> statement-breakpoint
DROP TABLE `servers`;
--> statement-breakpoint
ALTER TABLE `__new_servers` RENAME TO `servers`;
--> statement-breakpoint
CREATE TABLE `__new_hostings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`account_id` integer,
	`plan` text,
	`price` real,
	`currency` text DEFAULT 'RUB' NOT NULL,
	`billing_period` text DEFAULT 'month' NOT NULL,
	`paid_until` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_hostings` (`workspace_id`, `id`, `name`, `account_id`, `plan`, `price`, `currency`, `billing_period`, `paid_until`, `notes`, `created_at`, `updated_at`) SELECT 1, `id`, `name`, `account_id`, `plan`, `price`, `currency`, `billing_period`, `paid_until`, `notes`, `created_at`, `updated_at` FROM `hostings`;
--> statement-breakpoint
DROP TABLE `hostings`;
--> statement-breakpoint
ALTER TABLE `__new_hostings` RENAME TO `hostings`;
--> statement-breakpoint
CREATE TABLE `__new_domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`registrar_account_id` integer,
	`dns_account_id` integer,
	`expires_at` text,
	`expires_source` text,
	`auto_renew` integer DEFAULT false NOT NULL,
	`price` real,
	`currency` text DEFAULT 'RUB' NOT NULL,
	`billing_period` text DEFAULT 'month' NOT NULL,
	`auto_lookup` integer DEFAULT true NOT NULL,
	`last_lookup_at` integer,
	`last_lookup_error` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`registrar_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`dns_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_domains` (`workspace_id`, `id`, `name`, `registrar_account_id`, `dns_account_id`, `expires_at`, `expires_source`, `auto_renew`, `price`, `currency`, `billing_period`, `auto_lookup`, `last_lookup_at`, `last_lookup_error`, `notes`, `created_at`, `updated_at`) SELECT 1, `id`, `name`, `registrar_account_id`, `dns_account_id`, `expires_at`, `expires_source`, `auto_renew`, `price`, `currency`, `billing_period`, `auto_lookup`, `last_lookup_at`, `last_lookup_error`, `notes`, `created_at`, `updated_at` FROM `domains`;
--> statement-breakpoint
DROP TABLE `domains`;
--> statement-breakpoint
ALTER TABLE `__new_domains` RENAME TO `domains`;
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_workspace_name_uniq` ON `domains` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `__new_sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`domain_id` integer,
	`server_id` integer,
	`hosting_id` integer,
	`stack` text,
	`path` text,
	`keyword` text,
	`notes` text,
	`monitor_enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`status_changed_at` integer,
	`last_check_at` integer,
	`last_latency_ms` integer,
	`last_error` text,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`last_http_status` integer,
	`ssl_expires_at` integer,
	`ssl_issuer` text,
	`ssl_checked_at` integer,
	`ssl_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`hosting_id`) REFERENCES `hostings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_sites` (`workspace_id`, `id`, `name`, `url`, `domain_id`, `server_id`, `hosting_id`, `stack`, `path`, `keyword`, `notes`, `monitor_enabled`, `status`, `status_changed_at`, `last_check_at`, `last_latency_ms`, `last_error`, `fail_count`, `last_http_status`, `ssl_expires_at`, `ssl_issuer`, `ssl_checked_at`, `ssl_error`, `created_at`, `updated_at`) SELECT 1, `id`, `name`, `url`, `domain_id`, `server_id`, `hosting_id`, `stack`, `path`, `keyword`, `notes`, `monitor_enabled`, `status`, `status_changed_at`, `last_check_at`, `last_latency_ms`, `last_error`, `fail_count`, `last_http_status`, `ssl_expires_at`, `ssl_issuer`, `ssl_checked_at`, `ssl_error`, `created_at`, `updated_at` FROM `sites`;
--> statement-breakpoint
DROP TABLE `sites`;
--> statement-breakpoint
ALTER TABLE `__new_sites` RENAME TO `sites`;
--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`address` text,
	`port` integer,
	`username` text,
	`secret_enc` text,
	`passwork_url` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_credentials` (`workspace_id`, `id`, `entity_type`, `entity_id`, `kind`, `title`, `address`, `port`, `username`, `secret_enc`, `passwork_url`, `notes`, `created_at`, `updated_at`) SELECT 1, `id`, `entity_type`, `entity_id`, `kind`, `title`, `address`, `port`, `username`, `secret_enc`, `passwork_url`, `notes`, `created_at`, `updated_at` FROM `credentials`;
--> statement-breakpoint
DROP TABLE `credentials`;
--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;
--> statement-breakpoint
CREATE INDEX `credentials_entity_idx` ON `credentials` (`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_events` (`workspace_id`, `id`, `entity_type`, `entity_id`, `kind`, `message`, `created_at`) SELECT 1, `id`, `entity_type`, `entity_id`, `kind`, `message`, `created_at` FROM `events`;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;
--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `events_workspace_idx` ON `events` (`workspace_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `workspace_id` integer;
--> statement-breakpoint
UPDATE `audit_log` SET `workspace_id` = 1 WHERE `action` LIKE 'entity.%' OR `action` LIKE 'credential.%';
