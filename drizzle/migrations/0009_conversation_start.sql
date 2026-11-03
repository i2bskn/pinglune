ALTER TABLE `bots` ADD `can_start_conversations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bots` ADD `start_daily_limit` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `bots` ADD `start_max_ai_messages` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `started_by_bot_id` text REFERENCES bots(id);--> statement-breakpoint
CREATE INDEX `conversations_started_by_bot_created_at_idx` ON `conversations` (`started_by_bot_id`,`created_at`);