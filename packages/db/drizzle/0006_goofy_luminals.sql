CREATE INDEX "idx_package_title_trgm" ON "package" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_package_notes_trgm" ON "package" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_package_name_trgm" ON "package" USING gin ("name" gin_trgm_ops);