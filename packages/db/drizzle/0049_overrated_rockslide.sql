ALTER TABLE "resource" ADD COLUMN "embedding_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_resource_embedding_due" ON "resource" USING btree ("embedding_due_at") WHERE "resource"."embedding_due_at" IS NOT NULL;--> statement-breakpoint
-- The per-package embed jobs still queued become marks on their resources (all of them for a queued embed-all)
UPDATE "resource" SET "embedding_due_at" = now()
WHERE "state" = 'active'
  AND (EXISTS (SELECT FROM "job" WHERE "job"."type" = 'embed-all-packages' AND "job"."state" = 'ready')
    OR "package_id" IN (SELECT ("payload" ->> 'packageId')::uuid FROM "job" WHERE "type" = 'embed-package' AND "state" = 'ready'));--> statement-breakpoint
DELETE FROM "job" WHERE "type" IN ('embed-package', 'embed-all-packages') AND "state" = 'ready';--> statement-breakpoint
ALTER TABLE "package" DROP COLUMN "embedding_queued_at";
