CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_http_status` integer,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deliveries_status_check" CHECK("deliveries"."status" IN ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_event_subscription_unique` ON `deliveries` (`event_id`,`subscription_id`);--> statement-breakpoint
CREATE INDEX `deliveries_workspace_id_id_idx` ON `deliveries` (`workspace_id`,`id`);--> statement-breakpoint
CREATE INDEX `deliveries_status_created_at_idx` ON `deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `deliveries_subscription_id_idx` ON `deliveries` (`subscription_id`);