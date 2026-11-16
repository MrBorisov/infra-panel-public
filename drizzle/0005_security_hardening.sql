ALTER TABLE `eve_sso_states` ADD `nonce_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_failed_at` integer;