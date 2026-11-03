CREATE TABLE `bot_sources` (
	`bot_id` text NOT NULL,
	`source_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`bot_id`, `source_id`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bot_sources_source_id_idx` ON `bot_sources` (`source_id`);--> statement-breakpoint
CREATE INDEX `bot_sources_workspace_id_idx` ON `bot_sources` (`workspace_id`);