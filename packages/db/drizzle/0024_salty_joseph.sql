DROP INDEX "idx_orphaned_object_at";--> statement-breakpoint
--> Added in three steps rather than one: rows already parked have no expiry to
--> read, and a NOT NULL column with no default cannot be added to a table that
--> has any. They keep the retention they were parked under (ADR-045 §2).
ALTER TABLE "orphaned_object" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "orphaned_object" SET "expires_at" = "orphaned_at" + interval '1 hour' WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "orphaned_object" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_resource_pipeline_text_head" ON "resource_pipeline" USING btree (("metadata" ->> 'textHeadKey'));--> statement-breakpoint
CREATE INDEX "idx_orphaned_object_expires" ON "orphaned_object" USING btree ("expires_at");
