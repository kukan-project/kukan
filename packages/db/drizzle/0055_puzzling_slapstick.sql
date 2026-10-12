ALTER TABLE "resource_pipeline" ADD COLUMN "lake_catalog_key" text;--> statement-breakpoint
ALTER TABLE "resource_version" ADD COLUMN "lake_snapshot_id" bigint;--> statement-breakpoint
CREATE INDEX "idx_resource_pipeline_lake_catalog_key" ON "resource_pipeline" USING btree ("lake_catalog_key");--> statement-breakpoint
CREATE INDEX "idx_resource_version_pending_lake_catalog" ON "resource_version" USING btree ("resource_id","version") WHERE "resource_version"."state" = 'active' AND "resource_version"."lake_snapshot_id" IS NULL
            AND "resource_version"."lake_ingest_reason" IS NULL;