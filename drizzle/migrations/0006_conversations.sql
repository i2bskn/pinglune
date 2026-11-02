CREATE TABLE `conversation_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_participants_client_unique` ON `conversation_participants` (`conversation_id`,`oauth_client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_participants_name_unique` ON `conversation_participants` (`conversation_id`,`name`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`stop_reason` text,
	`max_ai_messages` integer NOT NULL,
	`ai_message_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`stopped_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_status_check" CHECK("conversations"."status" IN ('open', 'stopped')),
	CONSTRAINT "conversations_stop_reason_check" CHECK("conversations"."stop_reason" IS NULL OR "conversations"."stop_reason" IN ('user', 'limit'))
);
--> statement-breakpoint
CREATE INDEX `conversations_workspace_id_id_idx` ON `conversations` (`workspace_id`,`id`);--> statement-breakpoint
DROP INDEX `sources_workspace_id_name_unique`;--> statement-breakpoint
ALTER TABLE `sources` ADD `kind` text DEFAULT 'program' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_workspace_conversation_unique` ON `sources` (`workspace_id`) WHERE "sources"."kind" = 'conversation';--> statement-breakpoint
CREATE UNIQUE INDEX `sources_workspace_id_name_unique` ON `sources` (`workspace_id`,`name`) WHERE "sources"."kind" = 'program';--> statement-breakpoint
ALTER TABLE `events` ADD `conversation_id` text REFERENCES conversations(id);--> statement-breakpoint
CREATE INDEX `events_conversation_id_id_idx` ON `events` (`conversation_id`,`id`);