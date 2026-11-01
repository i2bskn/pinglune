CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `api_keys_source_id_idx` ON `api_keys` (`source_id`);--> statement-breakpoint
CREATE TABLE `event_data` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`r2_key` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_data_role_check" CHECK("event_data"."role" IN ('body', 'attachment'))
);
--> statement-breakpoint
CREATE INDEX `event_data_event_id_idx` ON `event_data` (`event_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`labels` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_source_idempotency_unique` ON `events` (`source_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `events_workspace_id_id_idx` ON `events` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_workspace_id_name_unique` ON `sources` (`workspace_id`,`name`);