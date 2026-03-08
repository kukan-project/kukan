ALTER TABLE "api_token" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "package" ALTER COLUMN "creator_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_group_membership" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_org_membership" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" varchar(20) DEFAULT 'user';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_expires" integer;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonatedBy" text;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "sysadmin";--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_token_unique" UNIQUE("token");