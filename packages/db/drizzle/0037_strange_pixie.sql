DROP INDEX "idx_resource_version_pending_lake";--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "column_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_version" ADD COLUMN "lake_key_columns" jsonb;--> statement-breakpoint
ALTER TABLE "resource_version" ADD COLUMN "lake_ingest_reason" varchar(32);--> statement-breakpoint
CREATE INDEX "idx_resource_version_pending_lake" ON "resource_version" USING btree ("resource_id","version") WHERE "resource_version"."state" = 'active' AND "resource_version"."ducklake_snapshot_id" IS NULL
            AND "resource_version"."lake_ingest_reason" IS NULL;