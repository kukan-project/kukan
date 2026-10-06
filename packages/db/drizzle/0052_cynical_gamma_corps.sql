ALTER TABLE "resource_pipeline" ADD COLUMN "profile" jsonb;--> statement-breakpoint
CREATE INDEX "idx_resource_pipeline_profile_key" ON "resource_pipeline" USING btree (("profile" ->> 'key'));