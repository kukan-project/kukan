ALTER TABLE "resource_version" ADD COLUMN "lake_ingest_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resource_version" ADD COLUMN "lake_ingest_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_version" ADD COLUMN "lake_ingest_failed_at" timestamp with time zone;