CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`event_name` text NOT NULL,
	`arguments` text NOT NULL,
	`callback_url` text NOT NULL,
	`secret` text NOT NULL,
	`previous_secret` text,
	`secret_rotated_at` integer,
	`expires_at` integer NOT NULL,
	`unsubscribed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_workspace_id_idx` ON `subscriptions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_id_idx` ON `subscriptions` (`user_id`);