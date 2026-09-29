CREATE TYPE "public"."job_priority" AS ENUM('high', 'normal', 'low');--> statement-breakpoint
DROP INDEX "idx_job_ready_run_at";--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "priority" "job_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_job_ready_priority_run_at" ON "job" USING btree ("priority","run_at","id") WHERE "job"."state" = 'ready';