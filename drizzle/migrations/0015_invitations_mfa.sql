CREATE TABLE `mfa_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`totp_secret` text,
	`totp_last_step` integer DEFAULT -1 NOT NULL,
	`totp_attempts` integer DEFAULT 0 NOT NULL,
	`totp_retry_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mfa_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text,
	FOREIGN KEY (`user_id`) REFERENCES `mfa_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mfa_credentials_user_idx` ON `mfa_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `mfa_pending` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`purpose` text NOT NULL,
	`replace_factors` integer DEFAULT false NOT NULL,
	`initial_setup` integer DEFAULT false NOT NULL,
	`next` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`challenge` text,
	`totp_secret` text,
	`recovery_hash` text,
	`marker` text,
	FOREIGN KEY (`user_id`) REFERENCES `mfa_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mfa_pending_expiry_idx` ON `mfa_pending` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mfa_pending_user_idx` ON `mfa_pending` (`user_id`);--> statement-breakpoint
CREATE TABLE `mfa_recovery_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `mfa_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mfa_recovery_codes_user_idx` ON `mfa_recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_invitations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invitations_token_hash_unique` ON `user_invitations` (`token_hash`);