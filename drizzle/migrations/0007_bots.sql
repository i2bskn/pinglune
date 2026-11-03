CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`name` text NOT NULL,
	`delivery_kind` text NOT NULL,
	`delivery_subscription_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bots_delivery_kind_check" CHECK("bots"."delivery_kind" IN ('mcp', 'webhook', 'queue')),
	CONSTRAINT "bots_delivery_subscription_check" CHECK(("bots"."delivery_kind" = 'mcp' AND "bots"."delivery_subscription_id" IS NULL) OR ("bots"."delivery_kind" IN ('webhook', 'queue') AND "bots"."delivery_subscription_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_workspace_name_unique` ON `bots` (`workspace_id`,`name`) WHERE "bots"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bots_delivery_subscription_unique` ON `bots` (`delivery_subscription_id`) WHERE "bots"."deleted_at" IS NULL AND "bots"."delivery_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `bots_workspace_id_idx` ON `bots` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_id` text,
	`grant_id` text,
	`oauth_client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	`revoke_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mcp_connections_revoke_reason_check" CHECK("mcp_connections"."revoke_reason" IS NULL OR "mcp_connections"."revoke_reason" IN ('user', 'replaced', 'sessions_revoked')),
	CONSTRAINT "mcp_connections_revoked_check" CHECK(("mcp_connections"."revoked_at" IS NULL) = ("mcp_connections"."revoke_reason" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_connections_active_bot_unique` ON `mcp_connections` (`bot_id`) WHERE "mcp_connections"."revoked_at" IS NULL AND "mcp_connections"."bot_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_connections_grant_unique` ON `mcp_connections` (`grant_id`) WHERE "mcp_connections"."grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `mcp_connections_user_id_idx` ON `mcp_connections` (`user_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_conversation_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`oauth_client_id` text,
	`subscription_id` text,
	`bot_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_participants_target_check" CHECK("bot_id" IS NOT NULL OR ("oauth_client_id" IS NOT NULL AND "subscription_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_participants`("id", "conversation_id", "workspace_id", "name", "oauth_client_id", "subscription_id", "bot_id", "created_at") SELECT "id", "conversation_id", "workspace_id", "name", "oauth_client_id", "subscription_id", NULL, "created_at" FROM `conversation_participants`;--> statement-breakpoint
DROP TABLE `conversation_participants`;--> statement-breakpoint
ALTER TABLE `__new_conversation_participants` RENAME TO `conversation_participants`;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_participants_client_unique` ON `conversation_participants` (`conversation_id`,`oauth_client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_participants_name_unique` ON `conversation_participants` (`conversation_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_participants_bot_unique` ON `conversation_participants` (`conversation_id`,`bot_id`);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `connection_id` text;--> statement-breakpoint
CREATE INDEX `subscriptions_connection_id_idx` ON `subscriptions` (`connection_id`);