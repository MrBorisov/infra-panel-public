DROP TABLE `eve_characters`;--> statement-breakpoint
DROP TABLE `eve_corp_links`;--> statement-breakpoint
DROP TABLE `eve_corporations`;--> statement-breakpoint
DROP TABLE `eve_customs_offices`;--> statement-breakpoint
DROP TABLE `eve_extractions`;--> statement-breakpoint
DROP TABLE `eve_members`;--> statement-breakpoint
DROP TABLE `eve_names`;--> statement-breakpoint
DROP TABLE `eve_notifications`;--> statement-breakpoint
DROP TABLE `eve_sso_states`;--> statement-breakpoint
DROP TABLE `eve_starbases`;--> statement-breakpoint
DROP TABLE `eve_structures`;--> statement-breakpoint
DROP TABLE `eve_sync`;--> statement-breakpoint
DROP TABLE `eve_wallets`;--> statement-breakpoint
-- Модуль EVE удалён насовсем: его права, выключатели, темы оповещений и события журнала больше никому не нужны
UPDATE `workspace_members` SET `modules` = json_remove(`modules`, '$.eve') WHERE json_type(`modules`, '$.eve') IS NOT NULL;--> statement-breakpoint
UPDATE `workspace_invites` SET `modules` = json_remove(`modules`, '$.eve') WHERE json_type(`modules`, '$.eve') IS NOT NULL;--> statement-breakpoint
DELETE FROM `workspace_modules` WHERE `module_id` = 'eve';--> statement-breakpoint
DELETE FROM `system_settings` WHERE `key` LIKE 'module.eve.%';--> statement-breakpoint
UPDATE `workspace_members` SET `notify_topics` = (SELECT json_group_array(`value`) FROM json_each(`workspace_members`.`notify_topics`) WHERE `value` NOT LIKE 'eve.%') WHERE json_valid(`notify_topics`) AND `notify_topics` LIKE '%"eve.%';--> statement-breakpoint
UPDATE `notify_channels` SET `topics` = (SELECT json_group_array(`value`) FROM json_each(`notify_channels`.`topics`) WHERE `value` NOT LIKE 'eve.%') WHERE json_valid(`topics`) AND `topics` LIKE '%"eve.%';--> statement-breakpoint
DELETE FROM `events` WHERE `entity_type` LIKE 'eve\_%' ESCAPE '\';
