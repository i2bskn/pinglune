PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__bots_backup` AS SELECT * FROM `bots`;--> statement-breakpoint
DROP TABLE `bots`;--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`name` text NOT NULL,
	`delivery_kind` text NOT NULL,
	`delivery_subscription_id` text,
	`can_start_conversations` integer DEFAULT 0 NOT NULL,
	`start_daily_limit` integer DEFAULT 10 NOT NULL,
	`start_max_ai_messages` integer DEFAULT 10 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bots_delivery_kind_check" CHECK("bots"."delivery_kind" IN ('mcp', 'webhook', 'queue', 'email')),
	CONSTRAINT "bots_delivery_subscription_check" CHECK(("bots"."delivery_kind" = 'mcp' AND "bots"."delivery_subscription_id" IS NULL) OR ("bots"."delivery_kind" IN ('webhook', 'queue', 'email') AND "bots"."delivery_subscription_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `bots`("id","workspace_id","created_by_user_id","name","delivery_kind","delivery_subscription_id","can_start_conversations","start_daily_limit","start_max_ai_messages","created_at","updated_at","deleted_at") SELECT "id","workspace_id","created_by_user_id","name","delivery_kind","delivery_subscription_id","can_start_conversations","start_daily_limit","start_max_ai_messages","created_at","updated_at","deleted_at" FROM `__bots_backup`;--> statement-breakpoint
DROP TABLE `__bots_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `bots_workspace_name_unique` ON `bots` (`workspace_id`,`name`) WHERE "bots"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bots_delivery_subscription_unique` ON `bots` (`delivery_subscription_id`) WHERE "bots"."deleted_at" IS NULL AND "bots"."delivery_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `bots_workspace_id_idx` ON `bots` (`workspace_id`);