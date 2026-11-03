ALTER TABLE `conversations` ADD `started_by_source_id` text REFERENCES sources(id);--> statement-breakpoint
CREATE INDEX `conversations_started_by_source_created_at_idx` ON `conversations` (`started_by_source_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `sources` ADD `can_start_conversations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `start_daily_limit` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `start_max_ai_messages` integer DEFAULT 10 NOT NULL;