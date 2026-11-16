-- Модули: выключатели для сайта (system_settings) и пространств (workspace_modules), права участников
-- и приглашений по модулям — JSON в modules вместо отдельного столбца eve_access
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_modules` (
	`workspace_id` integer NOT NULL,
	`module_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `module_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `modules` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD `modules` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `workspace_members` SET `modules` = json_object('eve', `eve_access`) WHERE `eve_access` <> 'none';--> statement-breakpoint
UPDATE `workspace_invites` SET `modules` = json_object('eve', `eve_access`) WHERE `eve_access` <> 'none';--> statement-breakpoint
ALTER TABLE `workspace_members` DROP COLUMN `eve_access`;--> statement-breakpoint
ALTER TABLE `workspace_invites` DROP COLUMN `eve_access`;
