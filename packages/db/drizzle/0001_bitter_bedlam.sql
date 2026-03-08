-- Drop FK constraints referencing user.id before type change
ALTER TABLE "account" DROP CONSTRAINT "account_userId_user_id_fk";--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_userId_user_id_fk";--> statement-breakpoint
ALTER TABLE "api_token" DROP CONSTRAINT "api_token_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "package" DROP CONSTRAINT "package_creator_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "user_group_membership" DROP CONSTRAINT "user_group_membership_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "user_org_membership" DROP CONSTRAINT "user_org_membership_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "activity" DROP CONSTRAINT "activity_user_id_user_id_fk";--> statement-breakpoint
-- Change user.id from uuid to text
ALTER TABLE "user" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
-- Change referencing columns from uuid to text
ALTER TABLE "account" ALTER COLUMN "userId" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "userId" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "api_token" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "package" ALTER COLUMN "creator_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_group_membership" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_org_membership" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
-- Recreate FK constraints
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package" ADD CONSTRAINT "package_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_membership" ADD CONSTRAINT "user_group_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_membership" ADD CONSTRAINT "user_org_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
