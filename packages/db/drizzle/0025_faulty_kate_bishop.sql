CREATE INDEX "idx_resource_storage_key" ON "resource" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_resource_pending_storage_key" ON "resource" USING btree ("pending_storage_key");--> statement-breakpoint
CREATE INDEX "idx_resource_pipeline_preview_key" ON "resource_pipeline" USING btree ("preview_key");--> statement-breakpoint
CREATE INDEX "idx_resource_version_storage_key" ON "resource_version" USING btree ("storage_key");