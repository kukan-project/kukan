ALTER TABLE "resource" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "summary_meta" jsonb DEFAULT '{}'::jsonb NOT NULL;