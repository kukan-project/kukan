ALTER TABLE "resource" ADD COLUMN "content_index_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_resource_content_index_due" ON "resource" USING btree ("content_index_due_at") WHERE "resource"."content_index_due_at" IS NOT NULL;--> statement-breakpoint
-- Resources whose last run failed to index get the mark, so the sweep tries them again
UPDATE "resource" SET "content_index_due_at" = now()
WHERE "id" IN (
  SELECT "p"."resource_id" FROM "resource_pipeline" "p"
  JOIN "resource_pipeline_step" "s" ON "s"."pipeline_id" = "p"."id"
  WHERE "s"."step_name" = 'index' AND "s"."status" = 'error'
);
