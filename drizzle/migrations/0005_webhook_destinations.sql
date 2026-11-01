ALTER TABLE `subscriptions` ADD `kind` text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `name` text;