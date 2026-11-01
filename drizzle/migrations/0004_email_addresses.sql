CREATE TABLE `email_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_received_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_addresses_source_id_idx` ON `email_addresses` (`source_id`);