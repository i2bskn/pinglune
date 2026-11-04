ALTER TABLE `sources` ADD `email_sender_verification` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `email_allowed_senders` text;