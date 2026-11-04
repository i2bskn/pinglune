ALTER TABLE `events` ADD `screening_status` text;--> statement-breakpoint
ALTER TABLE `events` ADD `screening_score` real;--> statement-breakpoint
ALTER TABLE `events` ADD `screening_error` text;--> statement-breakpoint
ALTER TABLE `events` ADD `screening_requested_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `screened_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `screening_released_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `screening_released_by` text;--> statement-breakpoint
CREATE INDEX `events_screening_pending_idx` ON `events` (`screening_requested_at`) WHERE "events"."screening_status" = 'pending';--> statement-breakpoint
ALTER TABLE `sources` ADD `screening_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `screening_api_key` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `screening_api_key_hint` text;