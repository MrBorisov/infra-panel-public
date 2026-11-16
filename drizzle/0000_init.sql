CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text,
	`url` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`user_email` text,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` integer,
	`details` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`ok` integer NOT NULL,
	`latency_ms` integer,
	`message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checks_entity_idx` ON `checks` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credentials_entity_idx` ON `credentials` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`dns_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_name_unique` ON `domains` (`name`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `hostings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `notifications_sent` (
	`key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`mfa_pending` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`hosting_id`) REFERENCES `hostings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`totp_secret_enc` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);